/*
 * Spotify Web Playback SDK integration (docs/SPOTIFY_INTEGRATION.md).
 *
 * Loaded as a module on every chrome page that shows the bottom player (home,
 * mood, loading, result, error). Each page is a fresh document, so the SDK
 * reinitialises on every navigation (docs/FRONTEND.md "Routing"); continuity
 * comes from Spotify's server-side session: on the way out the page stashes
 * whether music was playing (sessionStorage.playback_resume) and the next
 * page's SDK device transfers the session to itself, resuming mid-track.
 * src/main.py lifts Chromium's autoplay gate for this (a resumed page has no
 * user gesture yet); if the flag ever stops working the autoplay_failed
 * listener degrades to "press play to resume".
 *
 * No-ops entirely for Free accounts (chrome.js doesn't even render the player)
 * and on pages without the footer. The result page imports playTracks() for
 * its play-all / per-track buttons; everything else here drives the footer.
 */
import { callPy } from "./bridge.js";
import { formatDuration, isFreeUser, showToast } from "./playlists_ui.js";

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
const DEVICE_NAME = "EchoSoul";
const INITIAL_VOLUME = 0.7;
// How long playTracks() waits for the SDK device before giving up. Connect is
// normally sub-second; this only bites when the SDK script itself is slow.
const DEVICE_READY_TIMEOUT_MS = 12000;
// "playing" | "paused" — the outgoing page's last known state, consumed by the
// next page's ready handler to transfer (and maybe resume) the session.
const RESUME_KEY = "playback_resume";
// One forced re-login per session: an SDK authentication_error redirects to
// the auth gate, but if the problem persists we must not bounce forever.
const AUTH_REDIRECT_KEY = "playback_auth_redirected";

const els = {
  footer: document.getElementById("app-player"),
  cover: document.getElementById("player-cover"),
  coverFallback: document.getElementById("player-cover-fallback"),
  title: document.getElementById("player-title"),
  artist: document.getElementById("player-artist"),
  prev: document.getElementById("player-prev"),
  play: document.getElementById("player-play"),
  next: document.getElementById("player-next"),
  progress: document.getElementById("player-progress"),
  bars: Array.from(document.querySelectorAll("#player-progress [data-bar]")),
  time: document.getElementById("player-time"),
  shuffle: document.getElementById("player-shuffle"),
  volume: document.getElementById("player-volume"),
  mute: document.getElementById("player-mute"),
};

let player = null;
let deviceId = null;
let lastState = null; // last player_state_changed payload (null = no session)
let hadSession = false; // this page saw a real state at least once
let stashConsumed = false; // this page's ready handler ran (stash is ours now)
let tickTimer = null;
// Position advances locally between state events while playing.
let basePositionMs = 0;
let basePositionReadAt = 0;
let volumeBeforeMute = INITIAL_VOLUME;

let resolveDevice;
const deviceReady = new Promise((resolve) => (resolveDevice = resolve));

function playbackAvailable() {
  return Boolean(els.footer) && !isFreeUser();
}

// ---- Public API --------------------------------------------------------------

/**
 * Play an ad-hoc list of catalogue tracks on the in-app device, starting at
 * startIndex. Rejects with a user-presentable Error message on failure.
 */
export async function playTracks(trackIds, startIndex = 0) {
  if (!playbackAvailable()) {
    throw new Error("In-app playback isn't available on this account.");
  }
  const id = await Promise.race([
    deviceReady,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Spotify playback isn't ready yet — try again in a moment.")),
        DEVICE_READY_TIMEOUT_MS
      )
    ),
  ]);
  activateElement();
  const body = {
    uris: trackIds.map((trackId) => `spotify:track:${trackId}`),
    offset: { position: startIndex },
  };
  // A just-connected device can 404 until Spotify's backend registers it —
  // one short retry covers the race without hiding real failures.
  for (let attempt = 0; ; attempt++) {
    const resp = await apiFetch(`/me/player/play?device_id=${id}`, body);
    if (resp.ok || resp.status === 204) return;
    if (resp.status === 404 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 700));
      continue;
    }
    throw new Error(`Spotify couldn't start playback (HTTP ${resp.status}).`);
  }
}

// ---- Spotify Web API helpers ---------------------------------------------------

