# docs/BUILD_PLAN.md

The CP2 implementation roadmap. This doc tells Claude Code (and the owner) what to build next, in what order, with explicit dependencies between tasks.

The plan follows the Waterfall phases from the CP1 planning doc (§4.1.2), restated here with concrete deliverables.

---

## Phase overview (12 weeks, May–July 2026)

| Phase | Weeks | Focus |
|---|---|---|
| 1. Requirements Definition | 1 | SRS survey, finalise requirements |
| 2. System & Software Design | 2 | Finalise design, high-fidelity prototype |
| 3. Implementation & Unit Testing | 3–8 | All 5 main modules, in parallel where possible |
| 4. Integration & System Testing | 9–10 | Wire everything together, run test plan |
| 5. Operation & Maintenance | 11–12 | Bug fixes, optimisation, final docs |

Detailed week-by-week in CP1 §4.2.2.

---

## Pre-CP2 checklist (do before week 1)

Things the owner should confirm or set up *before* implementation begins. Claude Code can help with these in advance.

- [ ] **Spotify Developer App registered** with redirect URI `http://127.0.0.1:8888/callback` and Web API + Web Playback SDK scopes selected. Client ID and Client Secret saved.
- [ ] **MySQL 8.x installed** locally. `emotion_music` database created. User with full privileges on that DB created.
- [ ] **Python 3.11** installed (not 3.12+ until TensorFlow confirms support). `pyenv` or `conda` recommended.
- [ ] **RAF-DB dataset extracted** to a known directory. Confirm folder structure: `train/`, `test/`, with sub-folders per class label.
- [ ] **Kaggle CLI configured** with API token (`~/.kaggle/kaggle.json`).
- [ ] **GitHub repo created** (private). Initial commit with `.gitignore` covering `__pycache__`, `.env`, `data/raw/`, `data/processed/`, `models/*.keras`.
- [ ] **GPU access for training** confirmed. Options: a local GPU machine, Google Colab Pro, or Kaggle Notebooks (30 hr/week free GPU). Training won't run on CPU in reasonable time.

If any item is missing, raise it with the owner before starting Phase 3.

---

## Phase 1 — Requirements Definition (Week 1, May 4–8)

### Deliverables

1. **SRS survey deployed** via Google Forms (questions are pre-written in CP1 §3.2.2).
2. **Survey responses collected** — aim for ≥ 20 respondents (the planning doc suggested 30+; 20 is the minimum useful sample).
3. **Functional and non-functional requirements finalised** based on survey results. The CP1 planning doc has provisional requirements; this phase confirms or refines them.

### Output

- `docs/REQUIREMENTS.md` — new doc summarising final requirements with survey evidence. Created at end of Phase 1.

### Claude Code's role here

Minimal — this phase is user-facing data collection. Claude Code can help analyse survey responses (CSV → summary stats) and draft the requirements document.

---

## Phase 2 — System & Software Design (Week 2, May 11–15)

### Deliverables

1. **Finalised system design.** The architecture in `docs/ARCHITECTURE.md` is provisional; revisit any open questions there.
2. **High-fidelity UI prototype** in Figma covering all 6 pages (and the login + premium gates).
3. **Open questions in `docs/ARCHITECTURE.md` resolved.** Specifically:
   - Token storage backend (keyring vs file).
   - DB ORM (raw SQL vs SQLAlchemy).
   - OAuth callback port confirmed and registered in dashboard.

### Output

- Updated `docs/ARCHITECTURE.md` with resolved open questions.
- Figma file (linked from `docs/FRONTEND.md`).
- Final method signatures for all bridge methods. Update `docs/SPOTIFY_INTEGRATION.md` and `docs/FRONTEND.md` if signatures changed.

### Claude Code's role here

Help finalise architectural decisions, prototype small spike code to validate choices (e.g. confirm `keyring` works on the target OS).

---

## Phase 3 — Implementation & Unit Testing (Weeks 3–8, May 18–June 26)

This is the bulk of the work. Five parallel tracks. Each track is a standalone module with its own unit tests.

### Repository skeleton (Week 3 day 1)

Before any module work, scaffold the repo:

```bash
# Create directories
mkdir -p src/{api,fer,music,spotify,db,db/migrations}
mkdir -p frontend/{pages,css,css/pages,js}
mkdir -p scripts tests data/{raw,processed,seed} models

# Initialise Python project
python -m venv .venv
.venv/bin/pip install -U pip setuptools wheel
.venv/bin/pip install tensorflow opencv-python numpy pandas \
    mysql-connector-python python-dotenv spotipy keyring pywebview \
    pytest pytest-cov black ruff

# Freeze
.venv/bin/pip freeze > requirements.txt
```

Commit the skeleton. **One commit per module created, no code yet.** Subsequent commits add functionality.

