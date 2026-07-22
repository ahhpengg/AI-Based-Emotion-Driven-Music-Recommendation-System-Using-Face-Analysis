/*
 * Header search (docs/FRONTEND.md § "Header search").
 *
 * Drives the top-app-bar search box chrome.js renders on the five full-header
 * pages (home / mood / loading / result / error). As-you-type (debounced)
 * catalogue search via the bridge's search_tracks — FULLTEXT word-prefix match
 * on title + artists, most popular first. Clicking a result plays it: Premium
 * starts a single-track queue on the in-app SDK device (playback.js), Free
 * opens the song in Spotify externally. Each row's add button opens the shared
 * add-to-playlists popup (add_to_playlists.js — also used by the bottom
 * player's add button); search rows are catalogue tracks by construction, so
 * no ensureInCatalogue is needed here.
 */
import { openAddPopup } from "./add_to_playlists.js";
import { callPy } from "./bridge.js";
import { playTracks } from "./playback.js";
import { formatDuration, isFreeUser, openInSpotify, showToast } from "./playlists_ui.js";

// Below this the backend returns nothing anyway — don't even call.
const MIN_QUERY_CHARS = 2;
// One search per typing pause, not one per keystroke.
const DEBOUNCE_MS = 250;
const RESULT_LIMIT = 10;

const input = document.getElementById("header-search");
const dropdown = document.getElementById("search-dropdown");

let seq = 0; // stale-response guard: only the latest search may render
let debounceTimer = null;
let lastQuery = ""; // the query lastResults belongs to (re-open on focus)
let lastResults = null;

// The photo page uses the "back" header (no search box) and the pre-auth
// pages have no chrome at all — this module is a no-op there.
if (input && dropdown) init();

function init() {
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (query.length < MIN_QUERY_CHARS) {
      seq++; // invalidate any in-flight search
      lastResults = null;
      hideDropdown();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
  });

  // Clicking back into the box re-opens the previous results.
  input.addEventListener("focus", () => {
    if (lastResults && input.value.trim() === lastQuery) showDropdown();
  });

  document.addEventListener("click", (e) => {
    if (e.target.closest("#header-search-wrap") || e.target.closest("#add-playlists-overlay")) {
      return; // clicks inside the popup must not close the results underneath
    }
    hideDropdown();
  });

  // While the add popup is open, its capture-phase Escape handler
  // (add_to_playlists.js) closes the popup and suppresses this listener, so
  // the results dropdown stays put until a second Escape.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideDropdown();
  });
}

function showDropdown() {
  dropdown.classList.remove("hidden");
}

function hideDropdown() {
  dropdown.classList.add("hidden");
}

// ---- Searching ---------------------------------------------------------------

async function runSearch(query) {
  const mySeq = ++seq;
  renderMessage("Searching…");
  let results;
  try {
    results = await callPy("search_tracks", query, RESULT_LIMIT);
  } catch (err) {
    console.error("search_tracks failed:", err);
    if (mySeq === seq) renderMessage("Search isn't working right now — try again.");
    return;
  }
  if (mySeq !== seq) return; // a newer search superseded this one
  lastQuery = query;
  lastResults = results;
  renderResults(results, query);
}

function renderMessage(text) {
  dropdown.innerHTML = "";
  const p = document.createElement("p");
  p.className = "px-4 py-3 text-label-md font-label-md text-on-surface-variant";
  p.textContent = text;
  dropdown.appendChild(p);
  showDropdown();
}

function renderResults(results, query) {
  if (!results.length) {
    renderMessage(`No songs found for "${query}"`);
    return;
  }
  dropdown.innerHTML = "";
  results.forEach((row) => dropdown.appendChild(resultRow(row)));
  showDropdown();
}

// One dropdown row: icon tile (play affordance on hover), title + artists,
// duration, and the add-to-playlist button.
function resultRow(row) {
  const free = isFreeUser();
  const el = document.createElement("div");
  el.className =
    "group flex items-center gap-3 px-4 py-2.5 hover:bg-white/5 cursor-pointer transition-colors";
  el.title = free ? "Open in Spotify" : "Play";
  el.innerHTML = `
    <div class="w-10 h-10 rounded bg-primary/15 flex items-center justify-center shrink-0">
      <span data-icon-idle class="material-symbols-outlined text-[20px] text-primary group-hover:hidden">music_note</span>
      <span data-icon-hover class="material-symbols-outlined ${free ? "" : "filled "}text-[20px] text-primary hidden group-hover:inline">${free ? "open_in_new" : "play_arrow"}</span>
    </div>
    <div class="flex-grow min-w-0">
      <p data-title class="text-body-md font-body-md text-on-surface font-medium truncate"></p>
      <p data-artists class="text-label-sm font-label-sm text-on-surface-variant truncate"></p>
    </div>
    <span data-duration class="text-label-sm font-label-sm text-on-surface-variant shrink-0"></span>
    <button data-add title="Add to playlist" class="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-white/10 transition-colors shrink-0">
      <span class="material-symbols-outlined text-[20px]">playlist_add</span>
    </button>`;
  el.querySelector("[data-title]").textContent = row.track_name;
  el.querySelector("[data-artists]").textContent = row.artists;
  el.querySelector("[data-duration]").textContent = formatDuration(row.duration_ms);

  el.addEventListener("click", () => {
    hideDropdown();
    if (free) {
      openInSpotify(row.track_name, row.artists, row.track_id);
      return;
    }
    playTracks([row.track_id], 0, "single").catch((err) => {
      console.error("playTracks failed:", err);
      showToast(err.message || "Spotify couldn't play this track.");
    });
  });
  el.querySelector("[data-add]").addEventListener("click", (e) => {
    e.stopPropagation(); // the row click underneath would start playback
    openAddPopup(row);
  });
  return el;
}
