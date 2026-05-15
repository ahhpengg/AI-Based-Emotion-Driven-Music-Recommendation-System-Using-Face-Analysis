# docs/RECOMMENDATION.md

The rule-based emotion-driven music recommendation algorithm.

This module is intentionally simple. It is not a machine-learning recommender — it's a deterministic rule lookup followed by random sampling. The simplicity is a feature: the recommender's behaviour is fully explainable to a non-technical reviewer (the supervisor, the evaluator) and avoids the cold-start problem that the CP1 problem statement explicitly calls out.

---

## Function signature

```python
# src/music/recommender.py

def generate_playlist(
    emotion: str,
    size: int = 25,
    seed: int | None = None,
) -> list[dict]:
    """
    Generate a playlist of N tracks matching the given emotion.

    Args:
        emotion:  One of 'happy', 'surprised', 'sad', 'angry', 'neutral'.
                  Other values raise ValueError.
        size:     Number of tracks to return. Capped at the candidate pool size
                  if there are fewer matching tracks.
        seed:     Optional random seed for deterministic tests.
                  None in production for varied recommendations.

    Returns:
        List of dicts, each with keys:
            track_id, track_name, artists, album_name, genre,
            valence, energy, tempo, duration_ms
    """
```

That's the entire public surface. Everything else is internal.

---

## Algorithm in five steps

### Step 1 — Validate the emotion

```python
SUPPORTED_EMOTIONS = {"happy", "surprised", "sad", "angry", "neutral"}

if emotion not in SUPPORTED_EMOTIONS:
    raise ValueError(f"Unsupported emotion: {emotion!r}")
```

Out-of-scope emotions (`fear`, `disgust`) never reach this function — they're filtered at the FER inference layer (`docs/FER_MODEL.md` §"Out-of-scope handling"). If they somehow do reach here, raising loudly is correct.

### Step 2 — Look up the rule

```python
rule = db.fetchone("""
    SELECT valence_min, valence_max, energy_min, energy_max, tempo_min, tempo_max
    FROM emotion_music_mapping
    WHERE emotion = %s
""", (emotion,))
```

The rule table is seeded once and effectively read-only at runtime (see `docs/DATABASE.md`).

### Step 3 — Build the candidate pool

```python
candidates = db.fetchall("""
    SELECT track_id, track_name, artists, album_name, genre,
           valence, energy, tempo, duration_ms
    FROM v_in_scope_music
    WHERE valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
    LIMIT %s
""", (
    rule["valence_min"], rule["valence_max"],
    rule["energy_min"],  rule["energy_max"],
    rule["tempo_min"],   rule["tempo_max"],
    CANDIDATE_POOL_LIMIT,
))
```

Where `CANDIDATE_POOL_LIMIT = 1000`. Reasoning:
- 1000 is large enough that random sampling produces meaningful variety across calls.
- 1000 is small enough that the entire candidate set fits in memory (each row is ~100 bytes; 1000 rows ≈ 100 KB).
- Pulling 1000 and sampling client-side is *vastly* faster than `ORDER BY RAND() LIMIT 25` server-side.

Index `idx_music_vet` on `(valence, energy, tempo)` makes this query fast (target < 200 ms).

### Step 4 — Random sample

```python
import random

rng = random.Random(seed)  # seeded if seed is not None, else seeded by system time
N = min(size, len(candidates))
return rng.sample(candidates, N)
```

`random.Random()` instances are independent of the global random state. This is important: tests can pass `seed=42` for deterministic output without affecting any other random-using code in the system.

### Step 5 — Return the list

Return as plain dicts (JSON-serialisable, since the result crosses the JS bridge to the frontend).

---

## Pool exhaustion behaviour

If fewer than `size` tracks match the rule, return whatever exists. The caller (the API layer) can decide whether to inform the user.

In practice with ~1.2M tracks in the catalogue, every emotion should have **tens of thousands** of matching candidates. The `LIMIT 1000` in step 3 caps the candidate pool; the rule never produces fewer than 1000 matches in normal operation. If it does, the seed data was wrong or the catalogue was loaded incorrectly.

### Diagnostic: count, don't fail

```python
def count_candidates(emotion: str) -> int:
    """Returns the total matching tracks for an emotion. Useful for debug pages."""
    rule = _lookup_rule(emotion)
    return db.fetchone("""
        SELECT COUNT(*) AS n FROM v_in_scope_music
        WHERE valence BETWEEN %s AND %s
          AND energy  BETWEEN %s AND %s
          AND tempo   BETWEEN %s AND %s
    """, (...))["n"]
```

Add a hidden debug page that displays the candidate count per emotion. Helpful during CP2 testing to confirm the rule table is reasonable.

---

## The 25-track default

The CP1 user survey (§3.2) asked about preferred playlist length; 21–30 was the most common response. Default of 25 sits in the middle.

Configurable via the `size` argument so the UI can offer it as a preference later.

---

## Why not include genre in the filter?

A reasonable instinct is to filter by genre too — "happy + pop" or "sad + ballad". We deliberately don't, for three reasons:

1. **Genre and emotion are partially redundant.** The valence/energy/tempo signature already captures the "feel" of the music. Adding a genre filter narrows the pool to little benefit and can produce empty results for niche emotion+genre combinations.
2. **Surprise / variety is desirable.** A user feeling happy might enjoy *both* an upbeat pop track and an upbeat indie folk track. Restricting genre would hide this.
3. **The capstone plan does not specify genre filtering** in §3.10. Adding it would extend scope.

