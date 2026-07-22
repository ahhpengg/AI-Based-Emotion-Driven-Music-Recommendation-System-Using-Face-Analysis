# docs/DATABASE.md

MySQL schema, seed data, and conventions for the local catalogue database.

The database is local (single-user, single-machine). No replication, no multi-tenancy, no migrations framework. Schema changes go through versioned SQL files in `src/db/migrations/`, applied in order.

---

## Connection

- **Engine:** MySQL 8.x.
- **Database name:** `echosoul`.
- **Charset:** `utf8mb4` (covers song titles in non-Latin scripts: K-pop hangul, J-pop kana, etc.). Collation `utf8mb4_unicode_ci`.
- **Connection from Python:** `mysql-connector-python` (official, sync) — preferred over `PyMySQL` for binary protocol speed on bulk reads.

Credentials live in `.env`:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=echosoul
DB_PASSWORD=<set-locally>
DB_NAME=echosoul
```

A `.env.example` ships with placeholders; the real `.env` is gitignored.

### Connection pool

The app uses a small connection pool (size 4) — enough for a single-user app, generous for any background queries:

```python
# src/db/connection.py
from mysql.connector.pooling import MySQLConnectionPool

_pool = MySQLConnectionPool(
    pool_name="echosoul_pool",
    pool_size=4,
    host=..., port=..., user=..., password=..., database="echosoul",
    charset="utf8mb4", collation="utf8mb4_unicode_ci",
    autocommit=False,
)
```

Use a context manager wrapper for safe acquire/release.

---

## Schema overview

Four tables, one view:

```
music                     ← ≈1.2M rows, the merged catalogue (read-mostly)
emotion_music_mapping     ← 5 rows, the recommendation rule table (read-only)
playlist                  ← user playlists
playlist_song             ← M:N between playlist and music
v_in_scope_music          ← view: music filtered to tracks that are recommendable
```

---

## Table: `music`

The 1.2M-track catalogue from the dataset merge.

```sql
CREATE TABLE music (
    track_id      VARCHAR(22)  NOT NULL,
    track_name    VARCHAR(500) NOT NULL,
    artists       VARCHAR(500) NOT NULL,
    artist_ids    VARCHAR(500) DEFAULT NULL,
    album_name    VARCHAR(500) DEFAULT NULL,
    genre         VARCHAR(100) DEFAULT NULL,
    genre_source  ENUM('mh','jbc_sub','jbc','artist') DEFAULT NULL,
    canonical_genre VARCHAR(50) DEFAULT NULL,   -- normalised genre bucket (migration 0009)
    valence       FLOAT        DEFAULT NULL,   -- NULL = external track (migration 0008)
    energy        FLOAT        DEFAULT NULL,
    tempo         FLOAT        DEFAULT NULL,
    popularity    TINYINT UNSIGNED DEFAULT NULL,
    duration_ms   INT UNSIGNED DEFAULT NULL,
    release_year  SMALLINT UNSIGNED DEFAULT NULL,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (track_id)
) ENGINE=InnoDB CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### Indexes

Created **after** bulk insert (much faster than maintaining them during insert):

```sql
-- Hot path: recommendation queries filter on these three columns together
CREATE INDEX idx_music_vet ON music (valence, energy, tempo);

-- Display/filter by genre (also used by stats / debugging)
CREATE INDEX idx_music_genre ON music (genre);

-- Optional popularity-weighted sampling (not used yet, indexed for future)
CREATE INDEX idx_music_popularity ON music (popularity);
```

**Why a composite index on `(valence, energy, tempo)` instead of three single-column indexes?**

The recommendation query (`docs/RECOMMENDATION.md`) is always a 3-range AND:

```sql
WHERE valence BETWEEN ? AND ? AND energy BETWEEN ? AND ? AND tempo BETWEEN ? AND ?
```

MySQL can use a composite index to seek to the first matching `valence`, then scan forward, applying the `energy` and `tempo` predicates as it goes. With three separate indexes, MySQL would pick one and ignore the others — slower for range queries on multiple columns.

The order `valence, energy, tempo` is chosen because valence has the tightest user-perceptible discrimination (people notice "happy songs vs sad songs" more than tempo differences within a mood).

### Column notes

