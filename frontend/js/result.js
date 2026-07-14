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
 *    bookmark button persists it via save_playlist and refreshes the sidebar.
 *    Opened with no flow behind it, the page heads home — there is nothing
 *    real to show.
 *
 * Both modes share an inline EDIT MODE (the pencil button): the title and
 * description swap to inputs in place, every track row gains a remove (X)
 * button, and Done / Cancel appear. Fresh view: Done updates the in-session
 * playlist (sessionStorage.playlist_title / playlist_description /
 * current_playlist), so the bookmark save persists whatever was customised;
 * if the playlist was already saved this visit, the DB copy is updated too.
 * Saved view: Done persists via update_playlist. Defaults when the user never
 * edits: title = the per-emotion page title ("Happy Playlist"), description =
 * the per-emotion metaLead copy. The old date-stamped save name is gone — the
 * created date lives in the sidebar subtitle and the "Created" meta line now.
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
  formatCreatedDate,
  formatPlaylistMeta,
  hexToRgba,
  isFreeUser,
  showToast,
  trackRow,
} from "./playlists_ui.js";
import { refreshSidebarPlaylists } from "./sidebar.js";

// Page copy per emotion; accent/emoji/cover come from EMOTION_THEMES. The
// title/metaLead pair doubles as the default playlist name/description when
// the user saves without editing.
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

// Everything the header/tracklist/edit-mode render from. `description` uses
// "" for "none"; `playlistId` is the saved id (saved view, or set by a fresh
// save so later edits keep the DB copy in sync).
const state = {
  mode: null, // "fresh" | "saved"
  emotion: null, // fresh view only (drives the bookmark save)
  accent: DEFAULT_ACCENT,
  free: false,
  playlistId: null,
  title: "",
  description: "",
  createdAt: null, // ISO string, or null before a fresh playlist is saved
  tracks: [],
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

// Title, description (hidden when empty) and the "N songs, X min · Created
// Jul 12" meta line — everything edit mode can change.
function renderHeader() {
  document.getElementById("playlist-title").textContent = state.title;
  const desc = document.getElementById("playlist-description");
  desc.textContent = state.description;
  desc.classList.toggle("hidden", !state.description);
  const totalMs = state.tracks.reduce((sum, t) => sum + (t.duration_ms || 0), 0);
  const created = state.createdAt ? ` · Created ${formatCreatedDate(state.createdAt)}` : "";
  document.getElementById("playlist-meta").textContent =
    formatPlaylistMeta(state.tracks.length, totalMs) + created;
  document.title = `EchoSoul - ${state.title}`;
}

// ---- Mode 1: saved playlist (#playlist=<id>) --------------------------------

async function renderSavedPlaylist(playlistId) {
  // A saved playlist isn't a fresh detection: no mood banner, and the
  // save-bookmark affordance makes no sense (it's already saved).
  document.getElementById("result-banner")?.remove();
  document.getElementById("save-playlist-btn")?.remove();
  state.mode = "saved";
  state.free = isFreeUser();
  if (state.free) applyFreeMode();

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
    document.getElementById("edit-playlist-btn")?.remove();
    document.title = "EchoSoul - Playlist not found";
    return;
  }

  const theme = EMOTION_THEMES[(playlist.source_emotion || "").toLowerCase()] || null;
  state.accent = theme ? theme.accent : DEFAULT_ACCENT;
  state.playlistId = playlist.playlist_id;
  state.title = playlist.name;
  state.description = playlist.description || "";
  state.createdAt = playlist.created_at;
  state.tracks = playlist.tracks;
  renderCover(state.accent, theme);
  renderHeader();
  renderTracklist();
  wireEditButton();
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
  state.mode = "fresh";
  state.emotion = emotion;
  state.accent = theme.accent;
  state.free = isFreeUser();
  if (state.free) applyFreeMode();

  // Defaults come from the page copy; edits from earlier in this session
  // (Back from another page) survive in sessionStorage. A stored empty
  // description means the user deliberately cleared it.
  state.title = sessionStorage.getItem("playlist_title") || copy.title;
  const storedDesc = sessionStorage.getItem("playlist_description");
  state.description = storedDesc !== null ? storedDesc : copy.metaLead;
  state.tracks = tracks;

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
  renderHeader();
  renderTracklist();
  wireSaveButton();
  wireEditButton();
}

// ---- Tracklist + playback (shared by both views) -----------------------------

