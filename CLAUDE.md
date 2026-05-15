# CLAUDE.md — Project Context for Claude Code

This file is the entry point for Claude Code when working on this repository. Read this first, then follow links to deeper documentation in `docs/` as needed.

---

## What this project is

**AI-Based Emotion-Driven Music Recommendation System Using Face Analysis** — a desktop application that captures a user's facial photo via webcam, classifies their emotion using a fine-tuned EfficientNet-B3 CNN, then generates a Spotify-streamable playlist that matches the detected emotion.

This is a **BSc (Hons) Computer Science capstone project** at Sunway University. The owner is the sole developer. The project has two phases:

- **Capstone Project 1 (CP1):** Planning, research, design — already completed (Sept 2025 – Jan 2026). The full planning document (the source of truth for design decisions) is referenced throughout these docs.
- **Capstone Project 2 (CP2):** Implementation, testing, evaluation — runs May–July 2026. This is what we are building.

The project follows the **Waterfall methodology** with weekly supervisor check-ins. Phases must be completed and documented in order: Requirements → Design → Implementation → Integration & Testing → Operation & Maintenance.

---

## Core user flow (one-paragraph summary)

User launches the desktop app → logs into Spotify (one-time OAuth) → on home screen, chooses either *"Take Photo"* (webcam) or *"Choose Mood Manually"* → if photo, system detects exactly one face, preprocesses the ROI, runs it through the EfficientNet-B3 emotion classifier, and maps the result (happy / surprised / sad / angry / neutral) to a valence–energy–tempo target range → system queries the local MySQL music catalogue for songs matching that range, randomises a subset into a playlist, and displays it → user can play the playlist (Spotify Web Playback SDK streams to the embedded webview), save it, edit it, or re-take the photo.

If detection fails (no face, multiple faces, blurry, dark, or detected emotion is outside the supported scope — e.g. *fear* or *disgust*), the system shows an error page and routes the user back to the home screen.

---

## Tech stack (locked unless noted)

| Layer | Choice | Notes |
|---|---|---|
| Language | Python 3.11 | Match TensorFlow 2.x stable support; avoid 3.12+ until confirmed. |
| Deep learning | TensorFlow 2.x + Keras API | `tf.keras.applications.EfficientNetB3` with ImageNet weights. |
| Face detection | OpenCV Haar Cascade (`haarcascade_frontalface_default.xml`) | Capstone plan specifies this. Simple and adequate; if accuracy is poor at integration time, swap to MediaPipe Face Detection — but only with supervisor sign-off. |
| FER dataset | RAF-DB (already downloaded by owner) | 7 basic emotion classes; we collapse to 5 (drop fear & disgust) at the application layer, not at training time — see `docs/FER_MODEL.md`. |
| Database | MySQL 8.x | Stores music catalogue, emotion–music mapping rules, user playlists. |
| Music catalogue source | 3 pre-built Kaggle datasets, merged (see `docs/MUSIC_DATA.md`) | Spotify `/audio-features` was deprecated for new apps on **27 Nov 2024**, so we cannot fetch features at runtime. We use static dumps. |
| Music streaming | Spotify Web Playback SDK (JavaScript, in the embedded webview) | **Requires Spotify Premium** for every user. Disclosed in capstone report. |
| Spotify Web API (auxiliary) | Spotipy 2.x | Used only for OAuth flow + artist-genre enrichment script. The deprecated `/audio-features` endpoint is **NOT** used. |
| Desktop wrapper | PyWebView 5.x | Embeds HTML/CSS/JS frontend inside a native window; bridges Python ↔ JavaScript. |
| Frontend | HTML + CSS + vanilla JavaScript | No React/Vue. Keep dependencies minimal for a solo capstone. Spotify Playback SDK is plain JS, so vanilla integrates cleanly. |
| Version control | Git + GitHub (private repo) | |
| IDE | VS Code | |

**Do not introduce new frameworks or libraries without explicit owner approval.** If a task seems to call for one (e.g. "use Flask"), pause and confirm first. The dependency surface is intentionally small.

---

## Repository layout (target)

