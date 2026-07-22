/*
 * Create-playlist modal (docs/FRONTEND.md § "Create playlist modal").
 *
 * The sidebar's + button (#sidebar-new-playlist, rendered by chrome.js on
 * every chrome page) opens a two-step modal:
 *
 *   1. Emotion picker — the five supported emotions; the choice drives the
 *      cover art, accent and default title. Confirm moves on; Cancel /
 *      backdrop / Esc close (nothing to lose yet).
 *   2. Builder — cover + editable title (default per emotion) + optional
 *      description (defaults to EMPTY: this playlist isn't generated, so
 *      there is no tagline to inherit), a catalogue search box reusing the
 *      header bar's search_tracks query but with the results inline below it
 *      (not a dropdown) and an explicit "Add" text button per result row (the
 *      header search's icon-only add opens a different popup — the label
 *      avoids that confusion), the removable added-songs list, and Cancel /
 *      Create. Create stays disabled until at least one song is added; an
 *      emptied title falls back to the per-emotion default (the backend
 *      rejects blank names). Step 2 closes only via its buttons — backdrop
 *      clicks and Esc are ignored there so a stray click can't throw away a
 *      built-up draft.
 *
 * The draft lives ONLY in this module's memory until Create persists it via
 * save_playlist, so a half-built playlist can never be reached by the header
 * search's add-to-playlists popup (that popup lists saved playlists only).
 * Create then opens the new playlist (result.html#playlist=<id>) — the
 * navigation (or result.js's hashchange reload) re-renders the sidebar, where
 * the playlist now appears.
 *
 * Result-row clicks preview the song like the header search: Premium plays
 * in-app (playback.js), Free opens it in Spotify. The photo page has no
 * bottom player (no SDK device to play on), so Premium clicks fall back to
 * opening in Spotify there too.
 */
import { callPy } from "./bridge.js";
import { playTracks } from "./playback.js";
import {
  EMOTION_DEFAULT_TITLES,
  EMOTION_THEMES,
  formatDuration,
  hexToRgba,
  isFreeUser,
  openInSpotify,
  showToast,
} from "./playlists_ui.js";

// Same search behaviour as the header bar (js/search.js).
const MIN_QUERY_CHARS = 2;
const DEBOUNCE_MS = 250;
const RESULT_LIMIT = 10;

// Picker display order — the app's emotion vocabulary.
const EMOTION_ORDER = ["happy", "surprised", "sad", "angry", "neutral"];

let overlay = null; // the open modal, or null
let draft = null; // { emotion, tracks: [] } while the builder is open
let seq = 0; // stale-response guard, as in search.js
let debounceTimer = null;

const newBtn = document.getElementById("sidebar-new-playlist");
if (newBtn) {
  newBtn.addEventListener("click", () => {
    // On the mobile drawer the sidebar would sit over the modal — close it
    // the way chrome.js does (its closeSidebar isn't exported to modules).
    document.getElementById("app-sidebar")?.classList.add("-translate-x-full");
    document.getElementById("app-backdrop")?.classList.add("hidden");
    openEmotionPicker();
  });
}

function closeModal() {
  overlay?.remove();
  overlay = null;
  draft = null;
  seq++; // drop any in-flight search
  clearTimeout(debounceTimer);
  document.removeEventListener("keydown", onKeydown);
}

// Esc closes the harmless picker step only; a built-up draft needs Cancel.
function onKeydown(e) {
  if (e.key === "Escape" && overlay?.dataset.step === "pick") closeModal();
}

// In-app playback needs the bottom player's SDK device and a Premium account;
// without either, a result-row click opens the song in Spotify instead.
function canPlayInApp() {
  return Boolean(document.getElementById("app-player")) && !isFreeUser();
}

// ---- Step 1: emotion picker ---------------------------------------------------

