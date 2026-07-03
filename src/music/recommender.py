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
# size^2 / CANDIDATE_POOL_LIMIT, i.e. < 1 track at the default size of 25. Small
# enough to fit in memory and to avoid a server-side ORDER BY RAND().
CANDIDATE_POOL_LIMIT = 1000

# Default playlist length. CP1 survey §3.2 favoured 21-30 tracks; 25 is the mid.
DEFAULT_PLAYLIST_SIZE = 25

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
) -> list[dict]:
    """Build a playlist of `size` tracks matching the given emotion.

    Args:
        emotion: One of 'happy', 'surprised', 'sad', 'angry', 'neutral'.
        size:    Desired track count; capped at the candidate pool size.
        seed:    Optional seed for deterministic sampling in tests. None in
                 production for varied recommendations.

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

    candidates = connection.fetchall(_CANDIDATE_SQL, (*params, start, CANDIDATE_POOL_LIMIT))
    if len(candidates) < CANDIDATE_POOL_LIMIT:
        deficit = CANDIDATE_POOL_LIMIT - len(candidates)
        candidates += connection.fetchall(_CANDIDATE_WRAP_SQL, (*params, start, deficit))

    return rng.sample(candidates, min(size, len(candidates)))


def count_candidates(emotion: str) -> int:
    """Return the total number of in-scope tracks matching an emotion's rule.

    Diagnostic helper for the hidden debug page (docs/RECOMMENDATION.md). Counts
    the whole matching set, not the capped candidate pool that generate_playlist
    samples from. Raises ValueError for unsupported emotions.
    """
    rule = _lookup_rule(emotion)
    return connection.fetchone(_COUNT_SQL, _range_params(rule))["n"]
