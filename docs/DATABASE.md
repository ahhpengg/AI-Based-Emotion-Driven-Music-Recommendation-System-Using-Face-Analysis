# docs/DATABASE.md

MySQL schema, seed data, and conventions for the local catalogue database.

The database is local (single-user, single-machine). No replication, no multi-tenancy, no migrations framework. Schema changes go through versioned SQL files in `src/db/migrations/`, applied in order.

---

## Connection

- **Engine:** MySQL 8.x.
- **Database name:** `emotion_music`.
- **Charset:** `utf8mb4` (covers song titles in non-Latin scripts: K-pop hangul, J-pop kana, etc.). Collation `utf8mb4_unicode_ci`.
- **Connection from Python:** `mysql-connector-python` (official, sync) — preferred over `PyMySQL` for binary protocol speed on bulk reads.

Credentials live in `.env`:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=emotion_music
DB_PASSWORD=<set-locally>
DB_NAME=emotion_music
```

A `.env.example` ships with placeholders; the real `.env` is gitignored.

### Connection pool

The app uses a small connection pool (size 4) — enough for a single-user app, generous for any background queries:

```python
# src/db/connection.py
from mysql.connector.pooling import MySQLConnectionPool

_pool = MySQLConnectionPool(
    pool_name="emotion_music_pool",
    pool_size=4,
    host=..., port=..., user=..., password=..., database="emotion_music",
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
    valence       FLOAT        NOT NULL,
    energy        FLOAT        NOT NULL,
    tempo         FLOAT        NOT NULL,
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

### Size estimate

Approx 600–800 MB for ~1.2M rows including indexes.

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
    source_emotion VARCHAR(20)  DEFAULT NULL,   -- which emotion produced this playlist; NULL for user-created
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id),
    INDEX idx_playlist_emotion (source_emotion),
    INDEX idx_playlist_updated (updated_at DESC)
) ENGINE=InnoDB CHARSET=utf8mb4;
```

### Naming convention

System-generated playlists default to a name like `"Happy — 2026-05-14 14:30"`. The user can rename.

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

The `music` table is treated as immutable (we never delete catalogue tracks at runtime). The FK is declared without `ON DELETE` action so the default (RESTRICT) protects against accidental deletes. If a future data refresh removes a track, the resulting FK violation is exactly the loud failure we want.

---

## View: `v_in_scope_music`

A convenience view filtering the catalogue to tracks that have all the data needed for emotion-based recommendation. Used by the recommender to keep its SQL simple.

```sql
CREATE OR REPLACE VIEW v_in_scope_music AS
SELECT track_id, track_name, artists, album_name, genre,
       valence, energy, tempo, popularity, duration_ms
FROM music
WHERE valence IS NOT NULL
  AND energy  IS NOT NULL
  AND tempo   IS NOT NULL
  AND tempo BETWEEN 20 AND 250;
```

(The hard filtering is also done at merge time, so this view is mostly defensive.)

---

## Migrations

Simple convention — no Alembic, no Flyway. Numbered SQL files run in order:

```
src/db/migrations/
├── 0001_initial_schema.sql
├── 0002_emotion_mapping_seed.sql
├── 0003_indexes.sql
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
SELECT track_id, track_name, artists, genre, valence, energy, tempo
FROM music
WHERE valence BETWEEN :v_min AND :v_max
  AND energy  BETWEEN :e_min AND :e_max
  AND tempo   BETWEEN :t_min AND :t_max
LIMIT 1000;
```

`EXPLAIN` should show `idx_music_vet` used with `range` access. If not, check that the index exists; rebuild if necessary.

The recommender then randomly samples N tracks from this 1000-row candidate pool in Python. Doing the random sampling in SQL with `ORDER BY RAND()` is **forbidden** — it's O(N) over the candidate set and disastrous at 1.2M rows even with the WHERE clause.

### Save a generated playlist

```sql
INSERT INTO playlist (name, source_emotion) VALUES (?, ?);
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
ORDER BY updated_at DESC
LIMIT 50;
```

---

## Backup and recovery

For capstone scope: no automated backups. The data is reproducible from the dataset CSVs.

Manual backup before any risky operation (re-seeding, schema change in a new migration):

```bash
mysqldump --user=emotion_music --password \
          --single-transaction --quick \
          emotion_music \
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