function openEmotionPicker() {
  closeModal();
  overlay = document.createElement("div");
  overlay.id = "create-playlist-overlay";
  overlay.dataset.step = "pick";
  overlay.className = "fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay && overlay.dataset.step === "pick") closeModal();
  });
  document.addEventListener("keydown", onKeydown);

  const card = document.createElement("div");
  card.className =
    "w-[26rem] max-w-full rounded-2xl bg-surface-container-high border border-white/10 shadow-2xl p-5";
  card.innerHTML = `
    <p class="text-body-md font-body-md text-on-surface font-bold">New playlist</p>
    <p class="text-label-sm font-label-sm text-on-surface-variant mt-0.5">Choose the emotion this playlist represents.</p>
    <div data-emotions class="grid grid-cols-5 gap-2 my-4"></div>
    <div class="flex justify-end gap-2">
      <button data-cancel class="px-4 py-2 rounded-full bg-white/10 text-on-surface text-label-md font-label-md hover:bg-white/15 transition-colors">Cancel</button>
      <button data-confirm disabled class="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-label-md hover:opacity-90 transition-opacity disabled:opacity-40">Confirm</button>
    </div>`;

  let chosen = null;
  const confirmBtn = card.querySelector("[data-confirm]");
  const tiles = EMOTION_ORDER.map((emotion) => {
    const theme = EMOTION_THEMES[emotion];
    const tile = document.createElement("button");
    tile.className =
      "flex flex-col items-center gap-1.5 px-1 py-2.5 rounded-xl border border-transparent " +
      "hover:bg-white/5 transition-colors";
    tile.innerHTML = `
      <img src="${theme.emoji}" alt="" class="w-9 h-9 object-contain">
      <span class="text-label-sm font-label-sm text-on-surface-variant capitalize">${emotion}</span>`;
    tile.addEventListener("click", () => {
      chosen = emotion;
      tiles.forEach((t) => {
        t.style.borderColor = "";
        t.style.backgroundColor = "";
      });
      tile.style.borderColor = theme.accent;
      tile.style.backgroundColor = hexToRgba(theme.accent, 0.12);
      confirmBtn.disabled = false;
    });
    return tile;
  });
  card.querySelector("[data-emotions]").append(...tiles);

  card.querySelector("[data-cancel]").addEventListener("click", closeModal);
  confirmBtn.addEventListener("click", () => {
    if (chosen) openBuilder(chosen);
  });

  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

// ---- Step 2: builder ------------------------------------------------------------

function openBuilder(emotion) {
  const theme = EMOTION_THEMES[emotion];
  draft = { emotion, tracks: [] };
  overlay.dataset.step = "build";
  overlay.innerHTML = "";

  const card = document.createElement("div");
  card.className =
    "w-[34rem] max-w-full max-h-[90vh] rounded-2xl bg-surface-container-high " +
    "border border-white/10 shadow-2xl p-5 flex flex-col";
  card.innerHTML = `
    <div class="flex items-start gap-4 shrink-0">
      <div class="w-20 h-20 rounded-xl overflow-hidden flex items-center justify-center shrink-0"
           style="background-image: linear-gradient(135deg, ${theme.accent}, #222a3d);">
        <img data-cover alt="" class="w-full h-full object-cover">
      </div>
      <div class="flex-grow min-w-0">
        <input data-title type="text" maxlength="200" placeholder="Playlist title"
               class="w-full bg-transparent border-b-2 border-primary/60 focus:border-primary outline-none text-headline-md font-headline-md text-on-surface tracking-tight">
        <textarea data-desc rows="2" maxlength="500" placeholder="Add a description (optional)"
                  class="w-full mt-2 bg-surface-container-highest/60 border border-white/10 focus:border-primary/60 rounded-lg px-3 py-2 text-body-md font-body-md text-on-surface resize-none outline-none transition-colors"></textarea>
      </div>
    </div>
    <div class="relative mt-4 shrink-0">
      <span class="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none text-[20px]">search</span>
      <input data-search type="text" autocomplete="off" spellcheck="false" placeholder="Search songs to add…"
             class="w-full bg-surface-container-highest border-none rounded-full py-2.5 pl-11 pr-5 text-on-surface placeholder:text-on-surface-variant focus:ring-1 focus:ring-primary transition-all font-body-md">
    </div>
    <div data-results class="hidden overflow-y-auto max-h-52 mt-2 rounded-xl bg-surface-container/60 border border-white/10 py-1 shrink-0"></div>
    <p data-added-label class="text-label-sm font-label-sm text-outline-variant uppercase tracking-wider mt-4 mb-1 shrink-0"></p>
    <div data-added class="overflow-y-auto min-h-[4.5rem]"></div>
    <div class="flex justify-end gap-2 pt-4 shrink-0">
      <button data-cancel class="px-4 py-2 rounded-full bg-white/10 text-on-surface text-label-md font-label-md hover:bg-white/15 transition-colors">Cancel</button>
      <button data-create disabled class="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-label-md hover:opacity-90 transition-opacity disabled:opacity-40">Create</button>
    </div>`;

  // Cover art with the same emoji fallback as the result page's cover tile.
  const cover = card.querySelector("[data-cover]");
  cover.onerror = () => {
    cover.onerror = null;
    cover.className = "w-12 h-12 object-contain";
    cover.src = theme.emoji;
  };
  cover.src = theme.cover;

  const titleInput = card.querySelector("[data-title]");
  titleInput.value = EMOTION_DEFAULT_TITLES[emotion];
  const descInput = card.querySelector("[data-desc]");
  const resultsBox = card.querySelector("[data-results]");
  const createBtn = card.querySelector("[data-create]");

  // Same debounce / min-chars / stale-guard behaviour as the header search.
  const searchInput = card.querySelector("[data-search]");
  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const query = searchInput.value.trim();
    if (query.length < MIN_QUERY_CHARS) {
      seq++; // invalidate any in-flight search
      resultsBox.classList.add("hidden");
      return;
    }
    debounceTimer = setTimeout(() => runSearch(query, resultsBox), DEBOUNCE_MS);
  });

  card.querySelector("[data-cancel]").addEventListener("click", closeModal);
  createBtn.addEventListener("click", () => createPlaylist(titleInput, descInput, createBtn));

  // renderAdded queries through `overlay`, so the card must be attached first.
  overlay.appendChild(card);
  renderAdded();
  titleInput.focus();
  titleInput.select();
}

