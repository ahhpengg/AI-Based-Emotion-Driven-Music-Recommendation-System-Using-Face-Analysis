/*
 * Shared "Add to playlists" popup (docs/FRONTEND.md § "Header search").
 *
 * Multi-select popup over the saved playlists: ones already containing the
 * song are shown checked and locked; confirming appends the song to every
 * selected playlist and reports the outcome with a transient toast. Extracted
 * from search.js so the bottom player's add button (playback.js) opens the
 * exact same popup as the header search rows.
 *
 * The player can be playing a song that is NOT in the EchoSoul catalogue (the
 * user can queue anything from their own Spotify apps) — those callers pass
 * ensureInCatalogue: true along with the row's display metadata, and the
 * backend stores a feature-less catalogue row for unknown tracks in the same
 * transaction as the playlist insert (playable from playlists like any other
 * song, never emotion-recommended). Header search rows are catalogue rows by
 * construction and don't pass it.
 */
import { callPy } from "./bridge.js";
import { EMOTION_THEMES, showToast } from "./playlists_ui.js";
import { refreshSidebarPlaylists } from "./sidebar.js";

const OVERLAY_ID = "add-playlists-overlay";

// Close on Escape. Capture phase so the popup wins over (and suppresses) the
// page's own document-level Escape handlers — e.g. search.js closing its
// results dropdown — regardless of listener registration order.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape" || !document.getElementById(OVERLAY_ID)) return;
    e.stopPropagation();
    closeAddPopup();
  },
  true
);

export function closeAddPopup() {
  document.getElementById(OVERLAY_ID)?.remove();
}

/**
 * Open the popup for one song. `row` needs track_id / track_name / artists
 * (album_name and duration_ms are carried along when present). Pass
 * ensureInCatalogue: true when the song may not be a catalogue track — the
 * confirm then sends the metadata so the backend can store unknown tracks.
 */
export async function openAddPopup(row, { ensureInCatalogue = false } = {}) {
  closeAddPopup();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4";
  overlay.innerHTML = `
    <div class="w-96 max-w-full rounded-2xl bg-surface-container-high border border-white/10 shadow-2xl p-5 flex flex-col">
      <p class="text-body-md font-body-md text-on-surface font-bold">Add to playlists</p>
      <p data-song class="text-label-sm font-label-sm text-on-surface-variant truncate mt-0.5"></p>
      <div data-list class="flex flex-col gap-1 my-4 max-h-64 overflow-y-auto">
        <p class="px-2.5 py-2 text-label-sm font-label-sm text-on-surface-variant">Loading playlists…</p>
      </div>
      <div class="flex justify-end gap-2">
        <button data-cancel class="px-4 py-2 rounded-full bg-white/10 text-on-surface text-label-md font-label-md hover:bg-white/15 transition-colors">Cancel</button>
        <button data-confirm disabled class="px-4 py-2 rounded-full bg-primary text-on-primary text-label-md font-label-md hover:opacity-90 transition-opacity disabled:opacity-40">Add</button>
      </div>
    </div>`;
  overlay.querySelector("[data-song]").textContent = `${row.track_name} — ${row.artists}`;
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAddPopup();
  });
  overlay.querySelector("[data-cancel]").addEventListener("click", closeAddPopup);
  document.body.appendChild(overlay);

  const list = overlay.querySelector("[data-list]");
  const confirmBtn = overlay.querySelector("[data-confirm]");

  let playlists, containing;
  try {
    [playlists, containing] = await Promise.all([
      callPy("list_user_playlists"),
      callPy("get_playlists_containing_track", row.track_id),
    ]);
  } catch (err) {
    console.error("loading playlists for add popup failed:", err);
    list.innerHTML = "";
    const p = document.createElement("p");
    p.className = "px-2.5 py-2 text-label-sm font-label-sm text-on-surface-variant";
    p.textContent = "Couldn't load your playlists — try again.";
    list.appendChild(p);
    return;
  }
  if (!overlay.isConnected) return; // closed while loading

  list.innerHTML = "";
  if (!playlists.length) {
    const p = document.createElement("p");
    p.className = "px-2.5 py-2 text-label-sm font-label-sm text-on-surface-variant";
    p.textContent = "No saved playlists yet — save one from a detection result first.";
    list.appendChild(p);
    return;
  }
  const containingSet = new Set(containing);
  playlists.forEach((p) => list.appendChild(playlistOption(p, containingSet.has(p.playlist_id))));

  list.addEventListener("change", () => {
    confirmBtn.disabled = !list.querySelector("input[data-playlist-id]:checked");
  });
  confirmBtn.addEventListener("click", () =>
    confirmAdd(row, overlay, list, confirmBtn, ensureInCatalogue)
  );
}