- **`track_id` is 22 chars exactly** — Spotify's base-62 IDs are deterministic length. Constrained to catch malformed imports.
- **`artists` is a `;`-separated list** when there are multiple artists. We do **not** normalise into a separate `artist` table; the recommendation system never needs to query "all tracks by artist X" in scope. If a future feature requires it, add an `artist` table then.
- **`genre` is a single string** chosen by the merge process. Not a list. See `docs/MUSIC_DATA.md` for the resolution rule.
- **`popularity` is `TINYINT UNSIGNED`** (0–255) instead of `INT` because values are always 0–100. Saves space at 1.2M rows.
- **`valence` and `energy` are `FLOAT`** (4 bytes) not `DOUBLE`. The precision (~7 decimal digits) far exceeds Spotify's own granularity (2–3 significant digits in practice).
- **`valence`/`energy`/`tempo` are nullable** (migration 0008) to allow *external tracks* — see below. Every merged-catalogue row has all three; only runtime-inserted rows are NULL.

### External tracks (migration 0008)

The bottom player's add-to-playlist button works on **whatever Spotify is
playing**, which the user can have queued from their own Spotify apps — i.e. a
song that is not in the merged catalogue at all. Because `playlist_song` has an
FK into `music`, such a song is stored at add-time as a **feature-less `music`
row** built from the player's own metadata (`track_name`, `artists` ;-joined,
`album_name`, `duration_ms`; everything else NULL), inserted in the same
transaction as the playlist rows (`playlists.add_track_to_playlists`,
`track_meta` parameter — only the player path sends it; header-search rows are
catalogue tracks by construction). If every target playlist vanished while the
popup was open, the stub is deleted before commit so no orphan row lingers.

Consequences, all deliberate:

- **Playable from playlists like any other row** — playback only needs the
  Spotify `track_id`.
- **Never emotion-recommended** — the recommender's `BETWEEN` predicates and
  `v_in_scope_music` both exclude NULL features.
- **Findable in the header search** — the `music` FULLTEXT index picks the row
  up automatically (tier-2 relevance order; the popularity hot tier is
  untouched). If it can live in your playlists, search should find it.

### Canonical genre (migration 0009)

`genre` is a raw Last.fm/dataset tag — a folksonomy with **3,994 distinct
values** full of synonyms (`c-pop` / `mandopop` / `chinese`), spelling variants
(`hip-hop` / `hip hop` / `hiphop`), nationality and instrument tags, and junk
(`all`, `canadian`, artist names). Unusable directly for a user-facing genre
filter. `canonical_genre` normalises it into a **23-bucket vocabulary**
(Pop, Rock, Indie / Alternative, Metal, Punk / Hardcore, Hip-Hop / Rap,
R&B / Soul, Electronic / Dance, Jazz, Blues, Classical, Country,
Folk / Acoustic, Latin, Reggae, World, K-Pop, J-Pop / Anime, C-Pop / Mandopop,
SEA Pop, Soundtrack / Musical, Ambient / Instrumental, Christian / Gospel).

- **Source of truth:** `data/seed/genre_canonical_map.csv` — one row per raw
  tag observed in the catalogue: `raw_genre, canonical_genre, layer, note`.
  `layer` records how the decision was made: `exact` (hand decision), `rule`
  (keyword match), `junk` (deliberately excluded — mood/meta/nationality tags
  with no genre signal), `unmapped` (no decision; tail noise). Junk and
  unmapped rows have an empty `canonical_genre` and stay NULL. The mapping was
  drafted mechanically, then owner-reviewed 2026-07-18 (the flagged judgment
  calls are recorded in the `note` column) — cite it in the report as
  rule-based, owner-curated normalisation.
- **Backfill:** `scripts/apply_genre_mapping.py` (idempotent: resets the
  column, then applies the CSV per raw tag via `idx_music_genre`).
- **Coverage** (at mapping time): 88.1% of genre-labelled rows mapped to a
  bucket, 7.5% junk, 4.4% unmapped; plus the 10.9% of the catalogue with
  `genre IS NULL`, which stays NULL here too (external tracks included).
- **Semantics:** a genre-filtered recommendation query adds
  `AND canonical_genre IN (...)`, so NULL rows simply never match a filter —
  they remain reachable when no filter is active. Backed by
  `idx_music_canonical_genre` (single column; the genre-filtered hot-path
  index shape is decided with the recommender change, not here).
- **Derived data:** like `music_search_hot`, the column is a projection of
  committed inputs. If the catalogue is re-seeded or the mapping CSV is
  edited, re-run the backfill script.

### Size estimate

Approx 600–800 MB for ~1.2M rows including indexes.

### Random sampling key (migration 0004)