// ---- Search (inline results) ---------------------------------------------------

async function runSearch(query, resultsBox) {
  const mySeq = ++seq;
  renderSearchMessage(resultsBox, "Searching…");
  let results;
  try {
    results = await callPy("search_tracks", query, RESULT_LIMIT);
  } catch (err) {
    console.error("search_tracks failed:", err);
    if (mySeq === seq) renderSearchMessage(resultsBox, "Search isn't working right now — try again.");
    return;
  }
  if (mySeq !== seq) return; // superseded, or the modal closed meanwhile
  if (!results.length) {
    renderSearchMessage(resultsBox, `No songs found for "${query}"`);
    return;
  }
  resultsBox.innerHTML = "";
  results.forEach((row) => resultsBox.appendChild(resultRow(row)));
  resultsBox.classList.remove("hidden");
}

function renderSearchMessage(resultsBox, text) {
  resultsBox.innerHTML = "";
  const p = document.createElement("p");
  p.className = "px-3 py-2.5 text-label-md font-label-md text-on-surface-variant";
  p.textContent = text;
  resultsBox.appendChild(p);
  resultsBox.classList.remove("hidden");
}

// One inline result row: play/open affordance on the row itself, explicit Add.
function resultRow(row) {
  const inApp = canPlayInApp();
  const el = document.createElement("div");
  el.dataset.trackId = row.track_id;
  el.className =
    "group flex items-center gap-3 px-3 py-2 hover:bg-white/5 cursor-pointer transition-colors";
  el.title = inApp ? "Play" : "Open in Spotify";
  el.innerHTML = `
    <div class="w-9 h-9 rounded bg-primary/15 flex items-center justify-center shrink-0">
      <span class="material-symbols-outlined text-[18px] text-primary group-hover:hidden">music_note</span>
      <span class="material-symbols-outlined ${inApp ? "filled " : ""}text-[18px] text-primary hidden group-hover:inline">${inApp ? "play_arrow" : "open_in_new"}</span>
    </div>
    <div class="flex-grow min-w-0">
      <p data-title class="text-body-md font-body-md text-on-surface font-medium truncate"></p>
      <p data-artists class="text-label-sm font-label-sm text-on-surface-variant truncate"></p>
    </div>
    <span data-duration class="text-label-sm font-label-sm text-on-surface-variant shrink-0"></span>
    <button data-add class="shrink-0"></button>`;
  el.querySelector("[data-title]").textContent = row.track_name;
  el.querySelector("[data-artists]").textContent = row.artists;
  el.querySelector("[data-duration]").textContent = formatDuration(row.duration_ms);

  const addBtn = el.querySelector("[data-add]");
  styleAddButton(addBtn, draft.tracks.some((t) => t.track_id === row.track_id));
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // the row click underneath would start playback
    addToDraft(row, addBtn);
  });

  el.addEventListener("click", () => {
    if (!canPlayInApp()) {
      openInSpotify(row.track_name, row.artists, row.track_id);
      return;
    }
    playTracks([row.track_id], 0, "single").catch((err) => {
      console.error("playTracks failed:", err);
      showToast(err.message || "Spotify couldn't play this track.");
    });
  });
  return el;
}

