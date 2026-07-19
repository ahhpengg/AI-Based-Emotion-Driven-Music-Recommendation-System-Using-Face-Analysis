"""Rule-based emotion-driven music recommender.

Deliberately simple and fully explainable (docs/RECOMMENDATION.md): look up the
valence/energy/tempo target range for a detected emotion, pull a bounded
candidate pool from the local catalogue, then randomly sample a playlist from
it. No machine learning, no personalisation — the behaviour is deterministic
under a fixed seed, which is what the tests rely on.

Sampling is two-stage so the whole matching set is reachable, not just one slice
of it: a random start point on the ``sample_key`` index selects a random window
of the candidates (Stage 1), then a random draw picks the playlist from that
window (Stage 2). An unordered ``LIMIT`` alone would always return the same
low-valence rows in index order.
"""

from __future__ import annotations

import random

from src.db import connection

# The 5 emotions the recommender supports. `fear` and `disgust` are filtered out
# earlier, at the FER inference layer (docs/FER_MODEL.md), and never reach here.
SUPPORTED_EMOTIONS = frozenset({"happy", "surprised", "sad", "angry", "neutral"})

# Size of the random candidate window pulled before the Stage-2 draw. Kept far
# larger than a playlist so two nearby random start points (whose windows overlap
# heavily) still yield near-disjoint playlists — expected overlap of two draws is
# size^2 / CANDIDATE_POOL_LIMIT, i.e. < 1 track at the default size of 20. Small
# enough to fit in memory and to avoid a server-side ORDER BY RAND().
CANDIDATE_POOL_LIMIT = 1000

# Default playlist length. CP1 survey §3.2 favoured 21-30 tracks; owner set 20.
DEFAULT_PLAYLIST_SIZE = 20

# Floor for the per-genre candidate window when a genre filter is active. With
# many buckets picked, CANDIDATE_POOL_LIMIT split evenly would drop below the
# playlist size (1000 // 23 = 43); the floor keeps every bucket's window at
# least twice the default playlist, so a pick whose other buckets turn out
# empty can still fill a playlist on its own.
MIN_GENRE_WINDOW = 50

_RULE_SQL = """
    SELECT valence_min, valence_max, energy_min, energy_max, tempo_min, tempo_max
    FROM emotion_music_mapping
    WHERE emotion = %s
"""

# Stage 1: the candidate window starting at a random point on the sample_key
# index. Queries the base table (not v_in_scope_music) so it can pin the index:
# FORCE INDEX is needed because the optimizer misreads the wide `sample_key >= s`
# range as a full scan. `ORDER BY sample_key` (no tiebreaker) is served natively
# by the index with no filesort, and stays deterministic because InnoDB appends
# the primary key to the secondary index, giving tied keys a stable total order.
# The rule ranges make the view's defensive tempo/NULL filters redundant (the
# columns are NOT NULL and every rule's tempo range sits within 20-250).
_CANDIDATE_SQL = """
    SELECT track_id, track_name, artists, album_name, genre,
           valence, energy, tempo, duration_ms
    FROM music FORCE INDEX (idx_music_sample_vet)
    WHERE valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
      AND sample_key >= %s
    ORDER BY sample_key
    LIMIT %s
"""

# Wrap-around top-up: when the random start lands near the top of the key space
# the window above it is short, so fill the remainder from the low end. The
# `< %s` range is disjoint from the primary `>= %s` range, so no de-duplication
# is needed.
_CANDIDATE_WRAP_SQL = """
    SELECT track_id, track_name, artists, album_name, genre,
           valence, energy, tempo, duration_ms
    FROM music FORCE INDEX (idx_music_sample_vet)
    WHERE valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
      AND sample_key < %s
    ORDER BY sample_key
    LIMIT %s
"""

_COUNT_SQL = """
    SELECT COUNT(*) AS n
    FROM v_in_scope_music
    WHERE valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
"""