```
emotion-music-rec/
├── CLAUDE.md                       ← you are here
├── README.md                       ← user-facing project description
├── docs/                           ← supporting documentation; read on demand
│   ├── ARCHITECTURE.md             ← system architecture, components, data flow
│   ├── FER_MODEL.md                ← EfficientNet-B3 training, fine-tuning, inference
│   ├── IMAGE_PIPELINE.md           ← webcam capture → face detection → preprocessing → quality check
│   ├── MUSIC_DATA.md               ← 3-dataset merge strategy, artist-genre enrichment
│   ├── DATABASE.md                 ← MySQL schema, seed data, emotion–music mapping rules
│   ├── RECOMMENDATION.md           ← rule-based recommendation algorithm
│   ├── SPOTIFY_INTEGRATION.md      ← OAuth, Web Playback SDK, scopes, token refresh
│   ├── FRONTEND.md                 ← page layouts, JS bridge to PyWebView, Spotify SDK init
│   ├── BUILD_PLAN.md               ← module-by-module CP2 implementation order
│   ├── CODING_STANDARDS.md         ← naming, formatting, commits, testing conventions
│   └── TESTING.md                  ← unit, integration, and user-study test plans
├── src/
│   ├── main.py                     ← PyWebView app entry point
│   ├── api/                        ← JS-callable bridge methods (Python → JS)
│   ├── fer/                        ← FER pipeline (image processing + model inference)
│   ├── music/                      ← recommendation algorithm, DB queries
│   ├── spotify/                    ← OAuth flow, token management
│   └── db/                         ← MySQL connection, schema migrations, ORM (raw SQL or SQLAlchemy)
├── frontend/                       ← HTML/CSS/JS rendered by PyWebView
│   ├── index.html
│   ├── pages/                      ← home, photo, mood, loading, result, error
│   ├── css/
│   └── js/                         ← Spotify Playback SDK init, UI handlers
├── models/                         ← trained .keras / .h5 files (gitignored if large)
├── data/
│   ├── raw/                        ← gitignored: RAF-DB, raw Kaggle CSVs
│   ├── processed/                  ← gitignored: merged catalogue, train/val/test splits
│   └── seed/                       ← committed: emotion-music mapping rules SQL seed
├── scripts/                        ← one-off scripts (data merge, artist enrichment, DB seed)
├── tests/
├── requirements.txt
├── .env.example                    ← Spotify client ID, DB credentials placeholders
└── .gitignore
```

Create directories on demand; do not pre-create empty ones except where required by the build plan in `docs/BUILD_PLAN.md`.

---

## Critical context — read this before writing any code

### 1. The supported emotion scope is 5, not 7

RAF-DB labels 7 basic emotions: **happy, surprised, sad, angry, neutral, fear, disgust**. The system supports only the first 5 for music recommendation because the user survey (see CP1 planning doc §3.2) showed users rarely listen to music intentionally when feeling fear or disgust.

**Decision: train the model on all 7 classes, then filter at the application layer.** Reasoning:
- More training data per class → better feature learning.
- The "out-of-scope detected" error page (already designed in the planning doc) is the user-facing handler for *fear* and *disgust* predictions.
- Future scope expansion stays low-cost.

Do **not** drop fear/disgust at the dataset level. See `docs/FER_MODEL.md`.

### 2. Spotify `/audio-features` is dead for this project

On **27 November 2024**, Spotify deprecated the `/audio-features`, `/audio-analysis`, `/recommendations`, `/related-artists`, and featured/category playlist endpoints for any new third-party app. New apps registered after that date receive HTTP 403.

Implications:
- We **cannot** call `/audio-features` at runtime to enrich tracks.
- We **must** use pre-built dumps for valence/energy/tempo (see `docs/MUSIC_DATA.md`).
- Spotify Web Playback SDK is **not** affected — playback still works.
- `/artists?ids=...` (used for genre enrichment) is **not** affected — artist genres are still fetchable.
- Do not write code that calls the deprecated endpoints, even in fallback paths.

### 3. Music data is local; playback is remote

The 1.2M-track merged catalogue lives in MySQL on the user's machine. Recommendation logic runs entirely against the local DB. Spotify is contacted **only** to play a track — we pass the `track_id` to the Web Playback SDK, which streams audio from Spotify's servers to the embedded webview.

This means:
- The recommender works offline (after initial DB seed).
- Playback requires internet + Spotify Premium login.
- Every track in our DB must have a valid Spotify `track_id` so playback works.

### 4. Every user needs Spotify Premium

The Web Playback SDK does not stream to Free accounts. This is a hard Spotify policy, not a workaround we can fix. The capstone report discloses this; the app's first-run screen should make it explicit before the user attempts OAuth.

### 5. Privacy-sensitive data — webcam images

Captured facial images:
- Are processed in-memory only.
- Are **never** written to disk except in explicit debug mode (off by default).
- Are **never** transmitted to any external service.
- Are discarded immediately after emotion prediction.