async function apiFetch(path, body) {
  const token = await callPy("get_spotify_access_token");
  return fetch(`https://api.spotify.com/v1${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Move the server-side playback session onto this page's device. play=true
// also resumes; play=false keeps it paused. 404 = nothing to transfer.
async function transferHere(play) {
  const resp = await apiFetch("/me/player", { device_ids: [deviceId], play });
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`transfer failed (HTTP ${resp.status})`);
  }
}

// ---- SDK lifecycle -------------------------------------------------------------

function initSdk() {
  // The SDK calls this global as soon as its script finishes loading.
  window.onSpotifyWebPlaybackSDKReady = () => {
    player = new Spotify.Player({
      name: DEVICE_NAME,
      getOAuthToken: (cb) => {
        callPy("get_spotify_access_token")
          .then(cb)
          .catch((err) => {
            // Expired/revoked session needs a re-login; anything else (e.g. a
            // network blip) just skips this token hand-off — the SDK retries.
            console.error("get_spotify_access_token failed:", err);
            if (err?.name === "SpotifySessionExpiredError") onSdkError("auth", err.message);
          });
      },
      volume: INITIAL_VOLUME,
    });

    player.addListener("initialization_error", ({ message }) => onSdkError("init", message));
    player.addListener("authentication_error", ({ message }) => onSdkError("auth", message));
    player.addListener("account_error", ({ message }) => onSdkError("account", message));
    player.addListener("playback_error", ({ message }) => onSdkError("playback", message));
    // Autoplay gate blocked an un-gestured resume (main.py's flag should
    // prevent this): the session transferred but audio needs a click.
    player.addListener("autoplay_failed", () => {
      showToast("Press play to resume your music.");
    });

    player.addListener("ready", ({ device_id }) => {
      deviceId = device_id;
      resolveDevice(device_id);
      consumeResumeStash();
    });
    player.addListener("not_ready", () => {
      // Device dropped (network hiccup). The SDK reconnects on its own and
      // re-fires "ready"; meanwhile show the idle state rather than a lie.
      renderState(null);
    });
    player.addListener("player_state_changed", (state) => renderState(state));

    player.connect().then((ok) => {
      if (!ok) setUnavailable("Spotify playback couldn't connect.");
    });
  };

  const script = document.createElement("script");
  script.src = SDK_URL;
  script.onerror = () =>
    setUnavailable("Spotify playback couldn't load — check your internet connection.");
  document.head.appendChild(script);
}

// Pick up where the previous page left off. Only this page's ready handler may
// clear the stash: an earlier page that never finished connecting (e.g. the
// short-lived loading page) must leave it for the page that can act on it.
function consumeResumeStash() {
  stashConsumed = true;
  const stash = sessionStorage.getItem(RESUME_KEY);
  if (!stash) return;
  transferHere(stash === "playing").catch((err) => {
    // The session is gone (played out, or taken over by another device) —
    // stop trying to resume it on every future page.
    console.info("No playback session to resume:", err.message);
    sessionStorage.removeItem(RESUME_KEY);
  });
}

function onPageHide() {
  if (lastState) {
    sessionStorage.setItem(RESUME_KEY, lastState.paused ? "paused" : "playing");
  } else if (stashConsumed && hadSession) {
    // The session existed on this page and ended here; nothing to resume.
    sessionStorage.removeItem(RESUME_KEY);
  }
  try {
    player?.disconnect();
  } catch (err) {
    console.error("player.disconnect failed:", err);
  }
}

function onSdkError(kind, message) {
  console.error(`Spotify SDK ${kind} error:`, message);
  if (kind === "auth") {
    // Bad/expired token or missing scope: force a re-login through the auth
    // gate — but only once per session, so a persistent failure can't bounce
    // the user between pages forever.
    if (!sessionStorage.getItem(AUTH_REDIRECT_KEY)) {
      sessionStorage.setItem(AUTH_REDIRECT_KEY, "1");
      window.location.replace("../index.html");
    } else {
      setUnavailable("Spotify session problem — try logging out and back in.");
    }
  } else if (kind === "account") {
    setUnavailable("Spotify says this account can't stream here (Premium required).");
  } else if (kind === "playback") {
    showToast("Spotify couldn't play this track.");
  } else {
    setUnavailable("Spotify playback couldn't start on this system.");
  }
}

// ---- Footer rendering ----------------------------------------------------------

function setTransportEnabled(enabled) {
  for (const btn of [els.prev, els.play, els.next, els.shuffle]) {
    if (btn) btn.disabled = !enabled;
  }
}

function setUnavailable(message) {
  stopTick();
  lastState = null;
  setTransportEnabled(false);
  if (els.title) els.title.textContent = "Playback unavailable";
  if (els.artist) {
    els.artist.textContent = message;
    els.artist.title = message;
  }
}

function renderState(state) {
  lastState = state;
  basePositionMs = state ? state.position : 0;
  basePositionReadAt = Date.now();

  if (!state) {
    stopTick();
    setTransportEnabled(false);
    if (els.title) els.title.textContent = "Nothing playing";
    if (els.artist) els.artist.textContent = "Play a playlist to get started";
    if (els.cover) els.cover.classList.add("hidden");
    if (els.coverFallback) els.coverFallback.classList.remove("hidden");
    setPlayIcon(false);
    renderProgress(0, 0);
    return;
  }

  hadSession = true;
  setTransportEnabled(true);

  const track = state.track_window?.current_track;
  if (track) {
    els.title.textContent = track.name;
    els.title.title = track.name;
    const artists = (track.artists || []).map((a) => a.name).join(", ");
    els.artist.textContent = artists;
    els.artist.title = artists;
    // Smallest album image is plenty for the 56px tile.
    const images = track.album?.images || [];
    const image = images[images.length - 1];
    if (image && els.cover) {
      els.cover.src = image.url;
      els.cover.classList.remove("hidden");
      els.coverFallback.classList.add("hidden");
    } else if (els.cover) {
      els.cover.classList.add("hidden");
      els.coverFallback.classList.remove("hidden");
    }
  }

  setPlayIcon(!state.paused);
  if (els.shuffle) {
    els.shuffle.classList.toggle("text-primary", Boolean(state.shuffle));
    els.shuffle.classList.toggle("text-on-surface-variant", !state.shuffle);
  }
  renderProgress(state.position, state.duration);
  if (state.paused) {
    stopTick();
  } else {
    startTick();
  }
}

function setPlayIcon(playing) {
  const icon = els.play?.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = playing ? "pause" : "play_arrow";
}

function renderProgress(positionMs, durationMs) {
  if (els.time) {
    els.time.textContent = `${formatDuration(positionMs)} / ${formatDuration(durationMs)}`;
  }
  const lit = durationMs > 0 ? Math.round((positionMs / durationMs) * els.bars.length) : 0;
  els.bars.forEach((bar, i) => {
    bar.classList.toggle("bg-primary", i < lit);
    bar.classList.toggle("bg-white/20", i >= lit);
  });
}

// The SDK only pushes state on changes; advance the position locally while
// music plays so the bar and clock move.
function currentPositionMs() {
  if (!lastState) return 0;
  if (lastState.paused) return basePositionMs;
  return Math.min(basePositionMs + (Date.now() - basePositionReadAt), lastState.duration);
}

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (lastState) renderProgress(currentPositionMs(), lastState.duration);
  }, 500);
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ---- Controls ------------------------------------------------------------------

// Spotify's workaround for browser autoplay gating: call on a real user
// gesture so the SDK's internal audio element gets activated.
function activateElement() {
  try {
    player?.activateElement?.();
  } catch (err) {
    console.error("activateElement failed:", err);
  }
}

function wireControls() {
  els.play?.addEventListener("click", () => {
    if (!player || !lastState) return;
    activateElement();
    player.togglePlay().catch((err) => console.error("togglePlay failed:", err));
  });
  els.prev?.addEventListener("click", () => {
    if (!player || !lastState) return;
    player.previousTrack().catch((err) => console.error("previousTrack failed:", err));
  });
  els.next?.addEventListener("click", () => {
    if (!player || !lastState) return;
    player.nextTrack().catch((err) => console.error("nextTrack failed:", err));
  });

  els.progress?.addEventListener("click", (e) => {
    if (!player || !lastState || !lastState.duration) return;
    const rect = els.progress.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const target = Math.round(fraction * lastState.duration);
    player.seek(target).catch((err) => console.error("seek failed:", err));
    // Optimistic update; the next player_state_changed corrects any drift.
    basePositionMs = target;
    basePositionReadAt = Date.now();
    renderProgress(target, lastState.duration);
  });

  // Shuffle has no SDK method — it's a Web API call against our device; the
  // resulting player_state_changed confirms the icon state.
  els.shuffle?.addEventListener("click", async () => {
    if (!deviceId || !lastState) return;
    const target = !lastState.shuffle;
    try {
      const resp = await apiFetch(`/me/player/shuffle?state=${target}&device_id=${deviceId}`);
      if (!resp.ok && resp.status !== 204) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      console.error("shuffle toggle failed:", err);
      showToast("Couldn't toggle shuffle.");
    }
  });

  els.volume?.addEventListener("input", () => {
    const value = Number(els.volume.value) / 100;
    if (value > 0) volumeBeforeMute = value;
    setVolume(value);
  });
  els.mute?.addEventListener("click", () => {
    const muted = Number(els.volume?.value ?? INITIAL_VOLUME * 100) === 0;
    const value = muted ? volumeBeforeMute : 0;
    if (els.volume) els.volume.value = String(Math.round(value * 100));
    setVolume(value);
  });
}

function setVolume(value) {
  player?.setVolume(value).catch((err) => console.error("setVolume failed:", err));
  const icon = els.mute?.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = value === 0 ? "volume_off" : value < 0.5 ? "volume_down" : "volume_up";
}

// ---- Boot ----------------------------------------------------------------------

if (playbackAvailable()) {
  wireControls();
  window.addEventListener("pagehide", onPageHide);
  initSdk();
}
