/*
 * Result page — two modes (docs/FRONTEND.md):
 *
 * 1. Saved playlist (result.html#playlist=<id>): loads the playlist from the
 *    Python bridge (load_playlist) and renders its real tracks. The mood
 *    banner is dropped — a saved playlist isn't a fresh detection. This is
 *    where sidebar / home-showcase clicks land.
 * 2. Detection flow (no hash): the playlist generate_playlist produced,
 *    stashed by loading.js in sessionStorage.current_playlist (+
 *    playlist_emotion), rendered under the per-emotion mood banner. The
 *    bookmark button persists it via save_playlist (name = emotion + saved-at
 *    stamp) and refreshes the sidebar. Opened with no flow behind it, the
 *    page heads home — there is nothing real to show.
 *
 * Free (non-Premium) accounts can't use the in-app Web Playback SDK, so this
 * page degrades gracefully for them: the play-whole-playlist controls are
 * removed and each track opens in Spotify (external browser / desktop app) via
 * open_external_url instead of playing in-app. Tier comes from the profile the
 * auth gate / premium page stashed in sessionStorage.spotify_profile.
 */
import { callPy } from "./bridge.js";
import { playTracks } from "./playback.js";
import {
  DEFAULT_ACCENT,
  EMOTION_THEMES,
  dbTrack,
  formatPlaylistMeta,
  hexToRgba,
  isFreeUser,
  showToast,
  trackRow,
} from "./playlists_ui.js";
import { refreshSidebarPlaylists } from "./sidebar.js";

// Page copy per emotion; accent/emoji/cover come from EMOTION_THEMES. The
// metaLead gets the real "N songs, X min" appended at render time.
const EMOTIONS = {
  happy: {
    heading: "You seem Happy!",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Happy Playlist",
    metaLead: "Curated for your joyful moments",
  },
  surprised: {
    heading: "You seem Surprised!",
    subtitle: "Unexpected drops, sudden tempo changes, and tracks that'll catch you off guard.",
    title: "Surprise Mix",
    metaLead: "Curated for your wide-eyed state of mind",
  },
  sad: {
    heading: "You seem Sad.",
    subtitle: "Embrace the melancholy. We've curated a collection of deeply emotional and reflective tracks to accompany your quiet moments.",
    title: "Sad Melodies",
    metaLead: "Deeply emotional and reflective tracks",
  },
  neutral: {
    heading: "You seem Neutral.",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Neutral Playlist",
    metaLead: "A balanced, calm equilibrium to maintain your steady rhythm",
  },
  angry: {
    heading: "You seem Angry!",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Angry Playlist",
    metaLead: "High-energy tracks for your intense moments",
  },
};

// Free mode: no in-app playback, so drop the play-whole-playlist affordances
// (opening 24 external tabs makes no sense) and surface the "opens in Spotify"
// hint. Per-track opening is handled inside trackRow.
function applyFreeMode() {
  document.getElementById("cover-play-overlay")?.remove();
  document.getElementById("playlist-play-btn")?.remove();
  const hint = document.getElementById("free-playback-hint");
  if (hint) {
    hint.classList.remove("hidden");
    hint.classList.add("flex");
  }
}

// Cover tile: gradient backdrop + cover art, falling back to the emotion emoji
// (theme pages) or a plain music note (saved playlists without an emotion).
function renderCover(accent, theme) {
  document.getElementById("playlist-cover").style.backgroundImage =
    `linear-gradient(135deg, ${accent}, #222a3d)`;
  const coverIcon = document.getElementById("cover-icon");
  if (theme) {
    coverIcon.className = "w-full h-full object-cover";
    coverIcon.onerror = () => {
      coverIcon.onerror = null;
      coverIcon.className = "w-32 h-32 object-contain";
      coverIcon.src = theme.emoji;
    };
    coverIcon.src = theme.cover;
  } else {
    const icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-[96px] text-on-surface/70";
    icon.textContent = "music_note";
    coverIcon.replaceWith(icon);
  }
}

// ---- Mode 1: saved playlist (#playlist=<id>) --------------------------------

async function renderSavedPlaylist(playlistId) {
  // A saved playlist isn't a fresh detection: no mood banner, and the
  // save-bookmark affordance makes no sense (it's already saved).
  document.getElementById("result-banner")?.remove();
  document.getElementById("save-playlist-btn")?.remove();
  const free = isFreeUser();
  if (free) applyFreeMode();

  let playlist = null;
  try {
    playlist = await callPy("load_playlist", playlistId);
  } catch (err) {
    console.error("load_playlist failed:", err);
  }
  if (!playlist) {
    document.getElementById("playlist-title").textContent = "Playlist not found";
    document.getElementById("playlist-meta").textContent =
      "It may have been deleted. Pick another playlist from the sidebar.";
    document.getElementById("cover-play-overlay")?.remove();
    document.getElementById("playlist-play-btn")?.remove();
    document.title = "EchoSoul - Playlist not found";
    return;
  }

  const theme = EMOTION_THEMES[(playlist.source_emotion || "").toLowerCase()] || null;
  const accent = theme ? theme.accent : DEFAULT_ACCENT;
  renderCover(accent, theme);

  document.getElementById("playlist-title").textContent = playlist.name;
  const totalMs = playlist.tracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
  document.getElementById("playlist-meta").textContent = formatPlaylistMeta(
    playlist.tracks.length,
    totalMs
  );

  renderTracklist(playlist.tracks, accent, free);

  document.title = `EchoSoul - ${playlist.name}`;
}

