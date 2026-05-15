# docs/MUSIC_DATA.md

How the music catalogue is assembled from three pre-built Kaggle datasets and enriched with artist-genre data, producing the ~1.2M-row `music` table.

This is a **one-time, offline** process. The scripts here run before the application is first launched; they do not run during normal app operation.

---

## Why we are not using Spotify's `/audio-features` endpoint

Spotify deprecated `/audio-features`, `/audio-analysis`, `/recommendations`, `/related-artists`, and featured/category playlists for new third-party apps on **27 November 2024** (Spotify Developer blog, "Introducing some changes to our Web API"). New apps registered after that date receive HTTP 403 from these endpoints.

Implications:
- We cannot fetch valence/energy/tempo for a track at runtime.
- We must rely on pre-built dataset dumps containing these features (snapshotted before the deprecation).
- The `/artists?ids=...` endpoint (which returns artist-level `genres`) is **not** affected; we use it for enrichment.
- The Web Playback SDK is **not** affected; playback continues to work normally.

---

## Source datasets

All three are free, downloadable from Kaggle with a free account, and all expose Spotify-derived audio features.

### Dataset 1 — `maharshipandya/spotify-tracks-dataset`

- **Rows:** 114,000
- **File:** single CSV, ~20 MB
- **Columns we use:** `track_id`, `track_name`, `artists`, `album_name`, `popularity`, `duration_ms`, `valence`, `energy`, `tempo`, `track_genre`
- **Genre quality:** ★★★★★ — `track_genre` is a fine-grained track-level label spanning 125 genres, ~1,000 tracks per genre (balanced sample).
- **Licence:** BSD
- **Mirror:** also on Hugging Face at `huggingface.co/datasets/maharshipandya/spotify-tracks-dataset` (no Kaggle account required to fetch from there).

**Role in the merge:** primary genre authority. When a track appears in multiple sources, this dataset's `track_genre` wins.

### Dataset 2 — `joebeachcapital/30000-spotify-songs`

- **Rows:** 32,833 (≈23,449 unique track_ids; duplicates because the same track can appear in multiple playlists)
- **File:** single CSV, ~8 MB
- **Columns we use:** `track_id`, `track_name`, `track_artist`, `track_album_name`, `track_popularity`, `duration_ms`, `valence`, `energy`, `tempo`, `playlist_genre`, `playlist_subgenre`
- **Genre quality:** ★★★☆☆ — only 6 high-level `playlist_genre` values (edm, latin, pop, r&b, rap, rock) + 24 sub-genres. Coarser than dataset 1.
- **Licence:** CC0 1.0

**Role in the merge:** secondary genre source. Used when dataset 1 doesn't cover a track but dataset 2 does. Also useful for cross-checking.

### Dataset 3 — `rodolfofigueroa/spotify-12m-songs`

- **Rows:** ~1,204,000
- **File:** single CSV, ~280 MB
- **Columns we use:** `id` (= track_id), `name`, `artists`, `artist_ids`, `album`, `album_id`, `valence`, `energy`, `tempo`, `popularity`, `duration_ms`, `year`, `release_date`
- **Genre quality:** ☆☆☆☆☆ — **no genre column.** Must be enriched via Spotify `/artists?ids=...`.
- **Licence:** CC0

**Role in the merge:** catalogue dominance. Provides the bulk of tracks (~10× larger than dataset 1+2 combined). Genre is filled in by the enrichment script.

---

## Merge strategy (high level)

```
                  ┌──────────────────────────────────┐
                  │  Three raw CSVs in data/raw/     │
                  └─────────────┬────────────────────┘
                                │
            ┌───────────────────┼───────────────────┐
            ▼                   ▼                   ▼
   normalise schema    normalise schema    normalise schema
   (maharshipandya)    (joebeachcapital)   (rodolfofigueroa)
            │                   │                   │
            │                   │            extract unique
            │                   │            artist_ids
            │                   │                   │
            │                   │                   ▼
            │                   │      Spotify /artists?ids=...
            │                   │      (batched, resumable)
            │                   │                   │
            │                   │      artist_id → [genres]
            │                   │                   │
            │                   │            join on artist
            │                   │                   │
            │                   ▼                   ▼
            └───────────► UNION on track_id ◄───────┘
                          (dedup, keep best genre)
                                │
                                ▼
                  data/processed/music_merged.csv
                                │
                                ▼
                    Bulk INSERT into MySQL `music`
```