`sample_key` is a **stored generated column** giving every track a fixed, uniform
value in `[0, 1)` derived from `track_id`:

```sql
sample_key DOUBLE
    AS (CONV(SUBSTRING(MD5(track_id), 1, 8), 16, 10) / 4294967295) STORED
```

It lets the recommender pull a *random, representative* slice of an emotion's
candidate pool instead of the biased low-valence slice an unordered `LIMIT`
returns (see `docs/RECOMMENDATION.md` Step 3). Derived from `track_id` rather
than `RAND()` because:

- **Deterministic → binlog-safe.** MySQL rejects `RAND()` in DDL/DML on a
  binlogged table (`ER_BINLOG_UNSAFE_SYSTEM_FUNCTION`, error 1674); an MD5 of an
  existing column is safe.
- **Uniform and uncorrelated** with valence/energy/tempo — Spotify assigns
  `track_id` independently of audio features — so any `sample_key` window is a
  representative sample of the emotion's set.
- **Generated**, so it is computed for existing and future rows automatically and
  cannot be inserted into; the seed script needs no change.

Backed by a composite index tuned for the hot-path query:

```sql
CREATE INDEX idx_music_sample_vet ON music (sample_key, valence, energy, tempo);
```

`sample_key` leads (for the random-start range scan, and so `ORDER BY sample_key`
is served natively with no filesort); the three filter columns follow so they are
applied by index-condition pushdown, keeping table lookups to the ~1000 rows kept.
The recommender pins this index with `FORCE INDEX` because the optimizer otherwise
misreads the wide `sample_key >= s` range as a full scan.

### Track search (migrations 0006 + 0007)

The header search bar (`src/music/search.py`, `frontend/js/search.js`) does
word-prefix matching on title + artists, most popular first. Two migrations
back it:

```sql
-- 0006: FULLTEXT over the full catalogue (tier-2 fallback)
ALTER TABLE music ADD FULLTEXT INDEX ft_music_search (track_name, artists);

-- 0007: the "hot tier" — a denormalised copy of the ~116k rows (of 1.31M)
-- that carry a popularity value, with its own FULLTEXT index
CREATE TABLE music_search_hot (
    track_id      VARCHAR(22)      NOT NULL,
    track_name    VARCHAR(500)     NOT NULL,
    artists       VARCHAR(500)     NOT NULL,
    album_name    VARCHAR(500)     DEFAULT NULL,
    duration_ms   INT UNSIGNED     DEFAULT NULL,
    popularity    TINYINT UNSIGNED NOT NULL,
    PRIMARY KEY (track_id)
) ...;  -- populated by INSERT..SELECT FROM music WHERE popularity IS NOT NULL
```

**Why a second table?** `ORDER BY popularity` over a FULLTEXT match forces
MySQL to fetch **every** matching row to read `popularity` — 34k–97k random
row fetches for a broad prefix like `love*` on a table far bigger than the
default InnoDB buffer pool. Measured: 3–9 s per query; unusable for
as-you-type search. Only rows with a non-NULL popularity can ever appear in
popularity order (NULL sorts last), so the hot tier contains exactly that
slice — small enough that the same query answers in tens of ms. When the hot
tier can't fill the requested limit, `search_tracks` tops up from the `music`
FULLTEXT index ordered **by relevance** (`ORDER BY MATCH(...) DESC LIMIT n`),
which uses InnoDB's early-terminating rank-sort path and never materialises
the match set. The tracks only reachable there have no popularity data, so
best-text-match is the honest order for them.

Query semantics (`_boolean_query`): user text becomes `+word1* +word2*` in
BOOLEAN MODE — every word required, each matched as a word prefix. Boolean
operators are stripped from input. Two caveats, both inherent to InnoDB FTS
with the default parser:

- **Words shorter than `innodb_ft_min_token_size` (default 3) are not
  indexed.** Short *non-final* tokens are dropped from the query ("7 rings" →
  `+rings*`) because a required unindexable word would veto everything; the
  final token is kept at any length since it's a still-being-typed prefix
  ("lo*" matches "love"). A title made *only* of short words ("22") is not
  findable — accepted limitation, not worth a server-config change.
- **CJK titles don't tokenise** with the default parser (would need an ngram
  FULLTEXT index). The catalogue is overwhelmingly Latin-script; accepted.

**Derived data:** `music_search_hot` is a copy, not a source. If the music
catalogue is ever re-seeded, rebuild it (`TRUNCATE` + re-run the 0007 INSERT).