// "Add" (enabled) or "Added" (locked) — draft membership decides. Also the
// duplicate guard: save_playlist fails loud on duplicate track ids.
function styleAddButton(btn, added) {
  btn.disabled = added;
  btn.textContent = added ? "Added" : "Add";
  btn.className =
    "px-3.5 py-1.5 rounded-full text-label-md font-label-md shrink-0 transition-colors " +
    (added ? "bg-white/5 text-on-surface-variant" : "bg-primary text-on-primary hover:opacity-90");
}

// ---- Draft (in-memory until Create) ---------------------------------------------

function addToDraft(row, addBtn) {
  if (draft.tracks.some((t) => t.track_id === row.track_id)) return;
  draft.tracks.push(row);
  styleAddButton(addBtn, true);
  renderAdded();
}

// The removable added-songs list; Create unlocks at one song.
function renderAdded() {
  const label = overlay.querySelector("[data-added-label]");
  const box = overlay.querySelector("[data-added]");
  overlay.querySelector("[data-create]").disabled = draft.tracks.length === 0;
  label.textContent = `Added songs (${draft.tracks.length})`;
  box.innerHTML = "";
  if (!draft.tracks.length) {
    const p = document.createElement("p");
    p.className = "px-1 py-2 text-label-sm font-label-sm text-on-surface-variant opacity-60";
    p.textContent = "No songs yet — search above and add at least one.";
    box.appendChild(p);
    return;
  }
  draft.tracks.forEach((track, i) => box.appendChild(addedRow(track, i)));
}

function addedRow(track, index) {
  const el = document.createElement("div");
  el.className = "flex items-center gap-3 px-1 py-1.5 rounded-lg hover:bg-white/5";
  el.innerHTML = `
    <span class="w-5 text-center text-label-sm font-label-sm text-on-surface-variant shrink-0">${index + 1}</span>
    <div class="flex-grow min-w-0">
      <p data-title class="text-body-md font-body-md text-on-surface truncate"></p>
      <p data-artists class="text-label-sm font-label-sm text-on-surface-variant truncate"></p>
    </div>
    <span data-duration class="text-label-sm font-label-sm text-on-surface-variant shrink-0"></span>
    <button data-remove title="Remove" class="w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant hover:text-red-400 hover:bg-white/10 transition-colors shrink-0">
      <span class="material-symbols-outlined text-[18px]">close</span>
    </button>`;
  el.querySelector("[data-title]").textContent = track.track_name;
  el.querySelector("[data-artists]").textContent = track.artists;
  el.querySelector("[data-duration]").textContent = formatDuration(track.duration_ms);
  el.querySelector("[data-remove]").addEventListener("click", () => {
    draft.tracks.splice(index, 1);
    renderAdded();
    // Give the song's search result (if still on screen) its Add button back.
    const btn = overlay.querySelector(
      `[data-results] [data-track-id="${CSS.escape(track.track_id)}"] [data-add]`
    );
    if (btn) styleAddButton(btn, false);
  });
  return el;
}

// Persist the draft and open the new playlist. Only now does the playlist
// exist outside this modal (sidebar, header search's add-to-playlists popup).
async function createPlaylist(titleInput, descInput, createBtn) {
  if (!draft || !draft.tracks.length) return;
  // An emptied title falls back to the per-emotion default — the backend
  // rejects blank names, and "no title" isn't a meaningful playlist state.
  const title = titleInput.value.trim() || EMOTION_DEFAULT_TITLES[draft.emotion];
  const description = descInput.value.trim() || null;
  const trackIds = draft.tracks.map((t) => t.track_id);
  const emotion = draft.emotion;
  createBtn.disabled = true;
  let playlistId;
  try {
    playlistId = await callPy("save_playlist", title, emotion, trackIds, description);
  } catch (err) {
    console.error("save_playlist failed:", err);
    showToast("Couldn't create the playlist — please try again.");
    createBtn.disabled = false;
    return;
  }
  closeModal();
  // Fresh navigation (or result.js's hashchange reload when already there) —
  // either way the sidebar re-renders with the new playlist in it.
  window.location.assign(`result.html#playlist=${playlistId}`);
}
