/*
 * Result page — two modes (docs/FRONTEND.md):
 *
 * 1. Saved playlist (result.html#playlist=<id>): loads the playlist from the
 *    Python bridge (load_playlist) and renders its real tracks. The mood
 *    banner is dropped — a saved playlist isn't a fresh detection. This is
 *    where sidebar / home-showcase clicks land.
 * 2. Detection flow (no hash): themed placeholder content per
 *    sessionStorage.last_emotion (set by mood.js / loading.js), mirroring the
 *    Stitch prototypes. Replaced by the real generate_playlist wiring in F6.
 *
 * Free (non-Premium) accounts can't use the in-app Web Playback SDK, so this
 * page degrades gracefully for them: the play-whole-playlist controls are
 * removed and each track opens in Spotify (external browser / desktop app) via
 * open_external_url instead of playing in-app. Tier comes from the profile the
 * auth gate / premium page stashed in sessionStorage.spotify_profile.
 */
import { callPy } from "./bridge.js";
import {
  DEFAULT_ACCENT,
  EMOTION_THEMES,
  dbTrack,
  formatPlaylistMeta,
  hexToRgba,
  isFreeUser,
  trackRow,
} from "./playlists_ui.js";

// Page copy per emotion; accent/emoji/cover come from EMOTION_THEMES. The
// placeholder tracks disappear with the F6 generate_playlist wiring.
const EMOTIONS = {
  happy: {
    heading: "You seem Happy!",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Happy Playlist",
    meta: "Curated for your joyful moments • 24 songs, 1 hr 15 min",
    tracks: [
      ["Happy", "Pharrell Williams", "Despicable Me 2", "3:53"],
      ["Walking On Sunshine", "Katrina & The Waves", "Walking on Sunshine", "3:58"],
      ["Can't Stop the Feeling!", "Justin Timberlake", "Trolls", "3:56"],
    ],
  },
  surprised: {
    heading: "You seem Surprised!",
    subtitle: "Unexpected drops, sudden tempo changes, and tracks that'll catch you off guard.",
    title: "Surprise Mix",
    meta: "Curated for your wide-eyed state of mind • 24 songs, 1 hr 15 min",
    tracks: [
      ["Surprised", "Pharrell Williams", "Surprise Edition", "3:53"],
      ["Midnight City", "M83", "Hurry Up, We're Dreaming", "4:03"],
      ["Genesis", "Justice", "† (Cross)", "3:54"],
    ],
  },
  sad: {
    heading: "You seem Sad.",
    subtitle: "Embrace the melancholy. We've curated a collection of deeply emotional and reflective tracks to accompany your quiet moments.",
    title: "Sad Melodies",
    meta: "Deeply emotional and reflective tracks • 18 songs, 1 hr 02 min",
    tracks: [
      ["Someone Like You", "Adele", "21", "4:45"],
      ["Fix You", "Coldplay", "X&Y", "4:55"],
      ["Yesterday", "The Beatles", "Help!", "2:05"],
      ["The Night We Met", "Lord Huron", "Strange Trails", "3:28"],
    ],
  },
  neutral: {
    heading: "You seem Neutral.",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Neutral Playlist",
    meta: "A balanced, calm equilibrium to maintain your steady rhythm • 24 songs, 1 hr 15 min",
    tracks: [
      ["Weightless", "Marconi Union", "Weightless", "8:00"],
      ["Gymnopédie No. 1", "Erik Satie", "3 Gymnopédies", "3:25"],
      ["An Ending (Ascent)", "Brian Eno", "Apollo", "4:26"],
    ],
  },
  angry: {
    heading: "You seem Angry!",
    subtitle: "We have customized a playlist to match this vibe.",
    title: "Angry Playlist",
    meta: "High-energy tracks for your intense moments • 24 songs, 1 hr 15 min",
    tracks: [
      ["Killing in the Name", "Rage Against the Machine", "Rage Against the Machine", "5:14"],
      ["Break Stuff", "Limp Bizkit", "Significant Other", "2:46"],
      ["Wait and Bleed", "Slipknot", "Slipknot", "2:27"],
    ],
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
  // A saved playlist isn't a fresh detection: no mood banner.
  document.getElementById("result-banner")?.remove();
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

  const list = document.getElementById("tracklist");
  list.innerHTML = "";
  playlist.tracks.forEach((t, i) => list.appendChild(trackRow(i + 1, dbTrack(t), accent, free)));

  document.title = `EchoSoul - ${playlist.name}`;
}

// ---- Mode 2: detection flow (placeholder until F6) ---------------------------

function renderDetectionResult() {
  const key = (sessionStorage.getItem("last_emotion") || "happy").toLowerCase();
  const emotion = EMOTIONS[key] ? key : "happy";
  const e = EMOTIONS[emotion];
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
  emoji.alt = e.heading;
  emoji.style.filter = `drop-shadow(0 0 18px ${hexToRgba(theme.accent, 0.45)})`;
  const heading = document.getElementById("result-heading");
  heading.textContent = e.heading;
  heading.style.color = theme.accent;
  document.getElementById("result-subtitle").textContent = e.subtitle;

  renderCover(theme.accent, theme);
  document.getElementById("playlist-title").textContent = e.title;
  document.getElementById("playlist-meta").textContent = e.meta;

  // Tracklist (placeholder tuples -> the shared row shape; no track_id yet, so
  // Free clicks fall back to a Spotify search link).
  const list = document.getElementById("tracklist");
  list.innerHTML = "";
  e.tracks.forEach(([title, artist, album, time], i) =>
    list.appendChild(trackRow(i + 1, { title, artist, album, time }, theme.accent, free))
  );

  document.title = `EchoSoul - ${e.title}`;
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
