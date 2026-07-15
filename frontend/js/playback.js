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
 * its play-all / per-track buttons; everything else here drives the footer,
 * including the add button, which opens the shared add-to-playlists popup for
 * whatever is playing — even a song outside the EchoSoul catalogue (queued
 * from the user's own Spotify apps); those are stored as feature-less
 * catalogue rows so they replay from playlists like any other song.
 */
import { openAddPopup } from "./add_to_playlists.js";
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
// Volume fraction (0..1) — each page creates a fresh SDK player, so without
// this the volume would snap back to the default on every navigation.
const VOLUME_KEY = "playback_volume";
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
  shuffleDot: document.getElementById("player-shuffle-dot"),
  add: document.getElementById("player-add"),
  volume: document.getElementById("player-volume"),
  mute: document.getElementById("player-mute"),
};

let player = null;
let deviceId = null;
let lastState = null; // last known SDK state (null = no session)
let hadSession = false; // this page saw a real state at least once
let stashConsumed = false; // this page's ready handler ran (stash is ours now)
let tickTimer = null;

let resolveDevice;
const deviceReady = new Promise((resolve) => (resolveDevice = resolve));

function loadVolume() {
  const raw = sessionStorage.getItem(VOLUME_KEY);
  if (raw === null) return INITIAL_VOLUME;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : INITIAL_VOLUME;
}
const initialVolume = loadVolume();
let volumeBeforeMute = initialVolume > 0 ? initialVolume : INITIAL_VOLUME;

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

async function apiFetch(path, body, method = "PUT") {
  const token = await callPy("get_spotify_access_token");
  return fetch(`https://api.spotify.com/v1${path}`, {
    method,
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
      volume: initialVolume,
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
  for (const btn of [els.prev, els.play, els.next, els.shuffle, els.add]) {
    if (btn) btn.disabled = !enabled;
  }
}

function setShuffleIndicator(on) {
  if (els.shuffle) {
    els.shuffle.classList.toggle("text-primary", on);
    els.shuffle.classList.toggle("text-on-surface-variant", !on);
  }
  // The colour change alone is easy to miss — the dot is the real signal.
  if (els.shuffleDot) els.shuffleDot.classList.toggle("hidden", !on);
}

function setUnavailable(message) {
  stopTick();
  lastState = null;
  setTransportEnabled(false);
  setShuffleIndicator(false);
  if (els.title) els.title.textContent = "Playback unavailable";
  if (els.artist) {
    els.artist.textContent = message;
    els.artist.title = message;
  }
}

function renderState(state) {
  lastState = state;

  if (!state) {
    stopTick();
    setTransportEnabled(false);
    setShuffleIndicator(false);
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

  // Adding needs an actual track (an episode or ad has nothing to store).
  if (els.add) els.add.disabled = !currentAddableTrack();

  setPlayIcon(!state.paused);
  setShuffleIndicator(Boolean(state.shuffle));
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

// The SDK only pushes state on changes, so while music plays, poll its real
// state once a second. Polling (rather than extrapolating the position
// locally) keeps the clock honest — a stalled or hijacked session shows its
// true frozen position instead of a fantasy countdown (seen live: the local
// tick once ran a dead session's clock all the way to the end of the track).
function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    player?.getCurrentState().then((state) => {
      // renderState stops this timer when the state says paused/gone.
      if (tickTimer) renderState(state);
    });
  }, 1000);
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

// ---- Controls ------------------------------------------------------------------

// The playing item as an add-to-playlists row, or null when there is nothing
// addable (no session, or the item is an episode/ad rather than a track).
// Spotify sometimes relinks a track to a market-specific copy; linked_from
// then carries the id the queue was actually started with — the one our
// catalogue and playlists know — so prefer it over the relinked id. Artists
// are ;-joined to match the merged catalogue's format.
function currentAddableTrack() {
  const track = lastState?.track_window?.current_track;
  if (!track || (track.type && track.type !== "track")) return null;
  const id = track.linked_from?.id || track.id;
  if (!id || !track.name) return null;
  return {
    track_id: id,
    track_name: track.name,
    artists: (track.artists || []).map((a) => a.name).join(";"),
    album_name: track.album?.name ?? null,
    duration_ms: lastState.duration || null,
  };
}

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
  // Transport goes through the Web API, not the SDK's local methods: after a
  // paused cross-page transfer the device holds the session's metadata but no
  // loaded media, and the SDK's togglePlay/nextTrack/seek silently no-op
  // (seen live). The API commands make the device load the media first.
  // Pausing stays local — media is always loaded while actually playing.
  els.play?.addEventListener("click", () => {
    if (!player || !lastState || !deviceId) return;
    activateElement();
    if (lastState.paused) {
      apiFetch(`/me/player/play?device_id=${deviceId}`).catch((err) =>
        console.error("resume failed:", err)
      );
    } else {
      player.pause().catch((err) => console.error("pause failed:", err));
    }
    // Optimistic flip: the SDK's paused state push can lose a race against a
    // quick navigation, and pagehide would then stash "playing" for a track
    // the user just paused (seen live). The next state push corrects drift.
    lastState.paused = !lastState.paused;
    setPlayIcon(!lastState.paused);
    if (lastState.paused) {
      stopTick();
    } else {
      startTick();
    }
  });
  els.prev?.addEventListener("click", () => {
    if (!deviceId || !lastState) return;
    apiFetch(`/me/player/previous?device_id=${deviceId}`, undefined, "POST").catch((err) =>
      console.error("previous failed:", err)
    );
  });
  els.next?.addEventListener("click", () => {
    if (!deviceId || !lastState) return;
    apiFetch(`/me/player/next?device_id=${deviceId}`, undefined, "POST").catch((err) =>
      console.error("next failed:", err)
    );
  });

  els.progress?.addEventListener("click", (e) => {
    if (!deviceId || !lastState || !lastState.duration) return;
    const rect = els.progress.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const target = Math.round(fraction * lastState.duration);
    apiFetch(`/me/player/seek?position_ms=${target}&device_id=${deviceId}`).catch((err) =>
      console.error("seek failed:", err)
    );
    // Optimistic update; the next state push / poll corrects any drift.
    renderProgress(target, lastState.duration);
  });

  // Same popup as the header search rows. ensureInCatalogue: the player can
  // be playing a song that isn't in the EchoSoul catalogue (queued from the
  // user's own Spotify apps) — the backend stores those on confirm.
  els.add?.addEventListener("click", () => {
    const track = currentAddableTrack();
    if (!track) return;
    openAddPopup(track, { ensureInCatalogue: true });
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
  sessionStorage.setItem(VOLUME_KEY, String(value));
  const icon = els.mute?.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = value === 0 ? "volume_off" : value < 0.5 ? "volume_down" : "volume_up";
}

// ---- Boot ----------------------------------------------------------------------

if (playbackAvailable()) {
  wireControls();
  if (els.volume) els.volume.value = String(Math.round(initialVolume * 100));
  setVolume(initialVolume); // sets the mute icon; the SDK player isn't up yet
  window.addEventListener("pagehide", onPageHide);
  initSdk();
}