// Renders the rows and, for Premium accounts, wires the play affordances:
// play-all (the play_circle button + the cover hover overlay) starts the whole
// list in order; clicking a row starts the list at that track, so next/prev on
// the bottom player walk the playlist. playback.js owns the actual SDK device.
function renderTracklist() {
  const { tracks, accent, free } = state;
  const trackIds = tracks.map((t) => t.track_id);
  const list = document.getElementById("tracklist");
  list.innerHTML = "";
  tracks.forEach((t, i) =>
    list.appendChild(
      trackRow(i + 1, dbTrack(t), accent, free, free ? undefined : () => startPlayback(trackIds, i))
    )
  );
  if (free) return; // applyFreeMode already removed the play-all affordances

  const playAll = () => startPlayback(trackIds, 0);
  const playBtn = document.getElementById("playlist-play-btn");
  const overlay = document.getElementById("cover-play-overlay");
  // Re-rendering after an edit must not stack stale handlers with old ids.
  playBtn?.replaceWith(rewired(playBtn, playAll));
  overlay?.replaceWith(rewired(overlay, playAll));
}

// Clone-and-rewire: a cloned node drops every previously attached listener.
function rewired(el, handler) {
  const clone = el.cloneNode(true);
  clone.addEventListener("click", handler);
  return clone;
}

function startPlayback(trackIds, startIndex) {
  playTracks(trackIds, startIndex).catch((err) => {
    console.error("playTracks failed:", err);
    showToast(err.message || "Spotify couldn't start playback.");
  });
}

// ---- Save (bookmark button, fresh-detection view only) ----------------------

function wireSaveButton() {
  const btn = document.getElementById("save-playlist-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    let playlistId;
    try {
      playlistId = await callPy(
        "save_playlist",
        state.title,
        state.emotion,
        state.tracks.map((t) => t.track_id),
        state.description || null
      );
    } catch (err) {
      console.error("save_playlist failed:", err);
      showToast("Couldn't save the playlist — please try again.");
      btn.disabled = false;
      return;
    }
    // Saved: fill the bookmark and keep the button disabled — saving the same
    // playlist twice only clutters the sidebar. The new row appears live, and
    // later edits on this page now update the saved copy (update_playlist).
    state.playlistId = playlistId;
    state.createdAt = new Date().toISOString();
    renderHeader();
    btn.querySelector(".material-symbols-outlined")?.classList.add("filled");
    btn.style.color = state.accent;
    btn.title = "Saved";
    showToast("Playlist saved");
    refreshSidebarPlaylists();
  });
}

// ---- Edit mode (both views) --------------------------------------------------

// While editing: title/description become inputs in place, the action row
// (save/play/edit) is swapped for Done/Cancel, and the tracklist re-renders
// with per-row remove buttons. Nothing is applied until Done.
const edit = {
  active: false,
  pending: [], // working copy of state.tracks
  titleInput: null,
  descInput: null,
  controls: null, // the Done/Cancel row
};

function wireEditButton() {
  document
    .getElementById("edit-playlist-btn")
    ?.addEventListener("click", () => {
      if (!edit.active) enterEditMode();
    });
}

function enterEditMode() {
  edit.active = true;
  edit.pending = [...state.tracks];

  const titleEl = document.getElementById("playlist-title");
  const descEl = document.getElementById("playlist-description");
  const actions = document.getElementById("playlist-actions");

  edit.titleInput = document.createElement("input");
  edit.titleInput.type = "text";
  edit.titleInput.maxLength = 200;
  edit.titleInput.value = state.title;
  edit.titleInput.placeholder = "Playlist title";
  edit.titleInput.className =
    "w-full bg-transparent border-b-2 border-primary/60 focus:border-primary outline-none " +
    "text-headline-lg font-headline-lg text-on-surface tracking-tight";

  edit.descInput = document.createElement("textarea");
  edit.descInput.rows = 2;
  edit.descInput.maxLength = 500;
  edit.descInput.value = state.description;
  edit.descInput.placeholder = "Add a description (optional)";
  edit.descInput.className =
    "w-full bg-surface-container-high/60 border border-white/10 focus:border-primary/60 " +
    "rounded-lg px-3 py-2 text-body-md font-body-md text-on-surface resize-none outline-none " +
    "transition-colors";

  edit.controls = document.createElement("div");
  edit.controls.className = "flex items-center gap-3 mt-4";
  const doneBtn = document.createElement("button");
  doneBtn.className =
    "px-5 py-2 rounded-full bg-primary text-on-primary text-label-md font-label-md " +
    "flex items-center gap-1.5 hover:opacity-90 transition-opacity disabled:opacity-40";
  doneBtn.innerHTML = `<span class="material-symbols-outlined text-[18px]">check</span>Done`;
  const cancelBtn = document.createElement("button");
  cancelBtn.className =
    "px-5 py-2 rounded-full bg-white/10 text-on-surface text-label-md font-label-md " +
    "hover:bg-white/15 transition-colors";
  cancelBtn.textContent = "Cancel";
  doneBtn.addEventListener("click", () => commitEdit(doneBtn));
  cancelBtn.addEventListener("click", () => exitEditMode());
  edit.controls.append(doneBtn, cancelBtn);

  titleEl.classList.add("hidden");
  titleEl.after(edit.titleInput);
  descEl.classList.add("hidden");
  edit.titleInput.after(edit.descInput);
  actions.classList.add("hidden");
  actions.after(edit.controls);

  renderEditTracklist();
  edit.titleInput.focus();
  edit.titleInput.select();
}