// One selectable playlist row; playlists that already contain the song are
// shown checked and locked so the user can see where it already lives.
function playlistOption(p, alreadyIn) {
  const label = document.createElement("label");
  label.className =
    "flex items-center gap-3 px-2.5 py-2 rounded-lg " +
    (alreadyIn ? "opacity-55" : "hover:bg-white/5 cursor-pointer");

  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "w-4 h-4 accent-primary shrink-0";
  box.checked = alreadyIn;
  box.disabled = alreadyIn;
  if (!alreadyIn) box.dataset.playlistId = String(p.playlist_id);

  const theme = EMOTION_THEMES[(p.source_emotion || "").toLowerCase()];
  let icon;
  if (theme) {
    icon = document.createElement("img");
    icon.src = theme.emoji;
    icon.alt = "";
    icon.className = "w-6 h-6 object-contain shrink-0";
  } else {
    icon = document.createElement("span");
    icon.className = "material-symbols-outlined text-[20px] text-on-surface-variant shrink-0";
    icon.textContent = "music_note";
  }

  const name = document.createElement("span");
  name.className = "flex-grow min-w-0 truncate text-body-md font-body-md text-on-surface";
  name.textContent = p.name;

  const hint = document.createElement("span");
  hint.className = "text-label-sm font-label-sm text-on-surface-variant shrink-0";
  hint.textContent = alreadyIn ? "Added" : `${p.track_count} song${p.track_count === 1 ? "" : "s"}`;

  label.append(box, icon, name, hint);
  return label;
}

async function confirmAdd(row, overlay, list, confirmBtn, ensureInCatalogue) {
  const ids = [...list.querySelectorAll("input[data-playlist-id]:checked")].map((box) =>
    Number(box.dataset.playlistId)
  );
  if (!ids.length) return;
  confirmBtn.disabled = true;

  // Only the player path sends metadata: an unknown track gets stored as a
  // feature-less catalogue row so the playlist insert (FK into music) works.
  const meta = ensureInCatalogue
    ? {
        track_name: row.track_name,
        artists: row.artists,
        album_name: row.album_name ?? null,
        duration_ms: row.duration_ms ?? null,
      }
    : null;

  let result;
  try {
    result = await callPy("add_track_to_playlists", row.track_id, ids, meta);
  } catch (err) {
    console.error("add_track_to_playlists failed:", err);
    showToast("Couldn't add the song — please try again.");
    confirmBtn.disabled = false;
    return;
  }
  closeAddPopup();

  const n = result.added.length;
  if (!n) {
    // Only possible via a race (playlist deleted / song added elsewhere while
    // the popup was open) — the popup itself locks already-added playlists.
    showToast("That song couldn't be added — the playlists may have changed.");
    return;
  }
  showToast(`Added to ${n} playlist${n === 1 ? "" : "s"}`);
  refreshSidebarPlaylists();

  // If one of the affected playlists is open on the result page right now,
  // its tracklist (and any later edit's working copy) would be stale — reload
  // once the toast has been seen. Same-document reload keeps playback alive
  // via the pagehide resume stash, like any other navigation.
  const open = window.location.hash.match(/^#playlist=(\d+)$/);
  if (open && result.added.includes(Number(open[1]))) {
    setTimeout(() => window.location.reload(), 1300);
  }
}