This is a hard requirement. Do not add features (analytics, "save photo," cloud backup, telemetry) that would violate it.

---

## Working conventions for Claude Code

### Documentation-first

Before writing code for a module:
1. Read the relevant doc in `docs/` (e.g. `docs/FER_MODEL.md` before touching `src/fer/`).
2. If the doc is silent on a design point, ask the owner — do not invent a convention.
3. If the doc is wrong or out of date, fix the doc first, then the code.

### Small, reviewable changes

The owner is a single developer reviewing every diff. Prefer:
- One concern per commit.
- Working code at every commit (no half-implementations).
- Clear commit messages: `module: short imperative summary` (e.g. `fer: add Haar cascade face detection`).

### No silent dependency additions

If a task seems to require a new pip package, stop and confirm with the owner first. Adding `requests` is fine; adding `fastapi` or `pytorch` is not.

### Style

- Python: PEP 8, formatted with `black`, type hints on public functions, docstrings on non-trivial functions. Line length 100.
- JavaScript: 2-space indent, ES2020+, no transpilation step (PyWebView's embedded webview is Chromium-based, modern JS is fine).
- SQL: uppercase keywords, snake_case identifiers, one statement per line in migrations.

See `docs/CODING_STANDARDS.md` for the full conventions.

### Tests

- Every module in `src/` gets a matching `tests/` file.
- Unit tests use `pytest`.
- The FER model has a fixed test image (a known-happy face) checked into `tests/fixtures/` to verify the inference pipeline end-to-end.
- The recommendation algorithm has a fixed seed for randomised playlist selection so tests are deterministic.

See `docs/TESTING.md`.

### Long-running scripts are background-safe

The artist-genre enrichment script (`scripts/enrich_artist_genres.py`) must:
- Checkpoint progress to disk every 1,000 API batches.
- Resume from the last checkpoint if interrupted.
- Handle Spotify 429 responses by honouring the `Retry-After` header.

Do not write enrichment code that has to complete in one shot. See `docs/MUSIC_DATA.md`.

---

## Where to find things — quick reference

| If the task is about… | Read first |
|---|---|
| Setting up the project, installing deps, first run | `docs/BUILD_PLAN.md` |
| Adding/changing a CNN layer, training, accuracy, dataset prep | `docs/FER_MODEL.md` |
| Webcam, face detection, image quality, OpenCV | `docs/IMAGE_PIPELINE.md` |
| Anything touching the music catalogue, CSVs, merge logic | `docs/MUSIC_DATA.md` |
| Adding a table, a column, an index, a seed row | `docs/DATABASE.md` |
| Changing valence/energy/tempo thresholds, playlist size, randomisation | `docs/RECOMMENDATION.md` |
| OAuth flow, token refresh, Premium check, scopes | `docs/SPOTIFY_INTEGRATION.md` |
| HTML pages, CSS, JS event handlers, PyWebView bridge | `docs/FRONTEND.md` |
| What to build next, in what order | `docs/BUILD_PLAN.md` |
| How to format / commit / name things | `docs/CODING_STANDARDS.md` |
| Writing tests, running them, what coverage is required | `docs/TESTING.md` |
| The big-picture how-it-all-fits-together view | `docs/ARCHITECTURE.md` |

---

## Status (update this section as the project progresses)

- **Phase:** CP2 implementation starting May 2026.
- **Current focus:** Project not yet started — empty repo.
- **Next milestone:** Waterfall Phase 1 (Requirements Definition) → distribute SRS survey, refine functional/non-functional requirements. See `docs/BUILD_PLAN.md` week-by-week schedule.

---

## Out of scope (do not build these)

The capstone plan explicitly excludes these features. If a task asks for them, push back and confirm with the owner:

- Mobile app (Android/iOS).
- Wearable / physiological sensor emotion detection.
- Lyrics-based emotion analysis.
- Long-term personalisation (user listening-history-based ranking).
- Full music licensing / payment flows.
- Multi-user accounts inside the desktop app (each install is single-user).
- Cloud backup of playlists.
- Real-time continuous emotion tracking (one snapshot per request only).

---

## Owner contact / supervisor

- **Owner:** Lee Peng Haw (student, ID 23098387).
- **Supervisor:** Nurul Aiman Abdul Rahim.
- **Institution:** Sunway University, Department of Smart Computing and Cyber Resilience.

If Claude Code is unsure about a design decision, the default answer is **"ask the owner."** Do not guess for non-trivial decisions.