function exitEditMode() {
  edit.active = false;
  edit.titleInput?.remove();
  edit.descInput?.remove();
  edit.controls?.remove();
  document.getElementById("playlist-title").classList.remove("hidden");
  document.getElementById("playlist-description").classList.toggle("hidden", !state.description);
  document.getElementById("playlist-actions").classList.remove("hidden");
  renderTracklist();
}

function renderEditTracklist() {
  const list = document.getElementById("tracklist");
  list.innerHTML = "";
  const removable = edit.pending.length > 1; // a playlist keeps at least one song
  edit.pending.forEach((t, i) => list.appendChild(editTrackRow(i + 1, t, removable)));
}

// A read-only row with the time cell replaced by a remove (X) button. The
// hover play/open affordance is suppressed — rows are inert while editing.
function editTrackRow(index, t, removable) {
  const el = trackRow(index, dbTrack(t), state.accent, false, undefined);
  el.classList.remove("cursor-pointer");
  el.children[0].classList.remove("group-hover:hidden");
  el.children[1].classList.remove("group-hover:flex");
  const timeCell = el.children[5];
  timeCell.textContent = "";
  const btn = document.createElement("button");
  btn.disabled = !removable;
  btn.title = removable ? "Remove from playlist" : "A playlist needs at least one song";
  btn.className =
    "w-8 h-8 rounded-full inline-flex items-center justify-center text-on-surface-variant " +
    "hover:text-red-400 hover:bg-white/10 transition-colors " +
    "disabled:opacity-30 disabled:hover:text-on-surface-variant disabled:hover:bg-transparent";
  btn.innerHTML = `<span class="material-symbols-outlined text-[20px]">close</span>`;
  btn.addEventListener("click", () => {
    edit.pending.splice(index - 1, 1);
    renderEditTracklist();
  });
  timeCell.appendChild(btn);
  return el;
}

async function commitEdit(doneBtn) {
  // An emptied title falls back to what it was — the backend rejects blank
  // names, and "no title" isn't a meaningful playlist state.
  const title = edit.titleInput.value.trim() || state.title;
  const description = edit.descInput.value.trim();
  const pending = edit.pending;

  // Any view backed by a DB row (saved view, or a fresh playlist already
  // bookmarked) persists first; only a success mutates the page state.
  if (state.playlistId !== null) {
    doneBtn.disabled = true;
    let ok = false;
    try {
      ok = await callPy(
        "update_playlist",
        state.playlistId,
        title,
        description || null,
        pending.map((t) => t.track_id)
      );
    } catch (err) {
      console.error("update_playlist failed:", err);
      showToast("Couldn't save your changes — please try again.");
      doneBtn.disabled = false;
      return;
    }
    if (!ok) {
      // Deleted from the sidebar mid-edit: nothing left to update.
      showToast("This playlist no longer exists.");
      window.location.replace("home.html");
      return;
    }
    showToast("Playlist updated");
    refreshSidebarPlaylists();
  }

  state.title = title;
  state.description = description;
  state.tracks = pending;
  if (state.mode === "fresh") {
    // Keep the in-session playlist in sync so the bookmark save — and a Back/
    // forward revisit — pick up the customised version. An empty stored
    // description means "cleared on purpose" (don't re-default to metaLead).
    sessionStorage.setItem("playlist_title", state.title);
    sessionStorage.setItem("playlist_description", state.description);
    sessionStorage.setItem("current_playlist", JSON.stringify(state.tracks));
  }
  exitEditMode();
  renderHeader();
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
