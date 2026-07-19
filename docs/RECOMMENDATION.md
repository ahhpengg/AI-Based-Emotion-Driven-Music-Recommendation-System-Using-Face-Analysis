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
    genres: list[str] | None = None,
    exclude_ids: list[str] | None = None,
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
        genres:   Optional list of canonical genre buckets (docs/DATABASE.md
                  "Canonical genre") to restrict the pool to. None/empty = all
                  genres — the default flow, and what the UI sends while every
                  bucket is still checked. Unknown buckets simply match nothing.
        exclude_ids: Optional track_ids already served this session for the same
                  emotion×genre context (see "Recent-track exclusion"). The draw
                  prefers unseen tracks; it backfills from the excluded ones when
                  the pool runs out, so it never returns fewer tracks than a
                  no-exclusion draw. None/empty = no exclusion (the default).

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

A naïve `... WHERE <ranges> LIMIT 1000` looks right but is quietly broken: with no
`ORDER BY`, MySQL walks the `(valence, energy, tempo)` index from the low end and
returns the **1000 lowest-valence** matches. For `happy` that means valence pinned
at ~0.66 — the ~96,000 genuinely happy tracks above it are never reachable. The
pool must be a *random* slice of the emotion's set, not the first index page.

We get that from `sample_key` (a stored generated column; see `docs/DATABASE.md`):
every track has a fixed, uniform value in `[0, 1)` that is uncorrelated with the
audio features. Pick a random start point and read the window above it:

```python
rng   = random.Random(seed)   # None in prod (system-seeded), fixed in tests
start = rng.random()          # Stage 1: a random entry point in [0, 1)

candidates = db.fetchall("""
    SELECT track_id, track_name, artists, album_name, genre,
           valence, energy, tempo, duration_ms
    FROM music FORCE INDEX (idx_music_sample_vet)
    WHERE valence BETWEEN %s AND %s
      AND energy  BETWEEN %s AND %s
      AND tempo   BETWEEN %s AND %s
      AND sample_key >= %s
    ORDER BY sample_key
    LIMIT %s
""", (*range_params, start, CANDIDATE_POOL_LIMIT))
```

Notes that matter:
- **Query the base table with `FORCE INDEX`, not the view.** The optimizer misreads
  the wide `sample_key >= start` range as a full scan (seconds slow); pinning
  `idx_music_sample_vet (sample_key, valence, energy, tempo)` makes it a range scan
  that filters valence/energy/tempo in-index and stops at 1000 rows (~60–100 ms).
- **`ORDER BY sample_key` with no tiebreaker.** The index provides this order
  natively (no filesort). It stays deterministic anyway because InnoDB appends the
  primary key to every secondary-index entry, so tied `sample_key` values have a
  stable total order. Adding `, track_id` *breaks* this — that column isn't in the
  index, so MySQL falls back to a filesort over the whole range (seconds slow).
- **Wrap-around top-up.** If `start` lands near 1.0 the window above it is short,
  so top up from the low end (`sample_key < start`, disjoint, no de-dup) to keep
  the pool ~1000. This only triggers in the top ~1% of start values.

Where `CANDIDATE_POOL_LIMIT = 1000`. Reasoning:
- 1000 is large enough that Stage 2 produces meaningful variety, and large enough
  relative to the playlist that two nearby `start` values (overlapping windows)
  still yield near-disjoint playlists — see Step 4.
- 1000 is small enough that the candidate set fits in memory (~100 KB) and the
  index scan stays fast.

### Step 4 — Random sample

```python
N = min(size, len(candidates))
return rng.sample(candidates, N)   # Stage 2: draw the playlist from the window
```

Two stages of randomness, both driven by the same seeded `rng`:
- **Stage 1 (`start`)** chooses *which* random 1000-track window of the emotion's
  set to look at — this is what gives session-to-session variety across the whole
  feature range.
- **Stage 2 (`sample`)** chooses *which* `size` tracks from that window.

Stage 2 is not redundant: it's what protects against two calls landing on nearby
`start` values. Even if their 1000-track windows were *identical*, two independent
`size`-track draws overlap by only `size² / 1000` tracks on average (< 1 track at
the default size of 20). So heavy window overlap still yields different playlists.

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