Genre preference rule when the same `track_id` is present in multiple sources:

```
maharshipandya.track_genre   (most specific, 125 genres)
    > joebeachcapital.playlist_subgenre  (24 sub-genres)
    > joebeachcapital.playlist_genre     (6 broad genres)
    > rodolfofigueroa + artist enrichment (artist-level Spotify genres)
    > NULL  (very rare; tracks with unknown-artist genres)
```

We do **not** mix genres across sources. Each track ends up with a single genre string from the highest-priority source that has it.

---

## Unified schema (output of merge)

The merged CSV (`data/processed/music_merged.csv`) and the MySQL `music` table use this schema:

| Column | Type | Notes |
|---|---|---|
| `track_id` | VARCHAR(22) PK | Spotify base-62 track ID, always 22 characters |
| `track_name` | VARCHAR(500) | Title; some titles are long (remix/feat. parentheticals) |
| `artists` | VARCHAR(500) | Semicolon-joined artist names if multiple |
| `artist_ids` | VARCHAR(500) | Semicolon-joined Spotify artist IDs; from datasets 1 and 3 (dataset 2 lacks artist_ids — fall back to looking them up via name when needed) |
| `album_name` | VARCHAR(500) | NULL if not provided by any source |
| `genre` | VARCHAR(100) | Final resolved genre per the priority rule above; NULL if unresolved |
| `genre_source` | ENUM | `mh`, `jbc_sub`, `jbc`, `artist`, NULL — for traceability |
| `valence` | FLOAT | 0.0–1.0 |
| `energy` | FLOAT | 0.0–1.0 |
| `tempo` | FLOAT | BPM; typical range 40–220 |
| `popularity` | INT | 0–100 |
| `duration_ms` | INT | |
| `release_year` | INT | NULL if unknown |

Indexes (created by the seed script):
- PRIMARY KEY (`track_id`)
- INDEX on `(valence, energy, tempo)` — the recommendation query's hot path
- INDEX on `genre`
- INDEX on `popularity` (for optional popularity-weighted sampling later)

See `docs/DATABASE.md` for full schema DDL.

---

## Stage 1 — Download

`scripts/download_datasets.py`:

```python
"""
Download the three source datasets into data/raw/.
Idempotent: skips already-downloaded files.
Requires KAGGLE_USERNAME and KAGGLE_KEY in environment for datasets 2 and 3.
Dataset 1 has an HF mirror, so it can be downloaded without Kaggle credentials.
"""
```

Concrete instructions for the maintainer (printed by the script if creds missing):
1. `pip install kaggle huggingface_hub`
2. Get a Kaggle API token from kaggle.com/settings/account → "Create New Token". Place `kaggle.json` in `~/.kaggle/`.
3. Run `python scripts/download_datasets.py`.

Output files:
- `data/raw/maharshipandya_spotify_tracks.csv`
- `data/raw/joebeachcapital_30k_songs.csv`
- `data/raw/rodolfofigueroa_12m_songs.csv`

---

## Stage 2 — Normalise each dataset to the unified schema

`scripts/normalise_datasets.py` runs three sub-functions, one per source. Each produces an intermediate CSV in `data/processed/`.

### maharshipandya → `mh_normalised.csv`

```python
def normalise_maharshipandya(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "track_id": df["track_id"],
        "track_name": df["track_name"],
        "artists": df["artists"],                  # already ;-separated in source
        "artist_ids": pd.NA,                       # not present; fill via lookup if needed
        "album_name": df["album_name"],
        "genre": df["track_genre"],
        "genre_source": "mh",
        "valence": df["valence"],
        "energy": df["energy"],
        "tempo": df["tempo"],
        "popularity": df["popularity"],
        "duration_ms": df["duration_ms"],
        "release_year": pd.NA,
    })
```

### joebeachcapital → `jbc_normalised.csv`

```python
def normalise_joebeachcapital(df: pd.DataFrame) -> pd.DataFrame:
    # 1. Deduplicate on track_id, keeping the row with highest popularity
    df = df.sort_values("track_popularity", ascending=False).drop_duplicates("track_id")

    # 2. Prefer playlist_subgenre when available, else playlist_genre
    genre = df["playlist_subgenre"].fillna(df["playlist_genre"])
    genre_source = df["playlist_subgenre"].notna().map(
        lambda has_sub: "jbc_sub" if has_sub else "jbc"
    )

    return pd.DataFrame({
        "track_id": df["track_id"],
        "track_name": df["track_name"],
        "artists": df["track_artist"],
        "artist_ids": pd.NA,
        "album_name": df["track_album_name"],
        "genre": genre,
        "genre_source": genre_source,
        "valence": df["valence"],
        "energy": df["energy"],
        "tempo": df["tempo"],
        "popularity": df["track_popularity"],
        "duration_ms": df["duration_ms"],
        "release_year": pd.to_datetime(df["track_album_release_date"], errors="coerce").dt.year,
    })
```

