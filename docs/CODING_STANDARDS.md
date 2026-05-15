# docs/CODING_STANDARDS.md

Conventions for code in this repository. Kept short on purpose — most decisions defer to standard tools (`black`, `ruff`) rather than house style.

---

## Python

### Version

Python 3.11. Do not use 3.10 syntax or earlier; do not use 3.12+ features (forward compatibility not yet verified for TensorFlow).

### Formatting

- **`black` with default settings, line length 100.** Run before every commit.
- Config in `pyproject.toml`:
  ```toml
  [tool.black]
  line-length = 100
  target-version = ["py311"]
  ```

### Linting

- **`ruff` with the default rule set.** Treat warnings as errors before merge.
- Config in `pyproject.toml`:
  ```toml
  [tool.ruff]
  line-length = 100
  target-version = "py311"
  [tool.ruff.lint]
  select = ["E", "F", "W", "I", "B", "UP", "SIM", "C4"]
  ignore = ["E501"]   # line-too-long handled by black
  ```

### Type hints

Required on:
- All function signatures (parameters and return type).
- Module-level constants when not obvious.
- Class attributes (use dataclasses where helpful).

Not required inside function bodies. Use them when they aid clarity.

```python
# Required
def detect_faces(img_bgr: np.ndarray) -> list[tuple[int, int, int, int]]:
    ...

# Allowed but not required
result: dict[str, float] = {}  # OK
result = {}                    # Also OK if context makes it clear
```

Prefer modern syntax (`list[int]` not `List[int]`, `str | None` not `Optional[str]`).

### Docstrings

Required on:
- Every public function (anything not prefixed with `_`).
- Every public class.
- Every module (single line at the top).

Not required on:
- `__init__` methods (document on the class instead).
- Trivial functions (`def get_id(self) -> int: return self._id`).

Style: short Google-style summary line, then params/returns if non-trivial. No need for exhaustive types in the docstring when the signature already has them.

```python
def generate_playlist(emotion: str, size: int = 25, seed: int | None = None) -> list[dict]:
    """Build a playlist of `size` tracks matching the given emotion.

    Raises ValueError if emotion is not one of the supported labels.
    Returns a possibly-smaller list if the candidate pool is exhausted.
    """
```

### Imports