# Genre-filtered variants of the candidate pair. The equality prefix on
# canonical_genre turns each selected bucket into its own native
# sample_key-ordered range scan on idx_music_genre_sample_vet (0010) — same
# shape, same no-filesort guarantee, and same FORCE INDEX rationale as the
# unfiltered pair above. One query per bucket; windows merged in Python.
_GENRE_CANDIDATE_SQL = """
    SELECT track_id, track_name, artists, album_name, genre,
           valence, energy, tempo, duration_ms
    FROM music FORCE INDEX (idx_music_genre_sample_vet)
    WHERE canonical_genre = %s
      AND valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
      AND sample_key >= %s
    ORDER BY sample_key
    LIMIT %s
"""

_GENRE_WRAP_SQL = """
    SELECT track_id, track_name, artists, album_name, genre,
           valence, energy, tempo, duration_ms
    FROM music FORCE INDEX (idx_music_genre_sample_vet)
    WHERE canonical_genre = %s
      AND valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
      AND sample_key < %s
    ORDER BY sample_key
    LIMIT %s
"""

_BUCKETS_SQL = """
    SELECT DISTINCT canonical_genre
    FROM music
    WHERE canonical_genre IS NOT NULL
    ORDER BY canonical_genre
"""


def _lookup_rule(emotion: str) -> dict:
    """Return the valence/energy/tempo rule row for a supported emotion.

    Raises ValueError for unsupported emotions and RuntimeError if a supported
    emotion is missing from the seeded rule table (seed corruption — fail loud).
    """
    if emotion not in SUPPORTED_EMOTIONS:
        raise ValueError(f"Unsupported emotion: {emotion!r}")
    rule = connection.fetchone(_RULE_SQL, (emotion,))
    if rule is None:
        raise RuntimeError(
            f"No rule seeded for emotion {emotion!r}; the emotion_music_mapping "
            "table is unseeded or corrupt."
        )
    return rule


def _range_params(rule: dict) -> tuple:
    """Flatten a rule row into the ordered params the range queries expect."""
    return (
        rule["valence_min"],
        rule["valence_max"],
        rule["energy_min"],
        rule["energy_max"],
        rule["tempo_min"],
        rule["tempo_max"],
    )


def generate_playlist(
    emotion: str,
    size: int = DEFAULT_PLAYLIST_SIZE,
    seed: int | None = None,
    genres: list[str] | None = None,
    exclude_ids: list[str] | None = None,
) -> list[dict]:
    """Build a playlist of `size` tracks matching the given emotion.

    Args:
        emotion: One of 'happy', 'surprised', 'sad', 'angry', 'neutral'.
        size:    Desired track count; capped at the candidate pool size.
        seed:    Optional seed for deterministic sampling in tests. None in
                 production for varied recommendations.
        genres:  Optional canonical genre buckets (docs/DATABASE.md "Canonical
                 genre") restricting the pool. None/empty = all genres — the
                 default flow, and what the UI sends while every bucket is
                 checked. Unknown buckets simply contribute no rows.
        exclude_ids: Optional track_ids the caller has served recently for this
                 same emotion×genre context (the frontend's session memory,
                 docs/RECOMMENDATION.md "Recent-track exclusion"). The draw
                 prefers tracks NOT in this set so repeated requests walk forward
                 through the pool instead of re-drawing it; when unseen tracks run
                 out it backfills from the excluded ones, so the result is never
                 shorter or emptier than an unfiltered draw.

    Returns a list of track dicts (keys: track_id, track_name, artists,
    album_name, genre, valence, energy, tempo, duration_ms). The list may be
    shorter than `size` if the pool is smaller. Raises ValueError for
    unsupported emotions.
    """
    rule = _lookup_rule(emotion)
    params = _range_params(rule)
    # A per-call Random instance keeps sampling independent of the global RNG, so
    # a test seed here never perturbs any other random-using code. The same rng
    # drives both the Stage-1 window start and the Stage-2 draw.
    rng = random.Random(seed)
    start = rng.random()

    if genres:
        candidates = _genre_filtered_candidates(genres, params, start)
    else:
        candidates = connection.fetchall(_CANDIDATE_SQL, (*params, start, CANDIDATE_POOL_LIMIT))
        if len(candidates) < CANDIDATE_POOL_LIMIT:
            deficit = CANDIDATE_POOL_LIMIT - len(candidates)
            candidates += connection.fetchall(_CANDIDATE_WRAP_SQL, (*params, start, deficit))

    return _sample_excluding(rng, candidates, size, exclude_ids)