### Track A: Database (Week 3)

**Dependencies:** none (can start immediately).

| Task | Output |
|---|---|
| A1. Migration runner | `src/db/migrate.py`, `src/db/migrations/0001_initial_schema.sql` |
| A2. Connection pool | `src/db/connection.py` |
| A3. Emotion-mapping seed migration | `src/db/migrations/0002_emotion_mapping_seed.sql` |
| A4. Index migration | `src/db/migrations/0003_indexes.sql` |
| A5. Unit tests | `tests/db/test_migrate.py`, `tests/db/test_connection.py` |

**Done when:** running `python -m src.db.migrate` against a fresh empty DB creates all tables + seeds the rule table, and tests pass.

See `docs/DATABASE.md`.

### Track B: Music data preparation (Weeks 3–4)

**Dependencies:** Track A complete (need DB to load data into).

| Task | Output |
|---|---|
| B1. Download script | `scripts/download_datasets.py` |
| B2. Normalisation script | `scripts/normalise_datasets.py` |
| B3. Artist-genre enrichment script (long-running, run overnight) | `scripts/enrich_artist_genres.py` |
| B4. Merge script | `scripts/merge_catalogues.py` |
| B5. Seed script | `scripts/seed_database.py` |
| B6. Verify catalogue: 1.2M rows, indexes present, rule table populated | manual check |

**Critical path:** B3 takes 2–6 hours. Start it on day 1 of week 3 and let it run in background while doing other tracks.

See `docs/MUSIC_DATA.md`.

### Track C: FER model (Weeks 3–6)

**Dependencies:** RAF-DB available (pre-CP2 checklist).

| Task | Output |
|---|---|
| C1. Image pipeline (decode → detect → preprocess → quality) | `src/fer/image_pipeline.py` + tests |
| C2. Model architecture builder | `src/fer/model.py` (build_model function) |
| C3. Training script (phase 1 + phase 2) | `scripts/train_emotion_model.py` |
| C4. Training run | `models/emotion_model.keras`, `models/confusion_matrix.png`, etc. |
| C5. Inference wrapper | `src/fer/emotion_model.py` (load + predict) |
| C6. Out-of-scope filter | `src/fer/emotion_model.py` (predict_in_scope) |
| C7. Unit tests with fixture image | `tests/fer/test_*.py` |

**Critical path:** C4 (training) requires a GPU and takes 1–3 hours. Plan a Colab session or local GPU run mid-week 4.

See `docs/FER_MODEL.md`, `docs/IMAGE_PIPELINE.md`.

### Track D: Recommendation logic (Week 5)

**Dependencies:** Tracks A and B complete (need populated DB).

| Task | Output |
|---|---|
| D1. Rule lookup | `src/music/recommender.py` |
| D2. Candidate query + random sample | `src/music/recommender.py` |
| D3. Playlist save/load/delete | `src/music/playlists.py` |
| D4. Unit tests with fixed seed | `tests/music/test_*.py` |

**Done when:** `generate_playlist("happy", size=25, seed=42)` returns 25 deterministic tracks.

See `docs/RECOMMENDATION.md`.

### Track E: Spotify integration (Weeks 5–6)

**Dependencies:** Spotify Developer App registered (pre-CP2 checklist).

| Task | Output |
|---|---|
| E1. Keyring cache handler | `src/spotify/keyring_cache.py` |
| E2. PKCE auth flow | `src/spotify/auth.py` (start_login_flow, get_valid_access_token, logout) |
| E3. Premium check | `src/spotify/account.py` (verify_premium) |
| E4. Unit tests (mocked Spotipy) | `tests/spotify/test_*.py` |

**Manual verification step (not unit-testable):** run the actual OAuth flow end-to-end with the maintainer's Spotify account. Document the working flow with a screenshot.

See `docs/SPOTIFY_INTEGRATION.md`.

### Track F: Frontend + bridge (Weeks 6–8)

**Dependencies:** Tracks C, D, E (the bridge calls these). Frontend can be built against mock bridge methods first.

| Task | Output |
|---|---|
| F1. PyWebView entry point + bridge skeleton | `src/main.py`, `src/api/__init__.py` |
| F2. Login + premium gate pages | `frontend/pages/login.html`, `premium_required.html`, `frontend/js/auth_gate.js` |
| F3. Home page + sidebar | `frontend/pages/home.html`, `frontend/js/sidebar.js` |
| F4. Photo page with live face detection | `frontend/pages/photo.html`, `frontend/js/camera.js` |
| F5. Mood page | `frontend/pages/mood.html`, `frontend/js/mood.js` |
| F6. Loading + result + error pages | matching HTML/JS |
| F7. Spotify Playback SDK integration | `frontend/js/playback.js` |
| F8. Styling pass | `frontend/css/*` |
| F9. Manual UI test pass | checklist in `docs/TESTING.md` |