### rodolfofigueroa → `rf_normalised.csv`

```python
def normalise_rodolfofigueroa(df: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame({
        "track_id": df["id"],
        "track_name": df["name"],
        "artists": df["artists"],
        "artist_ids": df["artist_ids"],    # present here — critical for enrichment
        "album_name": df["album"],
        "genre": pd.NA,                    # to be filled in stage 3
        "genre_source": pd.NA,
        "valence": df["valence"],
        "energy": df["energy"],
        "tempo": df["tempo"],
        "popularity": df["popularity"],
        "duration_ms": df["duration_ms"],
        "release_year": pd.to_numeric(df["year"], errors="coerce"),
    })
```

**Important on `artists` and `artist_ids` format:** rodolfofigueroa stores these as **Python list string literals** (e.g. `"['Drake', 'Future']"`, `"['3TVXtAsR1Inumwj472S9r4', '1RyvyyTE3xzB2ZywiAwp0i']"`). Parse with `ast.literal_eval` defensively, then join with `;` for consistency with the other sources.

```python
import ast
def parse_list_str(s):
    try:
        return ";".join(ast.literal_eval(s))
    except (ValueError, SyntaxError):
        return s  # fallback: leave as-is
```

---

## Stage 3 — Artist-genre enrichment (rodolfofigueroa only)

`scripts/enrich_artist_genres.py`. This is the long-running one.

### Strategy

