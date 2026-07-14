/*
 * Shared playlist rendering helpers (docs/FRONTEND.md).
 *
 * Used by the home showcase (home.js), the result page (result.js) and the
 * sidebar (sidebar.js) so the tracklist rows, emotion theming and duration
 * formatting stay identical everywhere. DB track rows come across the bridge
 * from load_playlist / generate_playlist as:
 *   { track_id, track_name, artists, album_name, duration_ms, ... }
 * — convert them with dbTrack() before handing them to trackRow().
 */
import { callPy } from "./bridge.js";

// Per-emotion accent colour + artwork (paths relative to frontend/pages/).
// The result page layers its own copy (headings, subtitles) on top of these.
export const EMOTION_THEMES = {
  happy: {
    accent: "#6ffbbe",
    emoji: "../assets/img/emoji-happy.png",
    cover: "../assets/img/cover-happy.png",
  },
  surprised: {
    accent: "#4edea3",
    emoji: "../assets/img/emoji-surprised.png",
    cover: "../assets/img/cover-surprised.png",
  },
  sad: {
    accent: "#82b1ff",
    emoji: "../assets/img/emoji-sad.png",
    cover: "../assets/img/cover-sad.png",
  },
  neutral: {
    accent: "#facc15",
    emoji: "../assets/img/emoji-neutral.png",
    cover: "../assets/img/cover-neutral.png",
  },
  angry: {
    accent: "#ff6b6b",
    emoji: "../assets/img/emoji-angry.png",
    cover: "../assets/img/cover-angry.png",
  },
};

// Fallback accent for playlists without a source emotion (theme primary).
export const DEFAULT_ACCENT = "#ddb7ff";

// Default playlist title per emotion — the result page's playlist title (and
// default save name) and the create-playlist modal's prefilled title, kept in
// one place so the two flows never drift apart.
export const EMOTION_DEFAULT_TITLES = {
  happy: "Happy Songs",
  surprised: "Surprise Mix",
  sad: "Sad Melodies",
  neutral: "Neutral Collection",
  angry: "Angry Vibes",
};

// True when the signed-in Spotify account is Free. Absent profile (a page
// opened directly in dev) is treated as Premium so the default UI is unchanged.
export function isFreeUser() {
  try {
    const p = JSON.parse(sessionStorage.getItem("spotify_profile") || "null");
    return p ? p.premium === false : false;
  } catch {
    return false;
  }
}

export function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 227013 ms -> "3:47"
export function formatDuration(ms) {
  const totalSeconds = Math.round((ms || 0) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ISO timestamp -> "Jul 12" (year appended once it differs from the current
// one). Used for the sidebar subtitle and the playlist page's "Created" line.
export function formatCreatedDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

// (24, 4_500_000) -> "24 songs, 1 hr 15 min"
export function formatPlaylistMeta(trackCount, totalMs) {
  const totalMinutes = Math.round((totalMs || 0) / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const duration = h > 0 ? `${h} hr ${m} min` : `${m} min`;
  return `${trackCount} song${trackCount === 1 ? "" : "s"}, ${duration}`;
}

// Bridge row -> the shape trackRow() renders.
export function dbTrack(row) {
  return {
    title: row.track_name,
    artist: row.artists,
    album: row.album_name,
    time: formatDuration(row.duration_ms),
    trackId: row.track_id,
  };
}

// Deep link to a song in Spotify. Placeholder rows have no track_id, so fall
// back to a search link, which still resolves to the song in Spotify.
export function spotifyUrl(title, artist, trackId) {
  if (trackId) return `https://open.spotify.com/track/${encodeURIComponent(trackId)}`;
  return `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`)}`;
}

export async function openInSpotify(title, artist, trackId) {
  try {
    await callPy("open_external_url", spotifyUrl(title, artist, trackId));
  } catch (err) {
    console.error("Couldn't open the track in Spotify:", err);
  }
}

// Minimal transient toast (bottom-centre, above the player). PyWebView has no
// reliable alert(), hence DIY. Shared by the save button and playback errors.
// z-[70] keeps it above the z-[60] modal overlays (add-to-playlists popup,
// create-playlist modal) — some toasts fire while those are still open.
export function showToast(message) {
  document.getElementById("app-toast")?.remove();
  const toast = document.createElement("div");
  toast.id = "app-toast";
  toast.className =
    "fixed bottom-28 left-1/2 -translate-x-1/2 z-[70] px-5 py-2.5 rounded-full " +
    "bg-surface-container-high border border-white/10 shadow-xl " +
    "text-label-md font-label-md text-on-surface transition-opacity duration-300";
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => (toast.style.opacity = "0"), 2200);
  setTimeout(() => toast.remove(), 2600);
}

// One tracklist row. Premium hover shows the in-app play affordance — pass
// onPlay to make the click actually play (result page); rows without it stay
// inert (home showcase). Free hover shows open-in-new and the click opens the
// song in Spotify (external browser / desktop app).
export function trackRow(index, track, accent, isFree, onPlay) {
  const el = document.createElement("div");
  el.className =
    "track-grid px-4 md:px-6 py-3 group hover:bg-white/5 transition-colors cursor-pointer rounded-lg mx-2" +
    (index === 1 ? " mt-1" : "");
  const hoverIcon = isFree
    ? `<span class="material-symbols-outlined text-[18px]">open_in_new</span>`
    : `<span class="material-symbols-outlined filled text-[20px]">play_arrow</span>`;
  el.innerHTML = `
    <div class="text-center text-on-surface-variant group-hover:hidden">${index}</div>
    <div class="text-center text-primary hidden group-hover:flex items-center justify-center">${hoverIcon}</div>
    <div class="flex items-center gap-3 min-w-0">
      <div class="w-10 h-10 rounded flex items-center justify-center shadow-sm shrink-0" style="background-color: ${hexToRgba(accent, 0.2)};"><span class="material-symbols-outlined text-[20px]" style="color: ${accent};">music_note</span></div>
      <div class="truncate"><p class="text-body-md font-body-md text-on-surface font-medium truncate"></p></div>
    </div>
    <div class="text-body-md font-body-md text-on-surface-variant truncate group-hover:text-on-surface transition-colors"></div>
    <div class="track-col-album text-body-md font-body-md text-on-surface-variant truncate"></div>
    <div class="text-right text-body-md font-body-md text-on-surface-variant font-medium"></div>`;
  // Assign text via textContent (children: 0 #, 1 play, 2 title-block, 3 artist, 4 album, 5 time).
  el.querySelector("p").textContent = track.title;
  el.children[3].textContent = track.artist;
  el.children[4].textContent = track.album;
  el.children[5].textContent = track.time;
  if (isFree) {
    el.title = "Open in Spotify";
    el.addEventListener("click", () => openInSpotify(track.title, track.artist, track.trackId));
  } else if (onPlay) {
    el.title = "Play";
    el.addEventListener("click", onPlay);
  }
  return el;
}