def _sample_excluding(
    rng: random.Random, candidates: list[dict], size: int, exclude_ids: list[str] | None
) -> list[dict]:
    """Draw `size` tracks from the window, preferring ones not recently served.

    Splits the fetched candidate window into ``fresh`` (track_id not in
    ``exclude_ids``) and ``stale`` (already served for this context). Fills from
    ``fresh`` first; only when ``fresh`` can't cover the draw does it top up from
    ``stale``. This is what turns a re-attempt of the same emotion×genre path
    into a forward walk through the pool rather than an independent re-draw
    (docs/RECOMMENDATION.md "Recent-track exclusion").

    Applying the exclusion here — in Python, over the already-fetched window —
    keeps the SQL and its indexes untouched. It is exact precisely where it
    matters: for the narrow pools that repeat (the whole matching set is ≤ the
    ~1000-row window, so the window IS the pool), and a near-no-op for huge pools
    where the Stage-1 window already varies every call.

    The backfill guarantees the result is never shorter than a no-exclusion draw
    of the same window, so exclusion can never turn a non-empty pool into an
    empty playlist — it introduces no new ``playlist_failed`` path.
    """
    want = min(size, len(candidates))
    if not exclude_ids:
        return rng.sample(candidates, want)
    excluded = set(exclude_ids)
    fresh = [t for t in candidates if t["track_id"] not in excluded]
    if len(fresh) >= want:
        return rng.sample(fresh, want)
    # Unseen tracks exhausted: serve all of them, backfill the rest from the
    # recently-served ones, then shuffle so the fresh block isn't always on top.
    stale = [t for t in candidates if t["track_id"] in excluded]
    playlist = fresh + rng.sample(stale, want - len(fresh))
    rng.shuffle(playlist)
    return playlist


def _genre_filtered_candidates(genres: list[str], params: tuple, start: float) -> list[dict]:
    """Merged per-bucket candidate windows for a genre-filtered generation.

    One windowed query per bucket, each in native sample_key order with its own
    wrap-around top-up. Buckets are deduplicated and sorted so a fixed seed is
    deterministic regardless of the order the user ticked them in. Sampling
    uniformly over the merged windows weights picked genres roughly equally
    rather than by catalogue share — deliberate: a user who picks two genres
    wants a blend, not 95% of whichever is bigger (docs/RECOMMENDATION.md).
    """
    wanted = sorted(set(genres))
    per_genre = max(MIN_GENRE_WINDOW, CANDIDATE_POOL_LIMIT // len(wanted))
    candidates: list[dict] = []
    for bucket in wanted:
        rows = connection.fetchall(_GENRE_CANDIDATE_SQL, (bucket, *params, start, per_genre))
        if len(rows) < per_genre:
            deficit = per_genre - len(rows)
            rows += connection.fetchall(_GENRE_WRAP_SQL, (bucket, *params, start, deficit))
        candidates += rows
    return candidates


def list_genre_buckets() -> list[str]:
    """Return the canonical genre vocabulary present in the catalogue, sorted.

    Feeds the frontend genre picker, keeping the bucket list single-sourced
    from the seed CSV via the database (a loose index scan on
    idx_music_canonical_genre — milliseconds).
    """
    return [row["canonical_genre"] for row in connection.fetchall(_BUCKETS_SQL)]


def count_candidates(emotion: str) -> int:
    """Return the total number of in-scope tracks matching an emotion's rule.

    Diagnostic helper for the hidden debug page (docs/RECOMMENDATION.md). Counts
    the whole matching set, not the capped candidate pool that generate_playlist
    samples from. Raises ValueError for unsupported emotions.
    """
    rule = _lookup_rule(emotion)
    return connection.fetchone(_COUNT_SQL, _range_params(rule))["n"]