1. Extract all unique `artist_id` values from `rf_normalised.csv` (~400k unique artists from 1.2M tracks).
2. Skip artist IDs that are already present in `data/processed/artist_genres.csv` (from a previous run).
3. Batch the remaining IDs into groups of 50 (Spotify's batch limit for `/artists`).
4. For each batch:
   - Call `GET https://api.spotify.com/v1/artists?ids=<comma-separated>`.
   - On 200 OK: parse the `artists` array; for each, append `(artist_id, ";".join(genres), name, popularity)` to the output buffer.
   - On 429 Too Many Requests: read `Retry-After` header, `time.sleep(retry_after_seconds + 1)`, retry the same batch.
   - On 5xx: exponential backoff, max 5 retries, then log and skip.
   - On 4xx other than 429: log and skip.
5. Every 100 batches (= 5,000 artists), flush the buffer to disk by appending to `data/processed/artist_genres.csv`. This is the checkpoint — if the script crashes, restarting it picks up from the last flushed point because of step 2.
6. After all batches complete: deduplicate the output CSV (in case of overlapping appends).

### Auth for enrichment

This script needs **Client Credentials Flow** (server-to-server, no user OAuth) because it's only reading public artist metadata. Use `spotipy.SpotifyClientCredentials`:

```python
from spotipy import Spotify
from spotipy.oauth2 import SpotifyClientCredentials

sp = Spotify(client_credentials_manager=SpotifyClientCredentials(
    client_id=os.environ["SPOTIPY_CLIENT_ID"],
    client_secret=os.environ["SPOTIPY_CLIENT_SECRET"],
))
```

Set credentials via the same `.env` used by the main app (or a separate one — either works).

### Rate limiting reality check

- Spotify's documented limit: ~180 requests per 30-second rolling window per app (estimate; not officially published).
- With batching at 50 artists/request: 180 batches/30 s × 50 = 9,000 artists/30 s = 18,000/min.
- 400k unique artists / 18,000 per minute = ~22 minutes theoretical minimum.
- **Realistic with backoff, retries, and 429s:** 2–6 hours.

The 15-hour estimate from earlier planning was based on non-batched calls. With batching, this is much faster.

### Resumability

The script must be killable and restartable. Implementation:

```python
def load_done_artist_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return set(pd.read_csv(path, usecols=["artist_id"])["artist_id"])

def main():
    all_artists = extract_unique_artist_ids("data/processed/rf_normalised.csv")
    done = load_done_artist_ids("data/processed/artist_genres.csv")
    todo = [a for a in all_artists if a not in done]
    print(f"{len(done)} already enriched, {len(todo)} remaining")
    enrich_batched(todo, output_path="data/processed/artist_genres.csv")
```

CLI behaviour:
- `python scripts/enrich_artist_genres.py` → resume from last checkpoint.
- `python scripts/enrich_artist_genres.py --force` → ignore existing checkpoint, start over.
- Press Ctrl+C → finish the current batch, flush, exit cleanly. (Trap SIGINT.)

### Output format

`data/processed/artist_genres.csv`:

| Column | Type | Notes |
|---|---|---|
| `artist_id` | string | Spotify artist ID, 22 chars |
| `genres` | string | `;`-joined; empty string if Spotify returns `[]` |
| `name` | string | For debugging; not used by merge |
| `popularity` | int | For debugging |
| `enriched_at` | ISO timestamp | For audit |

### What if an artist has no genres?

Spotify returns `genres: []` for many artists (especially obscure ones). We store an empty string. Downstream, tracks whose artists all have empty genres get `genre = NULL` in the final table. The recommender treats NULL-genre tracks as eligible for any emotion (no genre filtering applied to them).

### Resolving rodolfofigueroa tracks to a single genre

A track usually has multiple artists, each with multiple genres. Resolution rule for each track:

```python
def resolve_track_genre(artist_ids: list[str], artist_genre_map: dict[str, list[str]]) -> str | None:
    # Collect all genres from all artists on this track
    all_genres: list[str] = []
    for aid in artist_ids:
        all_genres.extend(artist_genre_map.get(aid, []))
    if not all_genres:
        return None
    # Pick the most common; ties broken by first-seen order
    from collections import Counter
    return Counter(all_genres).most_common(1)[0][0]
```

Document this in the report — it's a known simplification. A more sophisticated approach would weight by primary artist or use the union as a tag set, but for capstone scope, "most common single genre" is defensible.

---

## Stage 4 — Union and dedupe

`scripts/merge_catalogues.py`:

```python
def merge():
    mh  = pd.read_csv("data/processed/mh_normalised.csv")
    jbc = pd.read_csv("data/processed/jbc_normalised.csv")
    rf  = pd.read_csv("data/processed/rf_normalised.csv")

    artist_map = load_artist_genre_map("data/processed/artist_genres.csv")
    rf["genre"] = rf["artist_ids"].apply(
        lambda ids: resolve_track_genre(ids.split(";") if pd.notna(ids) else [], artist_map)
    )
    rf["genre_source"] = rf["genre"].notna().map(lambda has: "artist" if has else pd.NA)

    # Concatenate in priority order; drop_duplicates keeps the FIRST occurrence
    combined = pd.concat([mh, jbc, rf], ignore_index=True)
    combined = combined.drop_duplicates(subset="track_id", keep="first")

    # Basic sanity filters
    combined = combined[
        combined["valence"].between(0, 1)
        & combined["energy"].between(0, 1)
        & combined["tempo"].between(20, 250)  # absurd values get dropped
    ]
    combined = combined[combined["track_id"].str.len() == 22]  # valid Spotify IDs

    combined.to_csv("data/processed/music_merged.csv", index=False)
    print(f"Final catalogue: {len(combined)} tracks")
```

**Expected outcome:** ~1.2M tracks. Most come from rodolfofigueroa; the maharshipandya and joebeachcapital contributions mainly add **better genres** for the ~120k tracks they overlap on.

### Why `keep="first"` matters

The `pd.concat` order — `[mh, jbc, rf]` — encodes priority. When two sources have the same `track_id`, `drop_duplicates(keep="first")` keeps the one from the earlier-listed (higher-priority) DataFrame. This implements the genre priority rule from the merge strategy section without any extra logic.

### Dedup verification

After merging, the script should print:

```
Source contributions:
  mh:     114,000 rows → kept 114,000 (100.0%)
  jbc:     23,449 rows → kept ~5,000  (≈21%)  [bulk overlap with mh]
  rf:   1,204,000 rows → kept ~1,070,000 (≈89%)  [overlap with mh and jbc]
Genre coverage:
  mh:           114,000 (100.0%)
  jbc_sub:        4,000   (3.4%)
  jbc:            1,000   (0.8%)
  artist:       980,000 (82.6%)
  NULL:          90,000   (7.5%)
Total: 1,193,000 unique tracks
```

Exact numbers will vary; this is a sanity-check template.

---

## Stage 5 — Bulk import into MySQL

`scripts/seed_database.py`:

1. Create tables per `docs/DATABASE.md`.
2. Bulk-load `music_merged.csv` using `LOAD DATA LOCAL INFILE` (MySQL's fastest path for CSV ingestion):

   ```sql
   LOAD DATA LOCAL INFILE 'data/processed/music_merged.csv'
   INTO TABLE music
   FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"'
   LINES TERMINATED BY '\n'
   IGNORE 1 LINES
   (track_id, track_name, artists, artist_ids, album_name, genre, genre_source,
    valence, energy, tempo, popularity, duration_ms, release_year);
   ```

   Requires `local_infile=1` in MySQL config and the client connection.

3. Insert `emotion_music_mapping` seed rows (see `docs/RECOMMENDATION.md` for the values).

4. Build indexes **after** the bulk insert (much faster than maintaining indexes during insert):

   ```sql
   CREATE INDEX idx_va_e_t ON music (valence, energy, tempo);
   CREATE INDEX idx_genre ON music (genre);
   CREATE INDEX idx_popularity ON music (popularity);
   ```

Expected DB size after import: ~600–800 MB.

---

## Operational notes

### Disk usage

| File | Approx size |
|---|---|
| 3 raw CSVs | ~300 MB |
| 3 normalised CSVs | ~280 MB |
| `artist_genres.csv` | ~30 MB |
| `music_merged.csv` | ~250 MB |
| **All under `data/`** | **~860 MB** |
| MySQL data dir (after import) | ~700 MB |

`data/raw/` and `data/processed/` are gitignored. Only `data/seed/emotion_music_mapping.sql` (a few KB) is committed.

### Re-running

The pipeline is idempotent:
- `download_datasets.py` skips existing files.
- `normalise_datasets.py` overwrites its outputs.
- `enrich_artist_genres.py` resumes from checkpoint.
- `merge_catalogues.py` overwrites `music_merged.csv`.
- `seed_database.py` drops and recreates tables. **This destroys user playlists too — see warning in the script.**

For partial rebuilds (e.g. re-enrich because Spotify added new genres), the script supports a `--force` flag that ignores checkpoints.

### Backup before seeding

Before running `seed_database.py` on a non-empty DB:

```bash
mysqldump --user=<u> --password emotion_music > backup_$(date +%Y%m%d).sql
```

The script should print a warning and require a `--confirm` flag if the `music` table is non-empty.

---

## Known data-quality caveats

Worth disclosing in the capstone report:

1. **All Spotify-derived audio features are model outputs**, not ground truth. Spotify's `valence`/`energy`/`tempo` come from a proprietary classifier (originally Echo Nest). They're internally consistent but unvalidated against listener ratings.

2. **All three datasets snapshot pre-November 2024.** New releases from late 2024 onward are missing. Disclose this in the methodology section.

3. **Genre taxonomies are not unified.** maharshipandya's 125-genre taxonomy uses Spotify's own micro-genre system (e.g. "k-pop", "anime", "deep-house"). Artist genres from `/artists` use a different (overlapping) taxonomy. We do **not** collapse these to a unified ontology; downstream uses raw strings. If the recommender needs to filter by genre category (a future feature), add a `genre_category` column with a hand-built mapping then.

4. **Western/English bias.** All three datasets over-represent English-language Western pop. K-pop, J-pop, and Latin music are present but underrepresented. This is a known limitation of Spotify's catalogue at the snapshot time and cannot be fixed without a separate data source.

5. **Some genres are weak emotional signals.** E.g. "indie", "alternative", "world" span the entire valence/energy space. The genre column is metadata for display, not a recommendation filter (the recommender uses valence/energy/tempo, not genre). See `docs/RECOMMENDATION.md`.

6. **Duplicate tracks across remasters/regions.** A song reissued or released regionally may have multiple Spotify `track_id`s with very similar audio features. We do **not** dedupe by `(track_name, artists)` — the user may see two near-identical entries in a playlist. Acceptable for capstone scope.

---

## Related docs

- `docs/DATABASE.md` — schema for the `music` table.
- `docs/RECOMMENDATION.md` — how the catalogue is queried.
- `docs/SPOTIFY_INTEGRATION.md` — Spotify auth for the enrichment script.
- `docs/BUILD_PLAN.md` — when in CP2 this data preparation runs.
