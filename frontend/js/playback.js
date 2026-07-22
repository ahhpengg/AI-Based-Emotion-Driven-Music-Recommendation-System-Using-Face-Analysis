/*
 * Spotify Web Playback SDK integration (docs/SPOTIFY_INTEGRATION.md).
 *
 * Loaded as a module on every chrome page that shows the bottom player (home,
 * mood, loading, result, error). Each page is a fresh document, so the SDK
 * reinitialises on every navigation (docs/FRONTEND.md "Routing"); continuity
 * comes from Spotify's server-side session: on the way out the page stashes
 * whether music was playing (sessionStorage.playback_resume) and the position
 * (sessionStorage.playback_position), and the next page's SDK device transfers
 * the session to itself and seeks back to that position — Spotify's transfer
 * otherwise resumes a few seconds behind, rewinding the track.
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
// The outgoing page's playback position (ms), stashed alongside RESUME_KEY so
// the next page can seek back to it after the transfer — Spotify's server-
// synced position lags a few seconds, which otherwise rewinds the track.
const POSITION_KEY = "playback_position";
// The current playback origin: {type:"playlist"|"single", trackIds:[...]}.
// Drives the prev/next button behaviour and survives page navigation.
const CONTEXT_KEY = "playback_context";
// Past this point into the current song, Previous restarts it; before it,
// Previous steps to the earlier track (standard media-player behaviour).
const PREV_STEP_MS = 2000;

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
let lastStateAt = 0; // Date.now() when lastState was captured (position clock)

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
export async function playTracks(trackIds, startIndex = 0, context = "playlist") {
  if (!playbackAvailable()) {
    throw new Error("In-app playback isn't available on this account.");
  }
  // Remember what is playing so the footer's prev/next can tell a playlist
  // (walks tracks, loops at the end) from a standalone track (prev restarts,
  // next ends it). Persisted so it survives page navigation.
  setPlaybackContext(context === "single" ? "single" : "playlist", trackIds);
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
async function consumeResumeStash() {
  stashConsumed = true;
  const stash = sessionStorage.getItem(RESUME_KEY);
  if (!stash) return;
  const posRaw = sessionStorage.getItem(POSITION_KEY);
  const resumePos = posRaw === null ? null : Number(posRaw);
  try {
    await transferHere(stash === "playing");
    // Spotify resumes a transfer from its last server-synced position, which
    // lags a few seconds behind and rewinds the track (seen live). Seek back
    // to exactly where the previous page left off once the media has loaded.
    if (stash === "playing" && Number.isFinite(resumePos) && resumePos > PREV_STEP_MS) {
      await seekAfterTransfer(resumePos);
    }
  } catch (err) {
    // The session is gone (played out, or taken over by another device) —
    // stop trying to resume it on every future page.
    console.info("No playback session to resume:", err.message);
    sessionStorage.removeItem(RESUME_KEY);
  } finally {
    sessionStorage.removeItem(POSITION_KEY);
  }
}

// A freshly transferred device holds the session's metadata before it finishes
// loading the audio; seeking too early silently no-ops (seen live). Wait for a
// live, playing state, then seek once to the stashed position.
async function seekAfterTransfer(positionMs) {
  for (let i = 0; i < 10; i++) {
    const st = await player?.getCurrentState().catch(() => null);
    if (st && !st.paused && st.duration) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  // Swallow seek failures here: the transfer already succeeded, so a hiccup
  // seeking must not make the caller drop the resume stash.
  try {
    const resp = await apiFetch(
      `/me/player/seek?position_ms=${Math.round(positionMs)}&device_id=${deviceId}`
    );
    if (!resp.ok && resp.status !== 204) console.info("resume seek failed:", resp.status);
  } catch (err) {
    console.info("resume seek error:", err.message);
  }
}

function onPageHide() {
  if (lastState) {
    sessionStorage.setItem(RESUME_KEY, lastState.paused ? "paused" : "playing");
    sessionStorage.setItem(POSITION_KEY, String(Math.round(currentPositionMs())));
  } else if (stashConsumed && hadSession) {
    // The session existed on this page and ended here; nothing to resume.
    sessionStorage.removeItem(RESUME_KEY);
    sessionStorage.removeItem(POSITION_KEY);
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
  if (state) lastStateAt = Date.now();

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

// Current playback position, extrapolated from the last SDK state so it stays
// accurate between the 1s polls (used by the resume stash and by Previous's
// restart-vs-step-back decision).
function currentPositionMs() {
  if (!lastState) return 0;
  const base = lastState.position || 0;
  if (lastState.paused) return base;
  const advanced = base + (Date.now() - lastStateAt);
  return lastState.duration ? Math.min(advanced, lastState.duration) : advanced;
}

// Seek to an absolute position, clamped to the track, with an optimistic UI
// update (the next state push / poll corrects any drift).
function seek(positionMs) {
  if (!deviceId || !lastState) return;
  const pos = Math.round(Math.min(Math.max(positionMs, 0), lastState.duration || positionMs));
  apiFetch(`/me/player/seek?position_ms=${pos}&device_id=${deviceId}`).catch((err) =>
    console.error("seek failed:", err)
  );
  lastState.position = pos;
  lastStateAt = Date.now();
  renderProgress(pos, lastState.duration || 0);
}

// Playback origin (see CONTEXT_KEY). setPlaybackContext is called from
// playTracks; getPlaybackContext falls back to an empty playlist context so a
// missing/legacy stash still drives sensible prev/next behaviour.
function setPlaybackContext(type, trackIds) {
  try {
    sessionStorage.setItem(CONTEXT_KEY, JSON.stringify({ type, trackIds: trackIds || [] }));
  } catch {
    /* storage unavailable: prev/next fall back to the default context */
  }
}