**Strategy:** Build F1–F3 first against mock bridge methods (return hardcoded data). Then wire each real bridge method as the corresponding backend track completes.

See `docs/FRONTEND.md`.

### Phase 3 completion checklist

- [ ] All five tracks complete with passing unit tests.
- [ ] One end-to-end happy-path manual test passes (camera → emotion → playlist → playback).
- [ ] `requirements.txt` finalised.
- [ ] `README.md` written (setup, run instructions).

---

## Phase 4 — Integration & System Testing (Weeks 9–10, June 29–July 10)

### Track G: System integration

**Dependencies:** Phase 3 complete.

| Task | Output |
|---|---|
| G1. End-to-end smoke test on a clean machine (or VM) | passes / doesn't |
| G2. Performance profiling — measure latency at each pipeline stage | `docs/PERFORMANCE.md` |
| G3. Fix any integration bugs uncovered | commits |

### Track H: User test plan execution

| Task | Output |
|---|---|
| H1. Distribute test plan survey (CP1 §3.11) to ≥ 10 testers | responses |
| H2. Analyse responses; identify top improvement areas | summary doc |
| H3. Compile system performance metrics | accuracy, latency, etc. |

### Output

- `docs/TEST_RESULTS.md` — combined results from G and H.

---

## Phase 5 — Operation & Maintenance (Weeks 11–12, July 13–24)

### Track I: Improvements

**Dependencies:** Phase 4 results in hand.

| Task | Output |
|---|---|
| I1. Triage improvement tasks by severity | prioritised list |
| I2. Implement high-priority fixes | commits |
| I3. Final regression test pass | passes |

### Track J: Documentation

| Task | Output |
|---|---|
| J1. Update all `docs/*.md` with final design and lessons learned | updated docs |
| J2. Write capstone report content for CP2 (results, discussion, conclusion) | report sections |
| J3. Final code review pass, dead code removal | clean commits |
| J4. Submission package | tagged release on GitHub |

### Submission deliverables

- Tagged Git release on GitHub.
- CP2 report (Word doc, per Sunway's template).
- Demo video (recommended even if not required — easier for evaluators than running the system).
- Trained model file (or download instructions if too large for the repo).

---

## Risk register

Risks specific to implementation, beyond what the CP1 timeline already covered.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| FER training accuracy below 75% | Med | High | Allocate fallback time in week 5 to swap to a different architecture (B0 or ResNet50). Have a Plan B model ready. |
| Spotify policy changes mid-project (further endpoint deprecations) | Low | High | Monitor developer.spotify.com/blog. Web Playback SDK is the only critical dependency; alternative streaming sources don't exist. |
| Web Playback SDK doesn't work inside PyWebView | Low | Critical | Verify in week 2 with a 10-line spike. If it fails, the architecture pivots to a browser-based app served from a local Flask instance. |
| Artist-genre enrichment hits 429s heavily | Med | Med | Already mitigated with backoff + resumability. Worst case: enrich a 100k-artist subset (most-popular tracks) instead of all 400k. |
| Owner's machine can't train the model locally | High | Med | Use Google Colab Pro or Kaggle Notebooks. Already planned. |
| Spotify Premium accounts unavailable for testers | Med | Med | Recruit testers from people who already have Premium (most students do). The supervisor needs Premium too; confirm in week 1. |
| RAF-DB licence issues | Low | Med | RAF-DB requires email request to authors for academic use. Already obtained, per pre-CP2 checklist. |

---

## How Claude Code should approach the build plan

When the owner asks "what should I build next?":

1. Identify the current phase based on `CLAUDE.md` status section.
2. Identify which tracks within the phase are unblocked (dependencies met).
3. Recommend the next task within an unblocked track, preferring tasks on the critical path (training run for FER, enrichment script for music data).
4. Reference the relevant doc for implementation details.

When the owner asks "implement task X":

1. Verify the task is unblocked by checking its dependencies.
2. Read the relevant doc(s) first.
3. Write the code with tests.
4. Confirm tests pass.
5. Update this BUILD_PLAN if the task changed scope or revealed new sub-tasks.

When the owner deviates from the plan (e.g. "skip ahead to the frontend"):

- Surface the dependency issue ("the frontend needs the bridge methods, which need the recommender to be working").
- If they confirm anyway, build against mocks and document the temporary mocks clearly.

---

## Related docs

- `CLAUDE.md` — has the project status block that tracks current phase.
- `docs/ARCHITECTURE.md` — referenced by every track.
- Individual module docs — referenced by their respective tracks.
- `docs/TESTING.md` — the test plan executed in Phase 4.