Order (enforced by ruff's `I` rule):
1. Standard library.
2. Third-party.
3. First-party (`src.*`).

One import per line for clarity. Use absolute imports:

```python
# Good
from src.fer.image_pipeline import process
from src.music.recommender import generate_playlist

# Avoid
from .image_pipeline import process   # relative imports break when modules are moved
```

### Naming

- `snake_case` for functions, variables, modules.
- `PascalCase` for classes.
- `UPPER_SNAKE` for module-level constants.
- `_leading_underscore` for module-private.
- Avoid one-letter names except for loop indices (`i`, `j`) and standard abbreviations in their natural context (`x, y, w, h` for bounding boxes, `r, g, b` for colour channels).

### Error handling

- **Fail loudly during development.** Raise specific exceptions; let them propagate to a logging boundary.
- **Catch narrowly.** Never `except Exception:` without a comment explaining why.
- **Wrap third-party errors at module boundaries** if their types leak abstractions:
  ```python
  try:
      sp.current_user()
  except spotipy.SpotifyException as e:
      raise SpotifyAuthError("Token invalid or expired") from e
  ```

### Logging

- Use the standard `logging` module, not `print`.
- One logger per module: `logger = logging.getLogger(__name__)`.
- Levels:
  - `DEBUG` — verbose flow detail, off in production.
  - `INFO` — significant lifecycle events (app start, model loaded, OAuth success).
  - `WARNING` — recoverable issues (quality check failed, retry succeeded).
  - `ERROR` — failures that prevent the operation (model load failed, OAuth failed).
  - `CRITICAL` — fatal, app cannot continue.
- **Never log secrets.** Tokens, passwords, full user emails. The `spotify` module has a filter that redacts known token-shaped strings; extend it as needed.

### File and module structure

- One class per file when the class is non-trivial. Multiple small dataclasses can share a file.
- Module size: aim for < 300 lines. Split when it grows beyond that.
- Tests mirror source structure: `src/fer/image_pipeline.py` → `tests/fer/test_image_pipeline.py`.

---

## JavaScript

### Version

ES2020+. Modern browser features (optional chaining, nullish coalescing, top-level await in modules) are fine — the embedded webview is Chromium-based and recent.

### Formatting

- 2-space indent.
- Semi-colons required.
- Double quotes for strings (`"hello"`), single quotes only when escaping double quotes is awkward.
- Trailing commas in multi-line arrays and objects.

No mandatory formatter (we don't run Prettier), but the above rules are enforced by review.

### Modules

- ES modules with `<script type="module">`. No `require()`, no bundler.
- One concern per file.
- File names: `kebab-case.js` for utilities, `page_name.js` for page logic.

### Naming

- `camelCase` for variables and functions.
- `PascalCase` for classes.
- `UPPER_SNAKE` for module-level constants.
- DOM element IDs and CSS classes: `kebab-case`.

### DOM access

- Use `document.querySelector` / `querySelectorAll`. No jQuery.
- Cache element references in a `const` near the top of the page-level script:
  ```javascript
  const els = {
    shutter: document.querySelector("#shutter"),
    preview: document.querySelector("#webcam-preview"),
    guide:   document.querySelector("#face-guide"),
  };
  ```

### Async

- Prefer `async/await` over chained `.then()`.
- Always `try/catch` around `await` calls that hit the bridge or network.
- Don't fire-and-forget async functions; the resulting unhandled rejection is silent in PyWebView's webview. Either `await` or attach `.catch`.

### Error display

User-facing errors go through a single helper:

```javascript
// js/error_handler.js
export function showError(message, options = {}) { ... }
export function showToast(message, kind = "info") { ... }
```

Don't `alert()`. Don't write to the page directly from each page's script — go through the helper for consistent styling and dismissal.

---

## SQL

### Formatting

- Uppercase keywords (`SELECT`, `JOIN`, `WHERE`, `INSERT INTO`).
- Lowercase identifiers (`snake_case` tables and columns).
- One clause per line for statements over 60 characters.
- Parameter placeholders: `%s` (mysql-connector-python convention) — **never** string-interpolate values into SQL.

```sql
-- Good
SELECT track_id, track_name, artists
FROM music
WHERE valence BETWEEN %s AND %s
  AND energy  BETWEEN %s AND %s
ORDER BY popularity DESC
LIMIT 1000;

-- Bad
select * from music where valence between ? and ?
```

### Migrations

- Numbered prefix: `0001_initial_schema.sql`, `0002_add_index_genre.sql`.
- One concern per migration.
- **Never edit a committed migration.** Add a new one to fix or change schema.
- Migrations may use `CREATE TABLE IF NOT EXISTS` for safety but should be idempotent only when the *content* is identical (no semantic divergence between runs).

---

## Git

### Branches

For a solo project, the rules are minimal:
- `main` is always working.
- Direct commits to `main` are fine for small changes.
- For multi-day work or risky refactors, branch with a descriptive name: `fer-training-pipeline`, `frontend-result-page`.

### Commit messages

Format: `module: short imperative summary`.

```
fer: add Haar cascade face detection
db: create initial schema migration
spotify: implement PKCE auth flow with keyring cache
docs: update FER_MODEL.md with phase-2 fine-tuning notes
```

- ≤ 60 characters in the subject.
- Imperative mood ("add", not "added" or "adds").
- Body (optional) explains *why*, not *what* — the diff shows the what.

### Granularity

- One concern per commit. Don't bundle "frontend changes + model training fix + readme typo" into one commit.
- A working state at every commit. Don't commit broken intermediate states.

### What not to commit

`.gitignore` covers:
- `__pycache__/`, `*.pyc`
- `.venv/`, `venv/`, `env/`
- `.env` (the real one — `.env.example` is committed)
- `data/raw/`, `data/processed/` (datasets and intermediate files)
- `models/*.keras`, `models/*.h5` (often > 50 MB)
- `models/checkpoints/`
- `.idea/`, `.vscode/` (per-developer settings)
- `*.log`, `*.csv` *only inside `data/`* (don't blanket-exclude CSVs; some seed files are CSVs)
- `.DS_Store`, `Thumbs.db`

---

## Testing

### Tools

- `pytest` for everything.
- `pytest-cov` for coverage.

### Structure

- Tests live in `tests/`, mirroring `src/`.
- Fixtures (sample images, sample CSVs) in `tests/fixtures/`.
- A `conftest.py` at `tests/` level defines shared fixtures (DB connection, etc.).

### Naming

- Test files: `test_<module>.py`.
- Test functions: `test_<what_is_being_tested>()`.
- Be descriptive: `test_decode_invalid_base64_raises_value_error` not `test_decode_1`.

### Markers

- `@pytest.mark.slow` — tests that take > 5 seconds or hit external resources. Run with `pytest -m slow` explicitly; excluded from default runs.
- `@pytest.mark.integration` — tests requiring a real MySQL instance.

### Coverage target

- Aim for ≥ 70% statement coverage on `src/`.
- 100% is not the goal — covering trivial code distorts the metric. Focus on:
  - Image pipeline (every error path).
  - Recommender (every emotion, edge cases).
  - DB queries (with a test schema).
- Frontend JS is **not** covered by automated tests (vanilla JS, no test runner). Manual test checklist in `docs/TESTING.md`.

### Determinism

- Seed random sources in every test that uses them.
- Mock external services (`spotipy`, network calls) with `pytest-mock` or `unittest.mock`. Never hit Spotify in unit tests.

---

## Dependencies

### Adding a dependency

Before `pip install`-ing anything new:

1. Verify it's necessary (can it be done with stdlib or existing deps?).
2. Check its licence (must be permissive: MIT, BSD, Apache, PSF).
3. Check it's actively maintained (last release in past 12 months).
4. Add to `requirements.txt` with a pinned version range:
   ```
   tensorflow>=2.15,<2.17
   opencv-python>=4.8
   mysql-connector-python>=8.2
   ```
5. Commit `requirements.txt` alongside the code that uses the new dependency.

### What's currently locked

| Package | Why |
|---|---|
| `tensorflow` | Core ML framework. Pin to a known-working minor version. |
| `opencv-python` | Image processing. `opencv-python-headless` would be lighter but webcam APIs need the full package. |
| `numpy` | Transitive via TF and OpenCV. Don't pin separately unless conflict. |
| `pandas` | Used only in scripts (data prep), not the app. |
| `mysql-connector-python` | Official Oracle connector. Faster than PyMySQL for our use. |
| `python-dotenv` | Load `.env` files. |
| `spotipy` | Spotify Web API client + OAuth. |
| `keyring` | OS keychain access. |
| `pywebview` | Desktop wrapper. |
| `pytest`, `pytest-cov` | Tests. |
| `black`, `ruff` | Formatting + linting. |

### What's forbidden without explicit approval

- Web framework (Flask, FastAPI, Django) — we don't need a server.
- Frontend framework (React, Vue) — vanilla JS suffices.
- ORM (SQLAlchemy, Tortoise) — raw SQL is the default; reconsider only if schema grows substantially.
- HTTP client other than `requests` (already a Spotipy transitive dep).
- Logging frameworks (loguru, structlog) — stdlib `logging` is enough.
- Configuration frameworks (dynaconf, hydra) — `.env` + module constants is enough.

If you find yourself wanting one of these, surface it as a discussion before adding.

---

## Comments

- Comment **why**, not **what**.
- Comment surprising behaviour, magic numbers, and non-obvious workarounds.
- Don't comment trivial code:
  ```python
  # Bad
  i = i + 1  # increment i

  # Good
  # Spotify returns 429 with a Retry-After header even for batch calls;
  # honour it instead of using a fixed backoff.
  ```
- Use `TODO(name): ...` for follow-ups. The name attribution helps in a multi-person review.
- Use `FIXME: ...` for known broken-ish code that should not ship.

---

## Performance

Don't optimise prematurely. The performance budget for each component is in its respective doc; respect those, but don't pre-optimise micro-things.

When optimising:
1. Measure first (`time.perf_counter` for short spans, `cProfile` for fuller profiles).
2. Identify the single slowest stage.
3. Optimise it.
4. Measure again.

Common pitfalls already addressed:
- Don't use `ORDER BY RAND()` in SQL — sample in Python.
- Don't reload the Keras model on every inference — cache as a module-level singleton.
- Don't decode the same image twice — pass numpy arrays between pipeline stages.

---

## Related docs

- `CLAUDE.md` — high-level conventions.
- `docs/TESTING.md` — test plan and procedures.
- `docs/BUILD_PLAN.md` — what we're building.