// ---- Mode 2: detection flow (playlist stashed by loading.js) ----------------

function renderDetectionResult() {
  const emotion = (sessionStorage.getItem("playlist_emotion") || "").toLowerCase();
  const copy = EMOTIONS[emotion];
  let tracks = null;
  try {
    tracks = JSON.parse(sessionStorage.getItem("current_playlist") || "null");
  } catch {
    tracks = null;
  }
  if (!copy || !Array.isArray(tracks) || !tracks.length) {
    // No detection flow behind this visit (deep link / stale history):
    // nothing real to show, so head home.
    window.location.replace("home.html");
    return;
  }

  const theme = EMOTION_THEMES[emotion];
  const free = isFreeUser();
  if (free) applyFreeMode();

  // Banner
  const banner = document.getElementById("result-banner");
  banner.style.backgroundColor = hexToRgba(theme.accent, 0.12);
  document.getElementById("result-banner-overlay").style.background =
    `linear-gradient(to bottom, ${hexToRgba(theme.accent, 0.1)}, transparent)`;
  const emoji = document.getElementById("result-emoji");
  emoji.src = theme.emoji;
  emoji.alt = copy.heading;
  emoji.style.filter = `drop-shadow(0 0 18px ${hexToRgba(theme.accent, 0.45)})`;
  const heading = document.getElementById("result-heading");
  heading.textContent = copy.heading;
  heading.style.color = theme.accent;
  document.getElementById("result-subtitle").textContent = copy.subtitle;

  renderCover(theme.accent, theme);
  document.getElementById("playlist-title").textContent = copy.title;
  const totalMs = tracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
  document.getElementById("playlist-meta").textContent =
    `${copy.metaLead} • ${formatPlaylistMeta(tracks.length, totalMs)}`;

  renderTracklist(tracks, theme.accent, free);

  wireSaveButton(emotion, tracks, theme.accent);

  document.title = `EchoSoul - ${copy.title}`;
}

// ---- Tracklist + playback (shared by both views) -----------------------------

// Renders the rows and, for Premium accounts, wires the play affordances:
// play-all (the play_circle button + the cover hover overlay) starts the whole
// list in order; clicking a row starts the list at that track, so next/prev on
// the bottom player walk the playlist. playback.js owns the actual SDK device.
function renderTracklist(tracks, accent, free) {
  const trackIds = tracks.map((t) => t.track_id);
  const list = document.getElementById("tracklist");
  list.innerHTML = "";
  tracks.forEach((t, i) =>
    list.appendChild(
      trackRow(i + 1, dbTrack(t), accent, free, free ? undefined : () => startPlayback(trackIds, i))
    )
  );
  if (free) return; // applyFreeMode already removed the play-all affordances

  document
    .getElementById("playlist-play-btn")
    ?.addEventListener("click", () => startPlayback(trackIds, 0));
  document
    .getElementById("cover-play-overlay")
    ?.addEventListener("click", () => startPlayback(trackIds, 0));
}

function startPlayback(trackIds, startIndex) {
  playTracks(trackIds, startIndex).catch((err) => {
    console.error("playTracks failed:", err);
    showToast(err.message || "Spotify couldn't start playback.");
  });
}

// ---- Save (bookmark button, fresh-detection view only) ----------------------

// "happy" -> "Happy — Jul 12, 9:41 PM" (the sidebar list is flat, so the
// stamp keeps repeat saves of the same mood tellable apart).
function playlistSaveName(emotion) {
  const stamp = new Date().toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${emotion[0].toUpperCase()}${emotion.slice(1)} — ${stamp}`;
}

function wireSaveButton(emotion, tracks, accent) {
  const btn = document.getElementById("save-playlist-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await callPy(
        "save_playlist",
        playlistSaveName(emotion),
        emotion,
        tracks.map((t) => t.track_id)
      );
    } catch (err) {
      console.error("save_playlist failed:", err);
      showToast("Couldn't save the playlist — please try again.");
      btn.disabled = false;
      return;
    }
    // Saved: fill the bookmark and keep the button disabled — saving the same
    // playlist twice only clutters the sidebar. The new row appears live.
    btn.querySelector(".material-symbols-outlined")?.classList.add("filled");
    btn.style.color = accent;
    btn.title = "Saved";
    showToast("Playlist saved");
    refreshSidebarPlaylists();
  });
}

// Switching playlists from the sidebar while already on this page only changes
// the hash, which does not reload the document — force the re-render.
window.addEventListener("hashchange", () => window.location.reload());

window.addEventListener("load", () => {
  const saved = window.location.hash.match(/^#playlist=(\d+)$/);
  if (saved) {
    renderSavedPlaylist(Number(saved[1]));
    return;
  }
  renderDetectionResult();
});
