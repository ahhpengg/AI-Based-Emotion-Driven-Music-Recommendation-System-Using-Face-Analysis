/*
 * Live saved-playlists sidebar (docs/FRONTEND.md).
 *
 * chrome.js renders the sidebar shell with an empty #sidebar-playlists
 * container on every chrome page; this module fills it from the Python bridge:
 *   - list_user_playlists -> the rows (newest-updated first)
 *   - rename_playlist     -> kebab menu > Rename (inline input in place)
 *   - delete_playlist     -> kebab menu > Delete (second click confirms —
 *                            PyWebView doesn't reliably support confirm())
 * Clicking a row opens the playlist as result.html#playlist=<id>; result.js
 * reloads on hashchange, so switching playlists from the result page works.
 * The row for the playlist currently open on the result page is highlighted.
 */
import { callPy } from "./bridge.js";
import { EMOTION_THEMES } from "./playlists_ui.js";

const container = document.getElementById("sidebar-playlists");

function note(text) {
  const p = document.createElement("p");
  p.className = "px-3 py-2 text-label-sm font-label-sm text-on-surface-variant opacity-60";
  p.textContent = text;
  return p;
}

// The playlist id open on the result page, or null anywhere else.
function activePlaylistId() {
  if (!window.location.pathname.toLowerCase().endsWith("result.html")) return null;
  const m = window.location.hash.match(/^#playlist=(\d+)$/);
  return m ? Number(m[1]) : null;
}

// ---- Kebab menu (one open at a time) ---------------------------------------

let openMenu = null;

function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

document.addEventListener("click", (e) => {
  if (openMenu && !e.target.closest("[data-playlist-menu]")) closeMenu();
});

function openMenuFor(item, playlist) {
  closeMenu();
  const menu = document.createElement("div");
  menu.dataset.playlistMenu = "";
  menu.className =
    "absolute right-2 top-10 z-50 w-44 rounded-lg bg-surface-container-high border border-white/10 shadow-xl py-1";
  menu.innerHTML = `
    <button data-act="rename" class="w-full flex items-center gap-2 px-3 py-2 text-label-md font-label-md text-on-surface hover:bg-white/5 text-left transition-colors"><span class="material-symbols-outlined text-[18px]">edit</span>Rename</button>
    <button data-act="delete" class="w-full flex items-center gap-2 px-3 py-2 text-label-md font-label-md text-red-400 hover:bg-white/5 text-left transition-colors"><span class="material-symbols-outlined text-[18px]">delete</span>Delete</button>`;

  let deleteArmed = false;
  menu.addEventListener("click", (e) => {
    e.preventDefault(); // the menu lives inside the row's <a>
    e.stopPropagation();
    const action = e.target.closest("[data-act]")?.dataset.act;
    if (action === "rename") {
      closeMenu();
      startRename(item, playlist);
    } else if (action === "delete") {
      if (!deleteArmed) {
        deleteArmed = true;
        menu.querySelector('[data-act="delete"]').innerHTML =
          `<span class="material-symbols-outlined text-[18px]">delete</span>Confirm delete?`;
        return;
      }
      deletePlaylist(item, playlist);
    }
  });

  item.appendChild(menu);
  openMenu = menu;
}

// ---- Rename / delete --------------------------------------------------------

function startRename(item, playlist) {
  const nameEl = item.querySelector("[data-name]");
  const input = document.createElement("input");
  input.type = "text";
  input.value = playlist.name;
  input.className =
    "w-full bg-surface-container-high border border-primary/50 rounded px-2 py-1 " +
    "text-label-md font-label-md text-on-surface focus:outline-none focus:border-primary";
  // The input sits inside the row's <a>: keep clicks from navigating.
  input.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  let done = false;
  async function finish(commit) {
    if (done) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    nameEl.classList.remove("hidden");
    if (!commit || !value || value === playlist.name) return;
    try {
      await callPy("rename_playlist", playlist.playlist_id, value);
      playlist.name = value;
      nameEl.textContent = value;
    } catch (err) {
      console.error("rename_playlist failed:", err);
    }
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault(); // Enter inside an <a> would also follow the link
      finish(true);
    } else if (e.key === "Escape") {
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(false));

  nameEl.classList.add("hidden");
  nameEl.after(input);
  input.focus();
  input.select();
}

async function deletePlaylist(item, playlist) {
  closeMenu();
  try {
    await callPy("delete_playlist", playlist.playlist_id);
  } catch (err) {
    console.error("delete_playlist failed:", err);
    return;
  }
  const wasOpen = activePlaylistId() === playlist.playlist_id;
  item.remove();
  if (container && !container.querySelector("[data-playlist-item]")) {
    container.replaceChildren(note("No saved playlists yet."));
  }
  // The playlist being viewed no longer exists: don't leave a dead page up.
  if (wasOpen) window.location.assign("home.html");
}

// ---- Rendering ---------------------------------------------------------------

function playlistItem(playlist, isActive) {
  const item = document.createElement("div");
  item.dataset.playlistItem = "";
  item.className = "relative group";

  const row = document.createElement("a");
  row.href = `result.html#playlist=${playlist.playlist_id}`;
  row.className =
    "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer " +
    (isActive
      ? "text-primary font-bold bg-primary/10 border-r-2 border-primary"
      : "text-on-surface-variant hover:bg-white/5 hover:text-on-surface");

  const theme = EMOTION_THEMES[(playlist.source_emotion || "").toLowerCase()];
  const thumb = theme
    ? `<img src="${theme.emoji}" alt="" class="w-5 h-5 object-contain shrink-0">`
    : `<span class="material-symbols-outlined text-[20px] shrink-0">music_note</span>`;
  const count = playlist.track_count;
  row.innerHTML = `${thumb}
    <span class="flex-grow min-w-0">
      <span data-name class="block text-label-md font-label-md truncate"></span>
      <span class="block text-label-sm font-label-sm opacity-60">${count} song${count === 1 ? "" : "s"}</span>
    </span>
    <button data-kebab aria-label="Playlist options" class="w-7 h-7 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-white/10 transition-opacity shrink-0">
      <span class="material-symbols-outlined text-[18px]">more_horiz</span>
    </button>`;
  row.querySelector("[data-name]").textContent = playlist.name;

  row.querySelector("[data-kebab]").addEventListener("click", (e) => {
    e.preventDefault(); // don't follow the row's link
    e.stopPropagation(); // don't let the document handler instantly close it
    if (openMenu && openMenu.parentElement === item) {
      closeMenu();
    } else {
      openMenuFor(item, playlist);
    }
  });

  item.appendChild(row);
  return item;
}

function render(playlists) {
  if (!playlists.length) {
    container.replaceChildren(note("No saved playlists yet."));
    return;
  }
  const active = activePlaylistId();
  container.replaceChildren(
    ...playlists.map((p) => playlistItem(p, p.playlist_id === active))
  );
}

export async function refreshSidebarPlaylists() {
  if (!container) return;
  try {
    render(await callPy("list_user_playlists"));
  } catch (err) {
    console.error("list_user_playlists failed:", err);
    container.replaceChildren(note("Couldn't load playlists."));
  }
}

refreshSidebarPlaylists();
