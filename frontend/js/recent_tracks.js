/*
 * Recent-track memory for generated playlists (docs/RECOMMENDATION.md
 * "Recent-track exclusion", docs/FRONTEND.md § "Recent-track exclusion").
 *
 * Why: for a narrow emotion×genre pool (e.g. K-Pop × sad has only ~17 matching
 * tracks) the recommender's random window IS the whole pool, so re-attempting
 * the same mood/genre path kept re-drawing the same handful of songs. This
 * remembers the track_ids already served for a given (emotion × genre filter)
 * context THIS SESSION and feeds them back to generate_playlist as
 * exclude_ids, so each re-attempt walks forward through the pool. The backend
 * backfills once unseen tracks run out, so this never shortens a playlist.
 *
 * Scope is deliberately session-only (sessionStorage, cleared when the app
 * closes) — it is NOT the long-term listening-history personalisation that
 * CLAUDE.md lists as out of scope; nothing persists across runs.
 *
 * State: sessionStorage.recent_tracks = { "<contextKey>": [trackId, ...] }.
 * The context key pairs the emotion with the active genre filter, so switching
 * mood or changing genres starts a fresh cycle automatically; old contexts
 * linger harmlessly (bounded, tiny).
 */

const STORAGE_KEY = "recent_tracks";

// Rolling cap on remembered ids PER CONTEXT. Comfortably exceeds every narrow
// pool that actually repeats (the worst per-emotion genre pools are a few
// hundred tracks), so those walk end-to-end before anything recycles. For huge
// pools the exact value is irrelevant — exclusion barely bites there — it just
// bounds sessionStorage. A few hundred ids across a handful of contexts is well
// under the multi-MB sessionStorage budget.
const MAX_PER_CONTEXT = 300;

/** Stable per-pool key. `filter` is the getGenreFilter() array or null (all). */
function contextKey(emotion, filter) {
  return `${emotion}|${filter && filter.length ? filter.join("|") : "all"}`;
}

function readAll() {
  try {
    const obj = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function writeAll(obj) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // sessionStorage full/unavailable: exclusion is a best-effort nicety, so a
    // failure here just means the next attempt may repeat — never fatal.
  }
}

/**
 * The track_ids already served for this emotion×filter context this session.
 * Pass straight to generate_playlist as its exclude_ids argument.
 */
export function getRecentExclusions(emotion, filter) {
  const ids = readAll()[contextKey(emotion, filter)];
  return Array.isArray(ids) ? ids : [];
}

/**
 * Record the ids just served for this context. Re-served ids move to the end
 * (most-recent), and the list is trimmed to the rolling cap from the end, so
 * the memory always reflects the freshest window of the pool.
 */
export function recordServedTracks(emotion, filter, trackIds) {
  const ids = (trackIds || []).filter((t) => typeof t === "string" && t);
  if (!ids.length) return;
  const all = readAll();
  const key = contextKey(emotion, filter);
  const prev = Array.isArray(all[key]) ? all[key] : [];
  const merged = prev.filter((id) => !ids.includes(id)).concat(ids);
  all[key] = merged.slice(-MAX_PER_CONTEXT);
  writeAll(all);
}
