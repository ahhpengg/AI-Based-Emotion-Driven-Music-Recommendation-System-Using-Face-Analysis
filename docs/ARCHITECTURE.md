# docs/ARCHITECTURE.md

System architecture for the AI-Based Emotion-Driven Music Recommendation System.

This doc is the big-picture overview. For module-level details, follow the cross-references at the end of each section.

---

## High-level diagram (textual)

```
┌──────────────────────────────────────────────────────────────────────┐
│                     User's Personal Computer                          │
│                                                                       │
│   ┌─────────────────┐   ┌──────────────────────────────────────┐    │
│   │   Web Camera    │──▶│  PyWebView Native Window             │    │
│   └─────────────────┘   │  ┌────────────────────────────────┐  │    │
│                         │  │  Frontend (HTML/CSS/JS)        │  │    │
│                         │  │  - Pages: home, photo, mood,   │  │    │
│                         │  │    loading, result, error      │  │    │
│                         │  │  - Spotify Web Playback SDK    │  │    │
│                         │  │    (streams audio)             │  │    │
│                         │  └────────────────┬───────────────┘  │    │
│                         │                   │ JS↔Py bridge      │    │
│                         │  ┌────────────────▼───────────────┐  │    │
│                         │  │  Python Backend (main.py)      │  │    │
│                         │  │  ┌──────────────────────────┐  │  │    │
│                         │  │  │  api/  (bridge methods)  │  │  │    │
│                         │  │  └────────────┬─────────────┘  │  │    │
│                         │  │  ┌────────────▼──────────────┐ │  │    │
│                         │  │  │  fer/                      │ │  │    │
│                         │  │  │  - image_pipeline.py       │ │  │    │
│                         │  │  │  - emotion_model.py        │ │  │    │
│                         │  │  └────────────┬──────────────┘ │  │    │
│                         │  │  ┌────────────▼──────────────┐ │  │    │
│                         │  │  │  music/                    │ │  │    │
│                         │  │  │  - recommender.py          │ │  │    │
│                         │  │  └────────────┬──────────────┘ │  │    │
│                         │  │  ┌────────────▼──────────────┐ │  │    │
│                         │  │  │  spotify/  (OAuth, tokens) │ │  │    │
│                         │  │  └────────────────────────────┘ │  │    │
│                         │  │  ┌────────────────────────────┐ │  │    │
│                         │  │  │  db/  (MySQL connection)   │ │  │    │
│                         │  │  └────────────┬───────────────┘ │  │    │
│                         │  └───────────────┼─────────────────┘  │    │
│                         └──────────────────┼────────────────────┘    │
│                                            │                          │
│   ┌────────────────────────────────────────▼──────────────┐         │
│   │   MySQL 8.x (local)                                    │         │
│   │   - music (≈1.2M tracks)                              │         │
│   │   - emotion_music_mapping (5 rows: rule table)        │         │
│   │   - playlist, playlist_song                           │         │
│   └────────────────────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────┘
                │                                          ▲
                │ OAuth + Web Playback SDK                 │
                ▼                                          │
       ┌─────────────────────────┐                         │
       │  Spotify (cloud)        │─────────────────────────┘
       │  - OAuth endpoint       │   token exchange + audio stream
       │  - /me, /artists        │
       │  - Web Playback SDK CDN │
       └─────────────────────────┘
```

---

## Component responsibilities

### Frontend (HTML/CSS/JS, rendered inside PyWebView)