Genre is **displayed** in the result (so the user knows what they're getting) but not **filtered on**.

### Future extension (not for CP1/CP2)

A future version could expose an optional genre filter or a "more like this" mode that adds the seed track's genre as a soft preference (e.g. weighted sampling, not hard filter). Out of scope for the capstone.

---

## Determinism for tests

```python
# tests/music/test_recommender.py

def test_happy_playlist_is_deterministic_with_seed():
    p1 = generate_playlist("happy", size=10, seed=42)
    p2 = generate_playlist("happy", size=10, seed=42)
    assert [t["track_id"] for t in p1] == [t["track_id"] for t in p2]

def test_different_seeds_give_different_playlists():
    p1 = generate_playlist("happy", size=10, seed=42)
    p2 = generate_playlist("happy", size=10, seed=43)
    # Overlap is possible but full equality is astronomically unlikely
    assert [t["track_id"] for t in p1] != [t["track_id"] for t in p2]

def test_unsupported_emotion_raises():
    with pytest.raises(ValueError):
        generate_playlist("ennui")
```

These tests assume the seeded catalogue. The test fixture can either:
- Use the real catalogue (integration test, slower).
- Use a small fixture catalogue loaded into a separate test schema (unit test, faster).

Default: integration test against the real catalogue, marked with `@pytest.mark.slow`. A subset of tests using a 100-row fixture catalogue runs in the fast suite.

See `docs/TESTING.md`.

---

## Edge cases and how the algorithm handles them

| Situation | Behaviour |
|---|---|
| Candidate pool has < `size` matches | Return all matches (smaller-than-requested playlist) |
| Candidate pool is empty | Return `[]`; caller can show "no matches" message |
| Same emotion called twice in quick succession | Different output each time (no seed), thanks to fresh `random.Random()` instance per call |
| Rule table doesn't have the emotion | Caught at Step 1 — but if somehow seeded incorrectly, Step 2 raises `TypeError` on missing row. Fail loud. |
| Catalogue contains NULL valence/energy/tempo | Excluded by `v_in_scope_music` view |
| Track is in 100 candidate playlists | Not relevant — each call produces an independent sample |

---

## Performance budget

| Operation | Target | Notes |
|---|---|---|
| Rule lookup (Step 2) | < 10 ms | 5-row table, indexed PK |
| Candidate query (Step 3) | < 200 ms | Composite index `idx_music_vet` |
| Random sampling (Step 4) | < 5 ms | 1000 → 25, in-memory |
| **Total** | **< 250 ms** | |

If Step 3 exceeds 500 ms in practice, check:
- Is `idx_music_vet` present? `SHOW INDEX FROM music;`
- Is MySQL using it? `EXPLAIN` should show `type = range`, `key = idx_music_vet`.
- Is the query plan caching cold? First query after server start is slower; warm up.

---

## When to change the rule table

Changes go through:

1. Update `data/seed/emotion_music_mapping.sql`.
2. Update the migration that seeds it, OR add a new migration that does `UPDATE emotion_music_mapping SET ... WHERE emotion = '...'`.
3. Document the change and rationale in the capstone report.

Do **not** hardcode rule values in Python. The point of having a table is to make the rules data, not code.

### Likely tuning moments

- **After Phase 4 user testing (CP2 weeks 9–10):** if survey responses show users feel "the playlist is too intense for sad" or similar, adjust the corresponding bounds.
- **If the catalogue distribution looks skewed:** run a histogram of `valence` and `energy` over the 1.2M tracks. If most music clusters around 0.3–0.7 (which it does — Spotify's `valence` distribution is roughly normal centred near 0.5), the bounds `[0, 0.34]` for "sad" may capture fewer tracks than expected. Still tens of thousands, but worth verifying with `count_candidates`.

---

## What the recommender deliberately does NOT do

These are common feature requests during reviews. They are out of scope for CP1/CP2:

- **Personalisation based on user history.** No user model. The CP1 problem statement explicitly avoids this.
- **Collaborative filtering.** No multi-user data.
- **Content-based ranking within the candidate pool.** All candidates are treated as equal in step 4. A weighted sample by popularity (`popularity` column) would be a natural extension — defer.
- **Diversity enforcement** (e.g. "don't pick three tracks by the same artist"). With random sampling from a 1000-track pool, same-artist clustering is rare. Defer.
- **Cold-start handling for new users.** Not applicable — the system has no concept of user history.
- **Re-ranking by audio similarity** (e.g. "after picking the seed track, pick neighbours in the feature space"). Defer.
- **Mood blending** (e.g. "user is 70% happy, 30% surprised — interpolate the rule"). The FER model outputs a single argmax label; the rule is single-emotion. Future work.

The single-line response if any of these come up in supervisor review: *"explainable, deterministic recommendation is the scope for the capstone; ML-based ranking is documented as future work."*

---

## Related docs

- `docs/DATABASE.md` — schema for `music` and `emotion_music_mapping`.
- `docs/MUSIC_DATA.md` — how the catalogue is built.
- `docs/FER_MODEL.md` — produces the emotion label that feeds this recommender.
- `docs/ARCHITECTURE.md` — where the recommender sits in the system flow.