## The 20-track default

The CP1 user survey (§3.2) asked about preferred playlist length; 21–30 was the most common response. The owner set the default to 20, just under that band.

Configurable via the `size` argument so the UI can offer it as a preference later.

---

## Genre filtering (owner-requested, 2026-07-18)

The CP1 plan deliberately excluded genre filtering — the raw `genre` column was a
3,994-value folksonomy (empty-combo risk, redundant with the mood signature).
That decision was **reversed by the owner in CP2** once the blockers were
actually measured and solved:

1. **The noise problem is solved** by the canonical mapping — 23 owner-reviewed
   buckets in `music.canonical_genre` (docs/DATABASE.md "Canonical genre").
2. **The empty-combo risk was measured, not assumed:** an emotion×bucket matrix
   against the rule windows showed exactly one combo under the default playlist
   size (K-Pop × sad = 18 at mapping time). Policy: **thin picks are allowed** —
   the playlist just comes out shorter and the UI says so.
3. **Filtering is opt-in.** `genres=None` (the default) is the CP1 behaviour,
   bit-for-bit. Variety across genres remains the default experience.

### Filtered candidate pool (Step 3, genre variant)

The unfiltered index cannot serve a genre filter well: `canonical_genre` isn't
in `idx_music_sample_vet`, so MySQL would fetch table rows across the *whole*
emotion range hunting for matches — for a thin pick that's a 100k-row-fetch
scan (the same failure mode the header search hit, docs/DATABASE.md
"Track search"). Migration **0010** adds the genre-first equivalent:

```sql
CREATE INDEX idx_music_genre_sample_vet
    ON music (canonical_genre, sample_key, valence, energy, tempo);
```

The filtered pool is built with **one windowed query per selected bucket** —
an equality prefix on `canonical_genre` turns each query into the same native
`sample_key`-ordered range scan as the unfiltered path (no filesort), with the
same wrap-around top-up. Windows are concatenated in Python and Stage 2 samples
from the union. Per-genre window: `max(50, 1000 // len(genres))` rows, so the
merged pool stays ~`CANDIDATE_POOL_LIMIT` regardless of how many buckets are
picked. Genre lists are deduplicated and sorted before querying so a fixed seed
stays deterministic regardless of picker order.

**Mix behaviour (deliberate):** sampling uniformly over the union of same-sized
windows weights the picked genres roughly equally rather than by catalogue
share — a user who picks Pop + K-Pop wants a blend, not 95% Pop. A small bucket
contributes everything it has.

### Picker semantics (owner-specified)

The UI is a multiple-choice picker over the 23 buckets with **all buckets
checked by default** and a floor of **at least one checked** (UI-enforced —
unchecking the last one is blocked). All-checked is identical to "no filter":
the frontend sends `genres=None` in that state, so the default flow takes the
unfiltered CP1 code path bit-for-bit. There are **no per-bucket counts** in the
picker (owner decision — the goal is relatability, not pool statistics); a thin
pick simply yields a shorter playlist with an explanatory note. The bucket
list itself comes from a small bridge lookup (`DISTINCT canonical_genre`,
cached for the session) so the vocabulary stays single-sourced from the seed
CSV via the database.

---

## Recent-track exclusion (owner-requested, 2026-07-19)

### The problem

Stage 1's random window is what makes two calls differ — but it only works when
the emotion's matching set is *much larger* than the 1000-row window. For a
narrow **genre × emotion** pool that isn't true: the window (plus wrap-around)
pulls the **entire** matching set every time, so the random `start` becomes a
no-op and all variety collapses onto Stage 2's draw. Two independent draws of
`size` from a pool of `N` then repeat ~`size²/N` tracks. Measured against the
real catalogue:

| genre × emotion | pool `N` | ~repeats per re-attempt (size 20) |
|---|--:|--:|
| K-Pop × sad | 17 | all 17 every time (pool < playlist) |
| C-Pop / Mandopop × happy | 133 | ~3 |
| K-Pop × neutral | 107 | ~4 |
| Pop × happy | 5,739 | ~0.1 (feels varied) |