function getPlaybackContext() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CONTEXT_KEY) || "null");
    if (c && (c.type === "single" || c.type === "playlist") && Array.isArray(c.trackIds)) {
      return c;
    }
  } catch {
    /* malformed stash: use the default */
  }
  return { type: "playlist", trackIds: [] };
}

// Map a click on the waveform strip to a 0..1 position using the bars' actual
// extent (the strip can be wider than the bars), so the seek lands exactly
// under the cursor rather than a bit to its left.
function seekFractionFromEvent(e) {
  const bars = els.bars;
  if (bars.length) {
    const left = bars[0].getBoundingClientRect().left;
    const right = bars[bars.length - 1].getBoundingClientRect().right;
    if (right > left) return Math.min(Math.max((e.clientX - left) / (right - left), 0), 1);
  }
  const rect = els.progress.getBoundingClientRect();
  return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
}

// Standalone-track "next": nothing follows it, so stop and reset to the start.
function endCurrentTrack() {
  player?.pause().catch((err) => console.error("pause failed:", err));
  seek(0);
  if (lastState) lastState.paused = true;
  setPlayIcon(false);
  stopTick();
}

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
      lastStateAt = Date.now(); // restart the position clock from here
      startTick();
    }
  });
  // Previous: a standalone track always restarts; within a playlist, past the
  // 2s mark restart the current song, otherwise step back to the previous one
  // (so a first press restarts and a second within 0:02 goes back a track).
  els.prev?.addEventListener("click", () => {
    if (!deviceId || !lastState) return;
    const ctx = getPlaybackContext();
    const hasPrev = (lastState.track_window?.previous_tracks?.length || 0) > 0;
    if (ctx.type === "single" || currentPositionMs() > PREV_STEP_MS || !hasPrev) {
      seek(0);
      return;
    }
    activateElement();
    apiFetch(`/me/player/previous?device_id=${deviceId}`, undefined, "POST").catch((err) =>
      console.error("previous failed:", err)
    );
  });
  // Next: a standalone track ends here; within a playlist, advance — and when
  // it was the last song, start a fresh round of the whole playlist rather
  // than wrapping to the first track and stopping.
  els.next?.addEventListener("click", () => {
    if (!deviceId || !lastState) return;
    const ctx = getPlaybackContext();
    if (ctx.type === "single") {
      endCurrentTrack();
      return;
    }
    if ((lastState.track_window?.next_tracks?.length || 0) > 0) {
      activateElement();
      apiFetch(`/me/player/next?device_id=${deviceId}`, undefined, "POST").catch((err) =>
        console.error("next failed:", err)
      );
      return;
    }
    if (ctx.trackIds.length) {
      playTracks(ctx.trackIds, 0, "playlist").catch((err) => {
        console.error("restart playlist failed:", err);
        showToast(err.message || "Spotify couldn't restart the playlist.");
      });
    }
  });

  els.progress?.addEventListener("click", (e) => {
    if (!deviceId || !lastState || !lastState.duration) return;
    seek(seekFractionFromEvent(e) * lastState.duration);
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
