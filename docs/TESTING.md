# docs/TESTING.md

Testing strategy for the project: unit tests, integration tests, manual smoke tests, and the user study from CP1 §3.11.

---

## Test pyramid

```
                  ▲
                 /│\
                / │ \    User Study (CP2 Phase 4)
               /──┴──\   ~10 testers, full app
              /       \
             /─────────\  Integration tests
            /           \  ~20 tests, hit MySQL + Spotipy mocks
           /─────────────\
          /               \  Unit tests
         /─────────────────\ ~80+ tests, pure functions
        /───────────────────\
```

Bias toward unit tests. Each module's pure functions should have multiple tests covering happy path and error paths. Integration tests cover module-to-module wiring. The user study replaces a traditional E2E test suite (manual checklist is cheaper at this scale).

---

## Unit tests

### What's covered

| Module | Coverage focus | Key tests |
|---|---|---|
| `src/fer/image_pipeline.py` | Every error path + happy path | decode failures, 0-face, multi-face, blur, dark, bright, valid |
| `src/fer/emotion_model.py` | Inference correctness with fixture image | predict known-happy image; in-scope filter; out-of-scope handling |
| `src/music/recommender.py` | Determinism + rule coverage | one test per emotion; seed determinism; pool exhaustion |
| `src/music/playlists.py` | CRUD operations | create, load, update, delete |
| `src/spotify/auth.py` | Mocked Spotipy flow | login success, token refresh, logout clears keyring |
| `src/spotify/account.py` | Premium detection | premium → true, free → false, error path |
| `src/db/connection.py` | Pool lifecycle | acquire/release, retry on disconnection |
| `src/db/migrate.py` | Migration runner | applies in order, idempotent, fails on conflict |
| `src/api/__init__.py` | Bridge methods return JSON-serialisable values | every method returns the documented shape |

### What's NOT unit-tested

- **Frontend JS:** no test runner. Manual checklist below.
- **Real Spotify API calls:** mocked at every test.
- **Real TensorFlow training:** the training script is one-off, validated by inspection of curves.
- **Real webcam:** input is always a fixture image.
- **Real MySQL with 1.2M rows:** tests use a fixture catalogue of ~100 rows.

### Test infrastructure

#### `tests/conftest.py`

Shared fixtures:

```python
import pytest
import numpy as np
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"

@pytest.fixture
def happy_face_image_b64() -> str:
    """Base64-encoded PNG of a known-happy face from RAF-DB."""
    return (FIXTURES / "images" / "happy_face.png.b64").read_text().strip()

@pytest.fixture
def no_face_image_b64() -> str:
    """Base64-encoded PNG of a landscape (no faces)."""
    return (FIXTURES / "images" / "no_face_landscape.png.b64").read_text().strip()

@pytest.fixture
def multi_face_image_b64() -> str:
    """Base64-encoded PNG of a group photo (3+ faces)."""
    return (FIXTURES / "images" / "multi_face_group.png.b64").read_text().strip()

@pytest.fixture
def blurry_face_image_b64() -> str:
    """Base64-encoded PNG of an intentionally blurred face."""
    return (FIXTURES / "images" / "blurry_face.png.b64").read_text().strip()

@pytest.fixture
def test_db_connection(monkeypatch):
    """Spin up a test DB with the fixture catalogue, yield a connection, tear down."""
    # See "Integration test DB setup" below.
    ...
```

#### Image fixtures

Store as base64 text files (not raw PNGs) so they diff cleanly in Git:

```bash
base64 happy_face.png > happy_face.png.b64
```

Or commit small PNGs directly if size is < 100 KB each. Either works.

#### Mocking Spotipy

```python
# tests/spotify/test_auth.py
from unittest.mock import patch, MagicMock

@patch("src.spotify.auth.SpotifyPKCE")
def test_login_success(mock_pkce):
    mock_instance = MagicMock()
    mock_instance.get_access_token.return_value = {
        "access_token": "fake_token",
        "refresh_token": "fake_refresh",
        "expires_at": 9999999999,
    }
    mock_pkce.return_value = mock_instance

    from src.spotify.auth import start_login_flow
    result = start_login_flow()
    assert result["access_token"] == "fake_token"
```