---

## Table: `emotion_music_mapping`

The 5-row rule table that defines what valence/energy/tempo ranges constitute each emotion's music. Seeded once; effectively read-only at runtime.

```sql
CREATE TABLE emotion_music_mapping (
    emotion       VARCHAR(20) NOT NULL,
    valence_min   FLOAT       NOT NULL,
    valence_max   FLOAT       NOT NULL,
    energy_min    FLOAT       NOT NULL,
    energy_max    FLOAT       NOT NULL,
    tempo_min     FLOAT       NOT NULL,
    tempo_max     FLOAT       NOT NULL,
    description   VARCHAR(255) DEFAULT NULL,
    PRIMARY KEY (emotion)
) ENGINE=InnoDB CHARSET=utf8mb4;
```

### Seed data

Values derived from the CP1 planning doc §3.10, Table 13. Stored in `data/seed/emotion_music_mapping.sql`:

```sql
INSERT INTO emotion_music_mapping
    (emotion, valence_min, valence_max, energy_min, energy_max, tempo_min, tempo_max, description)
VALUES
    ('happy',     0.66, 1.00, 0.66, 1.00, 120.0, 250.0,
        'High valence, high energy, fast tempo — upbeat positive music'),
    ('surprised', 0.66, 1.00, 0.66, 1.00, 120.0, 250.0,
        'Same target as happy — both are positive high-arousal emotions'),
    ('sad',       0.00, 0.34, 0.00, 0.34,  20.0,  90.0,
        'Low valence, low energy, slow tempo — melancholic music'),
    ('angry',     0.00, 0.34, 0.66, 1.00, 120.0, 250.0,
        'Low valence, high energy, fast tempo — intense / aggressive music'),
    ('neutral',   0.34, 0.66, 0.34, 0.66,  90.0, 120.0,
        'Moderate on all dimensions — balanced / ambient music');
```

### Why surprised maps to the same target as happy

Both sit in the high-valence / high-arousal quadrant of Russell's Circumplex (CP1 §2.2.2.2). Distinct *emotionally*, but musical correlates overlap heavily. If user testing in CP2 shows users want differentiation (e.g. surprised → more eclectic genre mix), this is the place to tweak — change the rule table, not the code.

### Why tempo ranges are open on the high end at 250

Some legitimate fast tracks exceed 200 BPM (drum & bass, hardcore). The `tempo_max = 250` is a sanity ceiling above which we assume the value is garbage data, not a real measurement. The merge step in `docs/MUSIC_DATA.md` already filters `tempo BETWEEN 20 AND 250`, so this ceiling is redundant in practice — included for clarity.

---

## Table: `playlist`

User-saved playlists. Both system-generated (from emotion detection) and user-created are stored here.

```sql
CREATE TABLE playlist (
    playlist_id    INT          NOT NULL AUTO_INCREMENT,
    name           VARCHAR(200) NOT NULL,
    description    VARCHAR(500) DEFAULT NULL,   -- user-editable; NULL = no description (migration 0005)
    source_emotion VARCHAR(20)  DEFAULT NULL,   -- which emotion produced this playlist; NULL for user-created
    saved          TINYINT(1)   NOT NULL DEFAULT 1,   -- soft-delete flag; 0 = un-saved/hidden (migration 0011)
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id),
    INDEX idx_playlist_emotion (source_emotion),
    INDEX idx_playlist_updated (updated_at DESC)
) ENGINE=InnoDB CHARSET=utf8mb4;
```

### Naming convention

System-generated playlists default to the result page's per-emotion title (`"Happy Playlist"`, `"Sad Melodies"`, …) with the per-emotion tagline as the default description. There is **no date stamp in the name** — the created date is shown from `created_at` (sidebar subtitle `"25 songs · Jul 12"`, and a `"Created Jul 12"` meta line on the playlist page). The user can edit name and description from the result page (`update_playlist`), which also replaces the track list in the same transaction and bumps `updated_at` explicitly (a tracks-only edit must still float the playlist to the top of the sidebar).

### Soft delete: the `saved` flag (migration 0011)

The result page's bookmark is a reversible toggle, so **un-saving a playlist must not destroy it**. `set_playlist_saved(playlist_id, saved)` flips this flag rather than deleting the row:

- `saved = 1` (the default for every new playlist) — shown in the sidebar. `list_playlists` filters `WHERE saved = 1`.
- `saved = 0` — un-saved: hidden from the sidebar, but the row keeps its `playlist_id`, `created_at` and songs, so re-saving restores the playlist **unchanged** (same id, same created date). `load_playlist` does **not** filter on `saved`, so the result page can keep an un-saved playlist on screen and a page reload (`#playlist=<id>`) still resolves it. Re-saving bumps `updated_at` so the restored playlist floats to the top of the sidebar.

Un-saving is a **deferred hard delete**: it stays reversible only for the session it happened in (the result page is the only thing that could re-save it). `purge_unsaved_playlists()` runs once at app startup (`src/main.py`) and hard-deletes every `saved = 0` row (songs cascade), finalising the removal. This is distinct from `delete_playlist` — the sidebar kebab's **Delete** — which is an immediate, permanent hard delete.

No index backs the `saved` filter: the `playlist` table holds only a single user's own playlists (dozens at most), so the extra `WHERE saved = 1` scans trivially.

---

## Table: `playlist_song`

Many-to-many between playlists and tracks, with explicit ordering.

```sql
CREATE TABLE playlist_song (
    playlist_id    INT          NOT NULL,
    track_id       VARCHAR(22)  NOT NULL,
    position       INT UNSIGNED NOT NULL,  -- 0-based index within the playlist
    added_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id, track_id),
    INDEX idx_ps_position (playlist_id, position),
    FOREIGN KEY (playlist_id) REFERENCES playlist (playlist_id) ON DELETE CASCADE,
    FOREIGN KEY (track_id)    REFERENCES music    (track_id)
) ENGINE=InnoDB CHARSET=utf8mb4;
```

### Why `(playlist_id, track_id)` is the PK, not an autoincrement `id`

- Prevents duplicate adds of the same track to the same playlist (a meaningful constraint).
- Avoids a surrogate-key column that is never referenced.

### Why `position` is a separate column instead of inferred from `added_at`

User reordering is a planned feature. Two tracks added at the same logical moment (during initial playlist creation) all share a `created_at` close enough to be indistinguishable. `position` is the authoritative order; `added_at` is metadata.

### Why no FK from playlist_song.track_id to music.track_id with ON DELETE behaviour?

Catalogue tracks are never deleted at runtime (the only runtime `music` writes are the external-track stub inserts described above, plus the same-transaction removal of a stub whose add turned out to be a no-op — and that row is by construction referenced by no playlist). The FK is declared without `ON DELETE` action so the default (RESTRICT) protects against accidental deletes. If a future data refresh removes a track, the resulting FK violation is exactly the loud failure we want.

---

## View: `v_in_scope_music`

A convenience view filtering the catalogue to tracks that have all the data needed for emotion-based recommendation. Used by the recommender to keep its SQL simple.

```sql
CREATE OR REPLACE VIEW v_in_scope_music AS
SELECT track_id, track_name, artists, album_name, genre, canonical_genre,
       valence, energy, tempo, popularity, duration_ms, sample_key
FROM music
WHERE valence IS NOT NULL
  AND energy  IS NOT NULL
  AND tempo   IS NOT NULL
  AND tempo BETWEEN 20 AND 250;
```

(The hard filtering is also done at merge time for catalogue rows; since migration 0008 the NULL checks additionally exclude runtime-inserted external tracks, which must never be recommended.)

---

## Migrations

Simple convention — no Alembic, no Flyway. Numbered SQL files run in order:

```
src/db/migrations/
├── 0001_initial_schema.sql
├── 0002_emotion_mapping_seed.sql
├── 0003_indexes.sql
├── 0004_sample_key.sql
├── 0005_playlist_description.sql
├── 0006_fulltext_search.sql
├── 0007_search_hot_tier.sql
├── 0008_nullable_audio_features.sql
├── 0009_canonical_genre.sql
├── 0010_genre_sample_index.sql
├── 0011_playlist_saved.sql
└── …
```

A small migrator in `src/db/migrate.py`:

```python
def run_migrations():
    """Run all migrations newer than the highest version recorded
    in the schema_version table. Idempotent."""
    # 1. CREATE TABLE IF NOT EXISTS schema_version (version INT PRIMARY KEY, applied_at TIMESTAMP)
    # 2. SELECT MAX(version) FROM schema_version
    # 3. For each .sql file with version > max: exec, INSERT INTO schema_version
```

Migrations are run at app startup. Failures are fatal (the app refuses to start with a clear error message).

### Migration rules