- Renders the 6 pages: home, photo-taking, manual mood, loading, result, error.
- Captures webcam frames via `navigator.mediaDevices.getUserMedia` (in-browser API; PyWebView's Chromium webview supports it).
- Initialises the Spotify Web Playback SDK after the user's OAuth token is available.
- Calls Python via `pywebview.api.<method>()` for all backend operations.
- Receives playback commands (`play`, `pause`, `next`) directly from the user and routes them through the Web Playback SDK; does **not** round-trip through Python for playback.

See `docs/FRONTEND.md`.

### Python backend

Single PyWebView process. Module layout:

| Module | Responsibility |
|---|---|
| `main.py` | PyWebView app entry point. Constructs the `webview.create_window(...)` call, binds the `api/` bridge object, starts the event loop. |
| `api/` | Methods exposed to JavaScript via the PyWebView bridge. **Thin layer** — each method validates input, calls one or two domain functions, returns JSON-serialisable result. No business logic here. |
| `fer/` | Image preprocessing + emotion classification. Pure functions where possible. Owns the loaded Keras model (singleton, loaded once at startup). |
| `music/` | Recommendation algorithm. Queries `db/`, applies emotion–music mapping rules, returns a list of track IDs. |
| `spotify/` | OAuth flow (Authorization Code with PKCE), token storage, token refresh, Premium account verification. **Does not** play audio — that's the SDK's job in the frontend. |
| `db/` | MySQL connection pool, schema migration runner, raw SQL helpers. Whether to introduce SQLAlchemy is a decision deferred to the build plan; default is raw SQL with `mysql-connector-python`. |

See `docs/FER_MODEL.md`, `docs/IMAGE_PIPELINE.md`, `docs/RECOMMENDATION.md`, `docs/SPOTIFY_INTEGRATION.md`, `docs/DATABASE.md`.

### MySQL database (local)

Four tables:

1. `music` — the merged 3-dataset catalogue (~1.2M rows).
2. `emotion_music_mapping` — 5 rows, one per supported emotion, defining valence/energy/tempo target ranges.
3. `playlist` — user-saved playlists (system-generated or user-created).
4. `playlist_song` — many-to-many between playlists and tracks.

See `docs/DATABASE.md` for the exact schema.

### Spotify cloud services (external)

- **OAuth endpoint** (`accounts.spotify.com`): exchanges the auth code for an access + refresh token.
- **Web API** (`api.spotify.com`): used **only** for `/me` (Premium check) and `/artists?ids=...` (genre enrichment script).
- **Web Playback SDK CDN** (`sdk.scdn.co/spotify-player.js`): loaded by the frontend to instantiate the player.
- **Audio stream**: handled internally by the SDK; we never see the raw audio.

See `docs/SPOTIFY_INTEGRATION.md`.

---

## Data flows

### Flow A: Cold start (first launch after install)

```
User launches app
  → main.py opens PyWebView window pointing at frontend/index.html
  → Frontend checks: is there a stored Spotify refresh token? (asks Python via api.has_spotify_session())
    → No → show login screen, open Spotify auth URL in system browser → user logs in
            → callback received on http://localhost:<port>/callback (handled by Python)
            → tokens stored in OS keychain (or fallback: encrypted file)
            → frontend reloads home page
    → Yes → silently refresh access token, proceed
  → Frontend verifies Premium via api.verify_premium() (calls /me, checks `product == "premium"`)
    → If not Premium → show "Premium required" message, end flow
  → Home page rendered with playlists sidebar (api.get_user_playlists())
```

### Flow B: Camera-based recommendation (the main use case)

```
User clicks "Take Photo"
  → Frontend opens webcam, shows live preview + on-screen guides
  → User clicks shutter
  → JS captures a frame as a base64-encoded PNG, calls api.detect_emotion(image_b64)
  → Python (api/) decodes → fer.image_pipeline.preprocess(image)
    1. Convert base64 → numpy array
    2. OpenCV Haar Cascade face detection
       - 0 faces → return {"error": "no_face"}
       - >1 faces → return {"error": "multiple_faces"}
       - 1 face → continue
    3. Crop facial ROI
    4. Resize to 300×300, normalise to [-1, 1] (EfficientNet preprocess_input)
    5. Quality check: Laplacian variance (blur) + brightness histogram
       - Fail → return {"error": "low_quality"}
  → fer.emotion_model.predict(image_tensor) → (emotion_label, confidence)
    - If emotion_label in {fear, disgust} → return {"error": "out_of_scope", "detected": label}
    - Else → continue
  → music.recommender.generate_playlist(emotion_label)
    1. Look up emotion_music_mapping row
    2. SELECT * FROM music WHERE valence BETWEEN ? AND ? AND energy BETWEEN ? AND ? AND tempo BETWEEN ? AND ? LIMIT 1000
    3. Random sample N tracks (default N=25)
    4. Return list of {track_id, track_name, artist_name, ...}
  → api/ returns playlist JSON to frontend
  → Frontend renders result page with playlist + play/save/edit controls
```

### Flow C: Playback

```
User clicks "Play" on a playlist item
  → Frontend's Spotify Web Playback SDK player.activateElement() (if first interaction)
  → JS calls Spotify Web API PUT /me/player/play with {context_uri: "spotify:track:<id>"}
     OR uses the SDK's player.resume() after queueing
  → Spotify streams audio to the SDK player instance inside the webview
  → Python is not in the playback path (lower latency, no audio data crosses our process)
```

### Flow D: Manual mood selection

Same as Flow B but skips steps 1–5; `emotion_label` comes directly from the button the user clicked.

### Flow E: One-time data preparation (offline, before first run)

```
scripts/download_datasets.py
  → Downloads 3 Kaggle datasets to data/raw/
scripts/merge_catalogues.py
  → Joins maharshipandya + joebeachcapital + rodolfofigueroa on track_id
  → Genre preference: maharshipandya > joebeachcapital > (artist-enriched genres for rodolfofigueroa)
  → Writes data/processed/music_merged.csv
scripts/enrich_artist_genres.py
  → For rodolfofigueroa tracks missing genre: extract unique artist_ids,
     batch-fetch /artists?ids=... (50 at a time), checkpoint every 1000 batches,
     resume-safe, honour 429 Retry-After.
  → Writes data/processed/artist_genres.csv
scripts/seed_database.py
  → CREATE TABLEs, INSERT music rows (~1.2M), INSERT emotion_music_mapping seed (5 rows)
```

See `docs/MUSIC_DATA.md` for the merge logic, `docs/DATABASE.md` for schema.

---

## Non-functional considerations

### Performance targets (informal, for capstone evaluation)

- **End-to-end emotion → playlist latency:** ≤ 5 seconds (camera click → playlist on screen). Model inference is the dominant cost; on CPU, EfficientNet-B3 inference is ≈ 200–500 ms per image.
- **Database query latency:** ≤ 200 ms for the recommendation `SELECT`, given proper indexes on `valence`, `energy`, `tempo`.
- **Memory footprint:** ≤ 2 GB resident (EfficientNet-B3 model is ≈ 50 MB on disk, ≈ 500 MB in memory with TensorFlow's graph + buffers).
- **Cold start (app launch to home page):** ≤ 10 seconds, dominated by TensorFlow import + model load.

### GPU vs CPU

- Training (one-off) **requires GPU** — a free Kaggle or Google Colab GPU instance is sufficient for fine-tuning on RAF-DB.
- Inference (every run) is **CPU-only** by design. EfficientNet-B3 inference on CPU is fast enough (< 1 s) for one-image-at-a-time use. We do not assume the user has a GPU.

### Failure modes and recovery

| Failure | Handler |
|---|---|
| Webcam unavailable | Show error, offer manual mood selection |
| Face detection finds 0 or >1 faces | Error page, route back to home |
| Image too blurry / dark | Error page with retake suggestion |
| Detected emotion outside scope (fear, disgust) | Error page; suggest manual mood selection |
| MySQL connection fails | Fatal error at startup; show diagnostic message |
| Spotify token expired and refresh fails | Force re-login |
| Network drop during playback | SDK handles reconnect; surface "lost connection" toast |
| Spotify Web Playback SDK fails to load (e.g. ad blocker) | Show fallback message; recommend disabling extensions |

### Security and privacy

- Spotify tokens stored in the OS keychain via `keyring` library, with an encrypted-file fallback. **Never** in plain text.
- The Spotify `client_secret` is **not** distributed with the desktop app. We use **Authorization Code with PKCE** flow specifically to avoid embedding the secret. (Spotipy supports this via `SpotifyPKCE`.)
- Webcam frames are in-memory only. See CLAUDE.md §5.
- No telemetry, no analytics, no crash reporting to third parties.
- MySQL credentials live in `.env` (gitignored). `.env.example` ships with placeholders.

See `docs/SPOTIFY_INTEGRATION.md` for the auth flow details.

---

## Why these architectural choices

A few decisions worth justifying because they will come up during supervisor review:

### Why PyWebView instead of Tkinter / PyQt / Electron?

- Tkinter / PyQt: no easy way to host the Spotify Web Playback SDK (which is JavaScript-only and requires a browser environment).
- Electron: would require packaging a Node.js backend, which doesn't match the Python+TensorFlow stack.
- PyWebView gives us a native Python process (good for ML) **and** a browser context (necessary for the Spotify SDK), with a clean JS↔Python bridge. It's the smallest stack that satisfies both constraints.

### Why MySQL instead of SQLite?

The capstone plan specifies MySQL. SQLite would work for a single user and ~1.2M rows, but:
- The plan was approved with MySQL; changing now invites supervisor friction.
- MySQL's query planner handles range queries on multiple indexed columns (valence + energy + tempo) more predictably at this scale.
- The student will benefit from MySQL experience for industry roles.

If the owner later decides SQLite is preferable (e.g. to ship a fully self-contained installer), revisit with supervisor first.

### Why rule-based recommendation instead of ML-based?

The CP1 plan defines a rule-based emotion→valence/energy/tempo mapping. We keep it because:
- The supervisor approved this design.
- ML-based recommendation needs user interaction history, which a fresh-install single-user app doesn't have (cold-start problem — explicitly called out in the CP1 problem statement).
- Rule-based is explainable to a non-technical reviewer.
- It's the **right scope** for a capstone; ML ranking is future work.

### Why Spotify instead of YouTube Music / Apple Music / local files?

- Spotify has the only widely-available Web Playback SDK that runs in an embedded webview.
- The pre-built audio-feature datasets we depend on (valence/energy/tempo) are all derived from Spotify's Echo Nest pipeline; mixing them with a different streaming source would require feature re-derivation.
- Apple Music's MusicKit JS exists but requires a paid Apple Developer account.
- YouTube Music has no public playback SDK.

The Premium-account requirement is the cost of this choice; it is disclosed and accepted.

---

## Open questions (track here until resolved)

These are deliberately unresolved at planning time and should be settled during CP2 implementation:

- [ ] **Token storage backend:** `keyring` (preferred) vs encrypted file. Decide at Spotify integration sprint.
- [ ] **Frontend JS modularity:** plain `<script>` tags vs ES modules. Default to ES modules unless PyWebView shows quirks.
- [ ] **DB ORM:** raw SQL (default) vs SQLAlchemy (if the schema grows). Revisit at the database sprint.
- [ ] **Playlist randomisation seeding:** deterministic seed for tests vs truly random in production — implement both via a parameter.
- [ ] **Localhost callback port for OAuth:** fixed port (e.g. 8888) vs ephemeral. PKCE-based desktop apps typically use a fixed loopback port; needs registration in the Spotify Developer Dashboard.

When one of these is decided, move it out of this section into the relevant doc.

---

## Related docs

- `docs/FER_MODEL.md` — model training and inference details
- `docs/IMAGE_PIPELINE.md` — image capture and preprocessing
- `docs/MUSIC_DATA.md` — dataset merge and enrichment
- `docs/DATABASE.md` — schema and seed data
- `docs/RECOMMENDATION.md` — the rule-based recommender
- `docs/SPOTIFY_INTEGRATION.md` — auth, tokens, playback SDK
- `docs/FRONTEND.md` — pages, JS bridge, SDK init
- `docs/BUILD_PLAN.md` — what to build, in what order