Never hit Spotify in unit tests. The Premium check and OAuth flow are validated manually during integration.

---

## Integration tests

Tests that span multiple modules and require real (or near-real) infrastructure.

### Setup: test database

Two strategies; pick one in week 3 of Phase 3:

**Strategy A — separate test schema:**

```sql
CREATE DATABASE emotion_music_test;
GRANT ALL ON emotion_music_test.* TO 'emotion_music'@'localhost';
```

Tests connect to `emotion_music_test`, run migrations, load the fixture catalogue, tear down. Slower but isolated.

**Strategy B — SQLite for tests:**

Switch the test DB to SQLite. Cheaper but requires schema differences (no `ENUM`, etc.) — would mean maintaining two schemas. Not recommended unless test runtime becomes a problem.

**Default: Strategy A.**

### Fixture catalogue

A small CSV (~100 rows) in `tests/fixtures/music_fixture.csv` covering all 5 emotions with predictable feature distributions:

```csv
track_id,track_name,artists,genre,valence,energy,tempo
fixture_happy_01,Happy Song 1,Artist A,pop,0.85,0.80,140.0
fixture_happy_02,Happy Song 2,Artist B,dance,0.78,0.75,128.0
...
fixture_sad_01,Sad Song 1,Artist C,ballad,0.15,0.20,72.0
...
```

Seed this into the test DB at fixture time.

### Integration test list

| Test | What it checks |
|---|---|
| `test_full_recommendation_flow` | Image → FER → recommender → playlist with > 0 tracks |
| `test_out_of_scope_image_returns_error` | A *disgust* face image returns out-of-scope status, no playlist generated |
| `test_save_and_load_playlist` | Generate → save → load → identical track list |
| `test_recommender_uses_correct_rule` | For each emotion, returned tracks satisfy the rule's valence/energy/tempo ranges |
| `test_db_migration_from_empty` | Fresh empty schema → run all migrations → final schema matches expected |
| `test_recommender_with_empty_pool` | Set up rule with impossible ranges → recommender returns empty list, doesn't crash |

Marked `@pytest.mark.integration`; run with `pytest -m integration`.

---

## Manual smoke test (every commit to main)

A quick checklist the developer runs locally before pushing significant changes. Takes ~5 minutes.

```
[ ] App starts: `python -m src.main` opens the window without errors
[ ] First-run: shown login screen
[ ] Click "Login with Spotify": browser opens, OAuth completes, returns to app
[ ] Premium check passes (or correctly blocks free accounts)
[ ] Home screen renders, sidebar visible
[ ] Click "Take Photo": webcam preview appears with face guide
[ ] Guide turns green when one face visible
[ ] Capture: loading screen → result page with 25 tracks
[ ] Click play on a track: audio plays
[ ] Save the playlist: appears in sidebar
[ ] Refresh: saved playlist still in sidebar
[ ] Navigate to mood page: 5 emotion buttons visible
[ ] Click "Happy": result page with 25 happy tracks (different from camera flow due to randomness)
[ ] Click delete on a saved playlist: gone from sidebar
[ ] Logout: returns to login screen
```

If any step fails, fix before pushing.

---

## User study (CP1 §3.11, executed in CP2 Phase 4)

Two questionnaires deployed via Google Forms after testers use the system. Combined response analysis informs Phase 5 improvements.

### Performance evaluation (13 Likert questions)

Covers:
- Emotion recognition accuracy / responsiveness / consistency
- Music recommendation accuracy / appropriateness
- Playlist quality / variety / length / repetition
- Tolerance for imperfect matches

Full question list in CP1 §3.11.1.

### Usability evaluation (24 Likert questions)

Covers:
- Ease of use, instruction clarity
- Camera interaction comfort, guidance clarity
- UI design, layout, readability
- Playlist interaction (view, save, edit)
- Overall satisfaction, recommendation intent

Full question list in CP1 §3.11.2.

### Tester recruitment