- **Never edit a committed migration.** If you need to change schema, add a new migration.
- **Migrations are append-only.** They go forward, never backward. (Down-migrations are out of scope for a single-user desktop app.)
- **Bulk data load is not a migration.** `seed_database.py` is a separate script. Migrations create schema; the seed script populates the music catalogue.

---

## Common queries (and their explain-friendly form)

### Recommendation query (hot path)

```sql
SELECT track_id, track_name, artists, album_name, genre,
       valence, energy, tempo, duration_ms
FROM music FORCE INDEX (idx_music_sample_vet)
WHERE valence BETWEEN :v_min AND :v_max
  AND energy  BETWEEN :e_min AND :e_max
  AND tempo   BETWEEN :t_min AND :t_max
  AND sample_key >= :start        -- random start point, chosen in Python
ORDER BY sample_key
LIMIT 1000;
```

`:start` is a random float in `[0, 1)` picked per call, so the 1000-row window is
a random, representative slice of the emotion's set rather than the low-valence
rows an unordered `LIMIT` returns. `EXPLAIN` should show `idx_music_sample_vet`
with `range` access and `Using index condition` — and **no `Using filesort`**
(the filesort is what makes this query seconds-slow; it reappears the moment a
tiebreaker like `ORDER BY sample_key, track_id` is added, because that column is
not in the index). `FORCE INDEX` is required: without it the optimizer misreads
the wide `sample_key` range and picks a full scan. See `docs/RECOMMENDATION.md`
Step 3 for the wrap-around top-up when `:start` lands near 1.0.

The recommender then randomly samples N tracks from this 1000-row candidate pool in Python. Doing the random sampling in SQL with `ORDER BY RAND()` is **forbidden** — it's O(N) over the candidate set and disastrous at 1.2M rows even with the WHERE clause.

### Save a generated playlist

```sql
INSERT INTO playlist (name, description, source_emotion) VALUES (?, ?, ?);
-- Use the returned LAST_INSERT_ID() for the bulk insert below:
INSERT INTO playlist_song (playlist_id, track_id, position) VALUES
    (?, ?, 0), (?, ?, 1), (?, ?, 2), ...;
```

Wrap in a transaction.

### Load a saved playlist

```sql
SELECT m.track_id, m.track_name, m.artists, m.album_name, m.duration_ms, ps.position
FROM playlist_song ps
JOIN music m ON m.track_id = ps.track_id
WHERE ps.playlist_id = ?
ORDER BY ps.position;
```

### List user's playlists for sidebar

```sql
SELECT playlist_id, name, source_emotion, updated_at,
       (SELECT COUNT(*) FROM playlist_song WHERE playlist_id = p.playlist_id) AS track_count
FROM playlist p
WHERE p.saved = 1                 -- hide soft-deleted (un-saved) playlists (migration 0011)
ORDER BY updated_at DESC
LIMIT 50;
```

---

## Backup and recovery

For capstone scope: no automated backups. The data is reproducible from the dataset CSVs.

Manual backup before any risky operation (re-seeding, schema change in a new migration):

```bash
mysqldump --user=echosoul --password \
          --single-transaction --quick \
          echosoul \
          > backup_$(date +%Y%m%d_%H%M%S).sql
```

User playlists are the only non-reproducible data. The seed script warns before destroying them.

---

## Conventions and style

### Naming

- Tables: singular noun (`music`, `playlist`).
- Columns: `snake_case`.
- Primary keys: short — `track_id`, `playlist_id` — not `id`. Makes joins self-documenting.
- Foreign keys: same name as the referenced PK (no `_fk` suffix).
- Indexes: `idx_<table>_<columns>` (e.g. `idx_music_vet`).
- Views: `v_<purpose>`.

### SQL formatting

- Uppercase keywords (`SELECT`, `JOIN`, `WHERE`).
- One clause per line for any statement > 80 chars.
- Trailing commas not allowed (MySQL rejects them).

### Avoid

- `SELECT *` in application code (always list columns — guards against schema changes breaking client code).
- Stored procedures and triggers (none yet; keep it that way unless there's a strong reason).
- Soft deletes (`deleted_at` columns) — not needed for the playlists feature, which is hard-delete.

---

## Related docs

- `docs/MUSIC_DATA.md` — produces the data that lives in `music`.
- `docs/RECOMMENDATION.md` — primary consumer of `music` and `emotion_music_mapping`.
- `docs/ARCHITECTURE.md` — where the DB sits in the stack.