Users re-attempting the same mood/genre path noticed the same handful of songs
recurring. Unfiltered generation never shows this (`N` is hundreds of thousands,
so `size²/N` < 1).

### The fix

The frontend remembers the track_ids it has already served for a given
**(emotion × active genre filter)** context, session-scoped, and passes them as
`exclude_ids`. The draw (`_sample_excluding`) then splits the fetched window
into `fresh` (not in `exclude_ids`) and `stale` (already served):

- `len(fresh) >= size` → sample from `fresh` only. A re-attempt **walks forward**
  through the pool with no repeats.
- otherwise → serve all of `fresh`, then backfill the remainder from `stale`
  (reshuffled). This is the exhaustion guard: once every unseen track is used
  up, the playlist degrades gracefully to a reshuffle of what exists — it is
  **never shorter or emptier** than a no-exclusion draw, so exclusion introduces
  no new empty-pool / `playlist_failed` path.

Applying the exclusion in Python **over the already-fetched window** is
deliberate: it needs **no SQL, index, or migration change**, and it is exact
precisely where it matters — for the narrow pools the window *is* the whole pool,
while for huge pools it is a near-no-op (Stage 1 already varies the window, and
excluding a few hundred ids from 1000 leaves plenty). The recommender stays
stateless: the memory lives in the frontend (`frontend/js/recent_tracks.js`,
`sessionStorage`, rolling cap per context), so `generate_playlist` remains a pure
function — same `(emotion, size, seed, genres, exclude_ids)` ⇒ same output, and
the existing seeded tests are unaffected because `exclude_ids=None` takes the
original `rng.sample` path bit-for-bit.

**Scope note:** this is session-only (cleared when the app closes) and therefore
*not* the long-term listening-history personalisation that CLAUDE.md lists as out
of scope. There is no cross-run user model.

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
| `genres` names an unknown bucket | Matches nothing (contributes 0 rows); no error — the picker only offers real buckets, so this only happens to stale/hand-edited state |
| `genres` given but every bucket is thin | Shorter playlist; the UI shows "only N songs match" per the thin-combo policy |
| Same emotion called twice in quick succession | Different output each time (no seed), thanks to fresh `random.Random()` instance per call. For a re-attempt of the same emotion×genre path the frontend also passes `exclude_ids` (see "Recent-track exclusion") so narrow pools walk forward instead of repeating |
| `exclude_ids` covers the entire matching pool | Backfill from the served set — a reshuffle of the same tracks, never `[]` (exhaustion guard) |
| Rule table doesn't have the emotion | Caught at Step 1 — but if somehow seeded incorrectly, Step 2 raises `TypeError` on missing row. Fail loud. |
| Catalogue contains NULL valence/energy/tempo | Excluded by `v_in_scope_music` view |
| Track is in 100 candidate playlists | Not relevant — each call produces an independent sample |

---

## Performance budget

| Operation | Target | Measured | Notes |
|---|---|---|---|
| Rule lookup (Step 2) | < 10 ms | — | 5-row table, indexed PK |
| Candidate query (Step 3) | < 200 ms | ~60–100 ms | `idx_music_sample_vet`, pinned with `FORCE INDEX` |
| Random sampling (Step 4) | < 5 ms | — | 1000 → 25, in-memory |
| **Total** | **< 250 ms** | ~60–110 ms | first (cold) call ~250 ms |

If Step 3 exceeds 500 ms in practice, check:
- Is `idx_music_sample_vet` present? `SHOW INDEX FROM music;`
- Is MySQL using it? `EXPLAIN` should show `type = range`, `key = idx_music_sample_vet`, `Using index condition`.
- **Is there a `Using filesort`?** If so the query is sorting the whole matching range before `LIMIT` — the usual cause is an `ORDER BY sample_key, <other>` tiebreaker or a dropped `FORCE INDEX`. Order by `sample_key` alone and keep the hint.
- Is the query plan cache cold? First query after server start is slower; warm up.

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