- Target: ≥ 10 testers.
- **Prerequisite: Spotify Premium account** (the app won't function otherwise).
- Recruit through course peers, friends, family — anyone willing to install Python and the app.
- Brief each tester verbally or via a one-page instructions document before they start.

### Analysis

For each question:
- Mean and median rating.
- Count of ≤ 2 (dissatisfied) responses — these are improvement candidates.
- Open-ended responses: cluster into themes manually.

Output: `docs/TEST_RESULTS.md` with a summary table, the bottom 5 questions by mean rating, and the top 5 improvement themes from open-ended feedback.

---

## FER model accuracy evaluation

Not a typical "test" but documented here because it ships in the report.

After training in CP2 week 5, run:

```bash
python scripts/evaluate_model.py
```

Which produces:

- **Confusion matrix** (7×7) PNG.
- **Per-class precision, recall, F1** as a text report.
- **5-class in-scope evaluation:** filter test set to in-scope emotions only, recompute metrics. This is the number that matters for end-user experience.
- **Test-set accuracy headline number.**

Target: ≥ 80% on 7 classes, ≥ 85% on 5 in-scope classes. If below 75%, the model is not shipping until investigated (see `docs/FER_MODEL.md` "Pitfalls" section).

---

## Performance testing

Manual measurements during Phase 4. Run on the target hardware (the owner's laptop, no GPU).

| Measurement | Tool | Target |
|---|---|---|
| Cold app start to home page | Stopwatch | ≤ 10 s |
| Camera click → playlist on screen | `time.perf_counter` instrumentation in Python | ≤ 5 s |
| Image pipeline (decode → tensor) | Bench script | ≤ 1 s |
| EfficientNet-B3 inference (single image, CPU) | Bench script | ≤ 500 ms |
| Recommendation query (DB only) | `EXPLAIN ANALYZE` | ≤ 200 ms |
| Playlist generation (rule + sample) | Bench script | ≤ 250 ms |
| Memory footprint (RSS at idle on home) | OS Activity Monitor / Task Manager | ≤ 2 GB |
| Memory footprint (peak during inference) | OS Activity Monitor / Task Manager | ≤ 3 GB |

If any number is 2x over target, investigate in Phase 5. Document actuals in `docs/TEST_RESULTS.md`.

---

## Running the tests

```bash
# All unit tests
pytest

# With coverage
pytest --cov=src --cov-report=html
# Open htmlcov/index.html

# Integration tests only
pytest -m integration

# Skip slow tests
pytest -m "not slow"

# A single file
pytest tests/fer/test_image_pipeline.py

# A single test
pytest tests/fer/test_image_pipeline.py::test_decode_invalid_base64_raises
```

CI is not set up for this project (solo, no remote runners). Tests run locally only. If GitHub Actions is added later, the workflow should:
1. Set up Python 3.11.
2. `pip install -r requirements.txt`.
3. Spin up a MySQL service.
4. Run migrations.
5. `pytest -m "not slow"`.

---

## Common testing pitfalls

1. **Hitting Spotify in tests.** Always mock. If a test ever needs a real Spotify call, mark it `@pytest.mark.manual` and don't include in default runs.
2. **Test pollution from shared global state.** TensorFlow's model registry, Spotipy's token cache, logger handlers — reset between tests with fixtures (`autouse=True` if needed).
3. **Test data committed to the wrong place.** Test fixtures go in `tests/fixtures/`. Sample real data goes in `data/seed/`. Don't mix.
4. **Mock objects that don't match the real interface.** When mocking Spotipy's `current_user()`, return the same dict shape Spotify actually returns. Otherwise the test passes but production breaks.
5. **Tests depending on each other's order.** Each test should set up and tear down independently. If two tests share expensive setup, use a fixture with `scope="module"` or `scope="session"`.

---

## Related docs

- `CLAUDE.md` — testing conventions overview.
- `docs/CODING_STANDARDS.md` — style for test code.
- `docs/BUILD_PLAN.md` — when tests are written (during each module's track).
- `docs/FER_MODEL.md` — evaluation criteria for the model.
- `docs/RECOMMENDATION.md` — determinism guarantees the tests rely on.
