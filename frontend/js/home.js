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
import {
  DEFAULT_ACCENT,
  EMOTION_THEMES,
  dbTrack,
  formatPlaylistMeta,
  isFreeUser,
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
document.querySelectorAll(".mood-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    sessionStorage.setItem("last_emotion", chip.dataset.emotion);
    sessionStorage.setItem("emotion_source", "manual");
    window.location.assign("loading.html");
  });
});

// ---- "Your latest playlist" showcase ---------------------------------------

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

  const list = document.getElementById("recent-tracklist");
  list.innerHTML = "";
  playlist.tracks
    .slice(0, SHOWCASE_TRACK_LIMIT)
    .forEach((t, i) => list.appendChild(trackRow(i + 1, dbTrack(t), accent, free)));

  function openPlaylist() {
    window.location.assign(`result.html#playlist=${playlist.playlist_id}`);
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
