/*
 * Home page interactions (docs/FRONTEND.md).
 *
 * Hero + manual-mood controls are static navigation (the sidebar "Scan
 * Emotion" button is wired by chrome.js). The "Your latest playlist" showcase
 * is live: it shows the newest saved playlist from the Python bridge
 * (list_user_playlists -> load_playlist) with a short tracklist preview, and
 * stays hidden while nothing has been saved yet.
 */
import { callPy } from "./bridge.js";
import { describeGenreFilter, getGenreFilter, openGenrePicker } from "./genre_filter.js";
import { playTracks } from "./playback.js";
import {
  DEFAULT_ACCENT,
  EMOTION_THEMES,
  dbTrack,
  formatPlaylistMeta,
  isFreeUser,
  showToast,
  trackRow,
} from "./playlists_ui.js";

const SHOWCASE_TRACK_LIMIT = 5;

const hero = document.getElementById("camera-hero-section");
const cameraImg = document.getElementById("local-camera-img");
const caption = document.getElementById("hero-caption");

if (hero && cameraImg) {
  hero.addEventListener("click", () => {
    // Zoom the camera toward the viewer, then advance to the capture screen.
    if (caption) caption.style.opacity = "0";
    cameraImg.style.transform = "translateY(-10%) scale(6)";
    cameraImg.style.opacity = "0";
    setTimeout(() => window.location.assign("photo.html"), 650);
  });
}

// "Your Mood" opens the full manual-selection page.
document.getElementById("manual-mood-btn")?.addEventListener("click", () => {
  window.location.assign("mood.html");
});

// The quick emotion chips are a shortcut: each one is already a specific
// emotion, so skip the mood page and go straight through loading -> result.
// Manual picks skip inference, so drop any capture left over from an
// abandoned photo run rather than keep a multi-MB PNG in sessionStorage.
let moodPicked = false;
document.querySelectorAll(".mood-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (moodPicked) return; // already navigating; a second chip must not win
    moodPicked = true;
    sessionStorage.setItem("last_emotion", chip.dataset.emotion);
    sessionStorage.setItem("emotion_source", "manual");
    sessionStorage.removeItem("captured_image_b64");
    window.location.assign("loading.html");
  });
});

// ---- Genre preference chip --------------------------------------------------

// The chip both opens the picker and displays the active selection, so a
// filter set earlier in the session is always visible before the next scan.
const genreChip = document.getElementById("genre-filter-chip");
const genreChipLabel = document.getElementById("genre-filter-chip-label");

function refreshGenreChip() {
  if (!genreChip) return;
  const filter = getGenreFilter();
  genreChipLabel.textContent = `Playlist genres: ${describeGenreFilter(filter)}`;
  // A live filter tints the chip so the non-default state can't be missed.
  genreChip.classList.toggle("border-primary", Boolean(filter));
  genreChip.classList.toggle("text-on-surface", Boolean(filter));
}

genreChip?.addEventListener("click", () => openGenrePicker(refreshGenreChip));
refreshGenreChip();

// ---- "Your latest playlist" showcase ---------------------------------------

function startShowcasePlayback(trackIds, startIndex) {
  playTracks(trackIds, startIndex).catch((err) => {
    console.error("playTracks failed:", err);
    showToast(err.message || "Spotify couldn't start playback.");
  });
}

function renderShowcase(section, playlist) {
  const free = isFreeUser();
  const theme = EMOTION_THEMES[(playlist.source_emotion || "").toLowerCase()];
  const accent = theme ? theme.accent : DEFAULT_ACCENT;

  if (theme) {
    const cover = document.getElementById("recent-cover");
    cover.onerror = () => {
      // Cover art missing: fall back to the emotion emoji over the gradient.
      cover.onerror = null;
      cover.className = "w-32 h-32 object-contain";
      cover.src = theme.emoji;
    };
    cover.src = theme.cover;
    cover.classList.remove("hidden");
    document.getElementById("recent-cover-fallback").classList.add("hidden");
  }

  document.getElementById("recent-title").textContent = playlist.name;
  const totalMs = playlist.tracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
  document.getElementById("recent-meta").textContent = formatPlaylistMeta(
    playlist.tracks.length,
    totalMs
  );

  // Premium: clicking a preview row plays the whole playlist starting at that
  // track (the footer's prev/next then walk the full list). Free rows open in
  // Spotify — trackRow handles that when no onPlay is supplied.
  const trackIds = playlist.tracks.map((t) => t.track_id);
  const list = document.getElementById("recent-tracklist");
  list.innerHTML = "";
  playlist.tracks
    .slice(0, SHOWCASE_TRACK_LIMIT)
    .forEach((t, i) =>
      list.appendChild(
        trackRow(
          i + 1,
          dbTrack(t),
          accent,
          free,
          free ? undefined : () => startShowcasePlayback(trackIds, i)
        )
      )
    );

  function openPlaylist() {
    window.location.assign(`result.html#playlist=${playlist.playlist_id}`);
  }

  // Cover hover button: themed to the emotion accent (dark-navy glyph reads
  // on every accent). Premium: clicking the cover plays the whole playlist
  // in-app. Free: no in-app playback, so it opens the full playlist view.
  const coverTile = document.getElementById("recent-cover-tile");
  const coverBtn = document.getElementById("recent-cover-btn");
  coverBtn.style.backgroundColor = accent;
  coverBtn.style.color = "#0b1326";
  if (free) {
    coverTile.title = "Open playlist";
    coverTile.addEventListener("click", openPlaylist);
  } else {
    const glyph = coverBtn.querySelector(".material-symbols-outlined");
    glyph.textContent = "play_arrow";
    glyph.classList.add("filled", "ml-1");
    coverTile.title = "Play";
    coverTile.addEventListener("click", () => {
      playTracks(playlist.tracks.map((t) => t.track_id), 0).catch((err) => {
        console.error("playTracks failed:", err);
        showToast(err.message || "Spotify couldn't start playback.");
      });
    });
  }

  if (playlist.tracks.length > SHOWCASE_TRACK_LIMIT) {
    const more = document.createElement("button");
    more.className =
      "mx-2 mt-2 px-4 py-3 rounded-lg text-label-md font-label-md text-primary " +
      "hover:bg-white/5 transition-colors text-left flex items-center gap-2";
    more.innerHTML = `<span class="material-symbols-outlined text-[18px]">arrow_forward</span>View all ${playlist.tracks.length} songs`;
    more.addEventListener("click", openPlaylist);
    list.appendChild(more);
  }
  section.querySelectorAll("[data-open-playlist]").forEach((el) => {
    el.addEventListener("click", openPlaylist);
  });

  section.classList.remove("hidden");
}

(async function loadShowcase() {
  const section = document.getElementById("recent-playlist-section");
  if (!section) return;
  try {
    const playlists = await callPy("list_user_playlists");
    if (!playlists.length) return; // nothing saved yet: section stays hidden
    const playlist = await callPy("load_playlist", playlists[0].playlist_id);
    if (playlist) renderShowcase(section, playlist);
  } catch (err) {
    // Purely a nice-to-have on the home screen — fail quiet, keep it hidden.
    console.error("Latest-playlist showcase failed:", err);
  }
})();
