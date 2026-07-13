# docs/FRONTEND.md

The HTML/CSS/JS layer that runs inside the PyWebView window.

For the Python side of the bridge, see `docs/SPOTIFY_INTEGRATION.md` and the `api/` module. For UI requirements that come from the planning doc, see CP1 §3.5 (Low-Fidelity Prototypes).

---

## Stack choices

| Decision | Choice | Why |
|---|---|---|
| Framework | None — vanilla HTML/CSS/JS | Minimum dependencies for a solo capstone. No build step. |
| Module system | Native ES modules (`<script type="module">`) for bridge logic; plain scripts for the imported design pages | Supported in Chromium-based webviews. No bundler needed. |
| CSS approach | Tailwind utility classes via a **vendored** Tailwind Play build (`js/vendor/tailwind.js`, JIT in-browser, **no build step**) + shared `css/app.css` (custom effects) + `css/fonts.css` (self-hosted webfonts) | The high-fidelity prototype was authored in Google Stitch on Tailwind. Vendoring the Play build keeps it pixel-faithful and fully offline without a Node build step. Tailwind is a CSS utility layer, **not** a JS framework — the "no React/Vue" rule still holds. |
| Templating | None — DOM manipulation directly | Pages are few and simple |
| Routing | Window-level navigation between HTML files | PyWebView allows `window.location = 'pages/result.html'`; no SPA router needed |
| Audio | Spotify Web Playback SDK | See `docs/SPOTIFY_INTEGRATION.md` |
| Webcam | `navigator.mediaDevices.getUserMedia` (built-in) | No library required |

**Do not** introduce React, Vue, Svelte, or any framework. The owner is a sole developer; the frontend is small enough that vanilla JS stays cleanest.

---

## High-fidelity design import (MoodStream / "Vibe Canvas")

The CP2 high-fidelity prototype was designed in **Google Stitch** and exported as Tailwind HTML (see the *Prototype Interfaces Code* PDF and `DESIGN.md`). It has been imported as **static, faithful pages** — full look-and-feel with plain `window.location` navigation between screens, but **no Python bridge calls yet**. The bridge/camera/playback wiring described further down is layered on next, replacing the placeholder navigation.

Vendored, fully-offline dependencies (no internet needed to render):

- `frontend/js/vendor/tailwind.js` — Tailwind Play build (with the `forms` + `container-queries` plugins). JITs utilities in-browser; no build step.
- `frontend/js/tailwind-config.js` — shared theme (colours / type / spacing tokens). Loaded **immediately after** `tailwind.js` on every page.
- `frontend/css/fonts.css` — self-hosted Inter (400/500/600), Montserrat (600/700) and Material Symbols Outlined (`frontend/assets/fonts/*.woff2`).
- `frontend/css/app.css` — hand-written effects from the prototype `<style>` blocks (entrance animation, scrollbar, camera/scanner/glass/glow/progress).

Content imagery from the Stitch export (avatars, album art, hero/emoji/illustration graphics) pointed at expiring Google CDN URLs, so it is replaced with on-brand **Material Symbols** placeholders and gradient tiles. Real artwork arrives at runtime (Spotify profile avatar, album covers from the catalogue).

## Pages

Per CP1 §3.5, there are 6 core pages plus the OAuth/Premium gating screens at first launch. Current state after the design import (✅ imported, ⬜ not built yet):

```
frontend/
├── index.html              ✅ auth gate (session + Premium checks → login / premium_required / home)
├── pages/
│   ├── login.html          ✅ Spotify login button, Premium-required notice
│   ├── premium_required.html ✅ hard block when /me returns product != "premium"
│   ├── home.html           ✅ main screen — emotion scanner + manual chips + sample playlist
│   ├── photo.html          ✅ webcam capture (viewfinder, scan line, detection oval)
│   ├── mood.html           ✅ manual mood selection (5 emotion cards)
│   ├── loading.html        ✅ "Analyzing Emotion…" (rings + progress)
│   ├── result.html         ✅ recommended playlist (data-driven per emotion)
│   └── error.html          ✅ out-of-scope / failure state with "Back to Home"
├── css/
│   ├── fonts.css           ✅ self-hosted @font-face + Material Symbols base
│   └── app.css             ✅ shared custom effects (animations, glass, scanner, …)
├── assets/fonts/*.woff2    ✅ Inter / Montserrat / Material Symbols
└── js/
    ├── vendor/tailwind.js  ✅ vendored Tailwind Play build
    ├── tailwind-config.js  ✅ shared theme tokens
    ├── chrome.js           ✅ shared page chrome (sidebar shell + top bar + bottom player), responsive drawer, nav wiring, header-scroll, profile chip + account dropdown (logout)
    ├── titlebar.js         ✅ frameless-window controls (min/max/close + drag regions); loads after chrome.js
    ├── home.js             ✅ hero zoom + manual-mood / scan navigation + live "latest saved playlist" showcase
    ├── mood.js             ✅ mood-card selection → loading
    ├── loading.js          ✅ the real flow: detect_emotion (camera) + generate_playlist → result / error
    ├── result.js           ✅ real detection playlist + save button + live saved-playlist view (#playlist=<id>)
    ├── shader.js           ✅ optional WebGL "Vibe Canvas" background (opt-in)
    ├── bridge.js           ✅ callPy()/callPyWithTimeout(): pywebviewready wait + timeout
    ├── auth_gate.js        ✅ runs on index.html; routes to login / premium / home
    ├── login.js            ✅ login page: start_spotify_login with a long-timeout bridge call
    ├── premium_required.js ✅ premium gate: upgrade link (system browser), re-check, logout
    ├── sidebar.js          ✅ saved-playlists sidebar — live data (open / rename / delete via kebab menu)
    ├── playlists_ui.js     ✅ shared tracklist-row / duration / emotion-theme helpers (home, result, sidebar)
    ├── camera.js           ✅ webcam preview + 2 Hz face guide (quick_face_check) + capture/retake/use (replaced photo.js)
    ├── playback.js         ⬜ Spotify SDK initialisation + playback control (replaces the placeholder bottom player rendered by chrome.js)
    └── error_handler.js    ✅ maps sessionStorage.error_code to the user-facing message on error.html
```

### Custom title bar (frameless window)

The window is created with `frameless=True` (`src/main.py`), so the OS title
bar is gone and `js/titlebar.js` provides the replacement on **every** page:

- **Chrome pages** (`#app-header` exists): minimize / maximize / close buttons
  are appended into the top app bar and the bar's spare flex space becomes the
  drag region — Spotify-desktop style, no extra bar, no layout change. Load
  order matters: `chrome.js` → `titlebar.js` → page script.
- **Pre-auth pages** (gate / login / premium, no header): a slim transparent
  overlay strip is injected across the top (brand mark left, controls right).
- Dragging: pywebview turns any element with the `pywebview-drag-region` class
  into a drag handle (`easy_drag` is off so page content never drags the
  window). Double-clicking a drag region toggles maximize.
- The buttons call the `window_minimize` / `window_toggle_maximize` /
  `window_close` / `window_is_maximized` bridge methods (`src/api/bridge.py`),
  which drive the pywebview window; maximized state is read from the native
  form so Win+Arrow snapping can't desync the toggle icon.
- **Resizing:** pywebview's WinForms backend does not hit-test resize borders
  on frameless windows, so `titlebar.js` injects invisible strips along all
  four edges + corners (`data-resize`, resize cursors). A pointer drag first
  calls `window_begin_resize(edge)` — which captures the anchor rectangle
  **once** and returns the starting size — then streams `window_resize(w, h)`
  steps, each an absolute Win32 `SetWindowPos` computed from that fixed
  anchor. ⚠️ Do **not** use pywebview's `resize(fix_point=...)` for this: it
  re-reads the form's cached bounds on every call, and under a fast drag those
  reads race the UI thread's updates — the error compounds until the window
  walks off-screen (observed live). Sizes clamp to the shared minimum
  (`MIN_WINDOW_WIDTH/HEIGHT` in `src/api/bridge.py`). JS CSS pixels differ
  from native pixels under Windows display scaling, so the drag calibrates a
  scale factor from the begin-call's size / `window.outerWidth`. Handles are
  inert while maximized. Note: drag-to-screen-edge Aero snap does not trigger
  (drag/resize are programmatic); Win+Arrow snapping still works.
- `src/main.py` additionally sets the title-bar/taskbar icon (WinForms
  `Form.Icon` via `Form.Invoke` — pywebview's `icon` kwarg is GTK/QT-only) and
  asks DWM to round the frameless window's corners on Windows 11.

### Shared chrome & responsiveness

The sidebar, top app bar and bottom player were duplicated verbatim in every
page. They are now defined **once** in `js/chrome.js` and injected per page.

- Each page sets `<body data-page="home|mood|photo|loading|result|error">`;
  `chrome.js` reads it to decide which header to render (full app bar vs the
  simplified "back" header on `photo.html`), whether to show the bottom player,
  and whether to show the sidebar "Scan Emotion" button.
- `chrome.js` is the **last** script before the page's own script and runs
  synchronously during body parse, so the injected nodes exist (and are present
  at `DOMContentLoaded`, so Tailwind JIT styles them) before page code runs.
- Navigation is wired by event delegation on `[data-nav]` (home / scan / back /
  forward / open-sidebar / close-sidebar). Controls with no backend yet
  (search, notifications, sidebar playlist links, player transport) carry
  `data-placeholder` and are no-ops for now.
- **Responsive:** at `lg` (≥1024px) the layout is the fixed 280px sidebar + main
  canvas. Below `lg` the sidebar becomes an off-canvas drawer toggled by the
  header hamburger (with a dimming backdrop), the main column goes full width
  (`lg:ml-[280px]` → `ml-0`), the mood-card grid restacks, the tracklist drops
  its Album column (`.track-grid` / `.track-col-album` in `app.css`), and the
  player hides the waveform + secondary controls. Target floor ≈ 700px wide.

Each imported page's `<head>` uses this boilerplate (paths relative to `pages/`):

```html
<link rel="stylesheet" href="../css/fonts.css">
<link rel="stylesheet" href="../css/app.css">
<script src="../js/vendor/tailwind.js"></script>
<script src="../js/tailwind-config.js"></script>
```

---

## Routing

Plain `<a href>` and `window.location.assign()` between HTML files. No History API gymnastics.

Each page's `<head>` includes the same boilerplate:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Emotion Music Rec</title>
  <link rel="stylesheet" href="../css/base.css">
  <link rel="stylesheet" href="../css/sidebar.css">
  <link rel="stylesheet" href="../css/pages/<page-name>.css">
  <script type="module" src="../js/bridge.js"></script>
  <script type="module" src="../js/sidebar.js"></script>
  <script type="module" src="../js/<page-name>.js"></script>
</head>
```

The Spotify SDK is loaded once, at `index.html`, and survives across page navigations only if we use the History API or single-page navigation. Since we use file navigation, **the SDK reinitialises on every page**. This is fine — `player.connect()` is fast (sub-second), and the access token is cached in the keyring.

**Decision:** Keep file navigation for now; reconsider if SDK reinit causes audio glitches. If it does, refactor to a single `index.html` with hash routes.

---

## The bridge wrapper

PyWebView's `pywebview.api.method(...)` returns a Promise. Wrap it for consistent error handling (as-built in `frontend/js/bridge.js`):

```javascript
// frontend/js/bridge.js (abridged — see the module)
const BRIDGE_TIMEOUT_MS = 30000;

export async function callPy(method, ...args) {
  return callPyWithTimeout(BRIDGE_TIMEOUT_MS, method, ...args);
}

export async function callPyWithTimeout(timeoutMs, method, ...args) {
  // Promise.race between the bridge invocation and a timeout rejection.
  // The invocation first awaits bridgeReady(): resolves immediately when
  // window.pywebview.api exists, else waits for the `pywebviewready` event
  // (pitfall #5 below — fast page loads can beat the bridge injection).
}
```

Use it as: `const result = await callPy("detect_emotion", base64Image);`

The 30-second default timeout is a guard against the Python side hanging (e.g. model loading failing silently). 30 seconds is generous — actual end-to-end should be < 5 s. **Exception:** `start_spotify_login` legitimately blocks while the user completes OAuth in their browser (Python waits up to 180 s), so `login.js` calls it via `callPyWithTimeout(190000, "start_spotify_login")` — Python must time out first so its specific error message, not a generic bridge timeout, reaches the user.

---

## Page-by-page detail

### `index.html` — auth gate

Single responsibility: check session state and redirect.

```javascript
// frontend/js/auth_gate.js (as-built; the module adds a status line)
import { callPy } from "./bridge.js";

// Bridge rejections carry the Python exception class name as error.name
// (pywebview sets it from type(e).__name__). These classes raise with a
// user-facing message, shown verbatim on the login page — see
// docs/SPOTIFY_INTEGRATION.md > Refresh for the full table.
const USER_FACING_ERRORS = new Set([
  "SpotifyUserNotRegisteredError", // account not in the app's dev-mode allowlist
  "SpotifySessionExpiredError", // refresh token revoked/expired — re-login fixes it
  "SpotifyNetworkError", // offline / Spotify unreachable — retry fixes it
]);

window.addEventListener("load", async () => {
  try {
    if (!(await callPy("has_spotify_session"))) {
      window.location.replace("pages/login.html");
      return;
    }
    const profile = await callPy("verify_premium");
    if (!profile.premium) {
      window.location.replace("pages/premium_required.html");
      return;
    }
    // Save profile to sessionStorage for sidebar / header use
    sessionStorage.setItem("spotify_profile", JSON.stringify(profile));
    window.location.replace("pages/home.html");
  } catch (err) {
    // Session unusable. Deliberately NOT calling logout — a transient network
    // failure must not destroy a good refresh token. A fresh login overwrites
    // the cache anyway. Known failures (allowlist rejection, revoked refresh
    // token, network down) show their own actionable message from Python;
    // anything unexpected falls back to the generic notice.
    const notice = USER_FACING_ERRORS.has(err?.name)
      ? err.message
      : "We couldn't restore your Spotify session. Please log in again.";
    sessionStorage.setItem("login_notice", notice);
    window.location.replace("pages/login.html");
  }
});
```

`location.replace` (not `assign`) keeps the gate page out of the back-history, so the header's Back button never re-runs the gate.

### `login.html`

```
┌─────────────────────────────────────┐
│      Emotion Music Recommender      │
│                                     │
│       [ Login with Spotify ]        │
│                                     │
│   Requires Spotify Premium account  │
└─────────────────────────────────────┘
```

```javascript
// frontend/js/login.js (abridged — see the module)
import { callPyWithTimeout } from "./bridge.js";

const LOGIN_TIMEOUT_MS = 190000; // > Python's 180 s LOGIN_TIMEOUT_SECONDS

els.loginBtn.addEventListener("click", async () => {
  els.loginBtn.disabled = true;
  setStatus("Opening Spotify in your browser… finish logging in there.");
  try {
    const result = await callPyWithTimeout(LOGIN_TIMEOUT_MS, "start_spotify_login");
    if (result.success) {
      window.location.replace("../index.html");  // re-runs the auth gate
      return;
    }
    setStatus(result.error, true);
  } catch (err) {
    setStatus(err.message, true);
  }
  els.loginBtn.disabled = false;
});
```

The page also shows the one-shot `sessionStorage.login_notice` left by the auth gate — a specific notice where the cause is known (account not allowlisted, session expired/revoked, Spotify unreachable; see `docs/SPOTIFY_INTEGRATION.md` > Refresh) or the generic "couldn't restore your session" otherwise.

### `premium_required.html`

Hard block for Free accounts (see `docs/SPOTIFY_INTEGRATION.md` > Premium verification). Three actions, wired in `js/premium_required.js`:

- **Get Spotify Premium** → `callPy("open_external_url", "https://www.spotify.com/premium/")` — opens the **system** browser via an allowlisted bridge method; the webview itself must never navigate away from the app.
- **I've upgraded — check again** → `location.replace("../index.html")`, re-running the gate (`verify_premium()` does a fresh `/me` fetch).
- **Use a different account** → `callPy("logout")` then `login.html`.

It also shows a best-effort "Logged in as X (free account)" line from `get_user_profile`.

### `home.html`

Layout (planning doc Figure 17):

```
┌──────────┬─────────────────────────────────────────────┐
│ Playlists│                                             │
│ ─────    │   ┌─────────────────────────────────────┐  │
│ Happy    │   │      📷                              │  │
│ Sad      │   │  Scan Emotion for Recommended       │  │
│ Calm     │   │           Playlist                   │  │
│   ...    │   │       [ Take Photo ]                 │  │
│ + New    │   └─────────────────────────────────────┘  │
│          │                                             │
│          │   Prefer not to show your face?            │
│          │   Choose your mood manually  [ Mood ]      │
│          │                                             │
│          │   Recently played: ─────                   │
└──────────┴─────────────────────────────────────────────┘
```

```javascript
document.querySelector("#take-photo-btn").addEventListener("click", () => {
  window.location.assign("photo.html");
});
document.querySelector("#manual-mood-btn").addEventListener("click", () => {
  window.location.assign("mood.html");
});
```

As-built addition: below the scanner hero and the mood chips, `home.js` renders
a **"Your latest playlist"** showcase — the newest saved playlist
(`list_user_playlists[0]` → `load_playlist`) with cover, meta line and the
first 5 tracks (plus a "View all N songs" row). The section stays hidden while
nothing has been saved yet. Cover, title and the "Open playlist" button all
open `result.html#playlist=<id>`.

### `photo.html`

Two states, as-built in `js/camera.js` (which replaced the placeholder `photo.js`):

1. **Preview** — `getUserMedia` (1280×720 ideal, user-facing) streams into
   `#webcam-preview`, mirrored via CSS for a natural selfie view (the captured
   data itself is **not** mirrored). Every 500 ms a ≤320 px JPEG frame goes to
   `quick_face_check` and the oval guide (`#face-guide`) turns green (exactly
   one face) or red (none / several); the status line under the viewfinder
   explains, and `#capture-btn` is enabled only on green. The loop is a
   chained `setTimeout` with an in-flight guard — never more than one ping on
   the bridge at once, so slow calls (e.g. FER warm-up holding the lock) can't
   pile up; each ping has a 5 s timeout and a failed ping just locks the
   shutter and keeps trying.
2. **Captured** — the shutter grabs the **full-resolution frame as lossless
   PNG** (JPEG artefacts could distort facial features — see
   `docs/IMAGE_PIPELINE.md`), freezes it in `#captured-preview`, and shows
   **Retake** / **Use this photo**. "Use" stashes the base64 payload in
   `sessionStorage.captured_image_b64` with `emotion_source = "camera"` and
   navigates to `loading.html`, which runs `detect_emotion`.

Camera lifecycle: the stream stops on `pagehide` (the camera light never stays
on after leaving the page) and before navigating to loading. If the camera
can't start (permission denied / no device), the status line says why and a
"Try camera again" button appears; the shutter stays disabled.

The live guide is purely a UI aid — the authoritative single-face gate and
quality checks still run inside `detect_emotion` on the shutter frame. If the
2 Hz ping ever proves too slow on target hardware, fall back to client-side
detection (browser `FaceDetector` / face-api.js) — not needed so far.

### `mood.html`

```
┌──────────┬─────────────────────────────────────────────┐
│ Sidebar  │       WHAT IS YOUR CURRENT MOOD?            │
│          │                                             │
│          │   [ 😊 Happy ]  [ 😯 Surprise ] [ 😠 Angry ]│
│          │                                             │
│          │       [ 😐 Neutral ]    [ 😢 Sad ]          │
└──────────┴─────────────────────────────────────────────┘
```

```javascript
// frontend/js/mood.js (as-built)
let picked = false;
document.querySelectorAll(".mood-card").forEach((card) => {
  card.addEventListener("click", () => {
    if (picked) return; // already navigating; a second card must not win
    picked = true;
    sessionStorage.setItem("last_emotion", card.dataset.emotion);
    sessionStorage.setItem("emotion_source", "manual");
    // Manual picks skip inference — drop any capture left over from an
    // abandoned photo run (a full-res PNG is multi-MB of sessionStorage).
    sessionStorage.removeItem("captured_image_b64");
    window.location.assign("loading.html");
  });
});
```

The quick emotion chips on `home.html` (`.mood-chip` in `home.js`) do exactly
the same, skipping the mood page entirely. `loading.html` takes no query
parameter — `loading.js` branches on `sessionStorage.emotion_source` alone.

### `loading.html`

The bridge work happens directly on this page (`js/loading.js`, a module), then
it navigates to result or error. As-built flow:

- **Camera path** (`emotion_source === "camera"`): reads
  `sessionStorage.captured_image_b64` and **removes it immediately** (consumed
  either way — multi-MB of PNG must not outlive the one call that needs it),
  then `callPy("detect_emotion", b64)`.
  - `status === "out_of_scope"` → `error_code = "out_of_scope"`,
    `detected_emotion = result.detected` → error.html.
  - `status === "error"` → `error_code = result.error` (no_face,
    multiple_faces, low_quality_*, decode_failed) → error.html.
  - `status === "ok"` → `last_emotion = result.emotion`, continue.
- **Manual path** (`"manual"`): the emotion is already in
  `sessionStorage.last_emotion` (mood card / home chip); inference is skipped.
- **Both**: `callPy("generate_playlist", emotion)` (backend default size, 25)
  → `current_playlist` (JSON) + `playlist_emotion` → result.html. An empty
  list maps to `error_code = "playlist_failed"`; a rejected bridge promise
  (backend raised / timed out) maps to `"unexpected"`.
- Landing here with no flow behind it (deep link, stale history) goes straight
  home rather than erroring.

Two as-built details:

- **Every exit uses `location.replace`** — the page is transient and its
  inputs are consumed on the way through, so the Back button must never
  re-enter it (history after a camera run reads photo → result).
- **Minimum display time** (~1.5 s from load to navigation): the manual path
  is one fast DB query and the analyzing animation would otherwise flash for a
  frame, which reads as a glitch.
- **Staged progress bar** (`#loading-progress`, width + CSS transition): a
  bridge call is one opaque await — no real percentage exists — so the fill
  glides toward the running stage's cap (55% during `detect_emotion`, 90%
  during `generate_playlist`, slower than any healthy call takes) and the
  finishing fill to 100% is timed to land just before navigation, inside the
  minimum-display window. Error exits leave the bar where it stopped. The
  shimmer sweep (`.progress-bar-fill` in `app.css`) stays on top.

The status lines (`#loading-status` / `#loading-substatus`) switch from the
static "Analyzing Emotion..." copy to "Building your playlist..." when
inference is done.

**sessionStorage caveat:** Spotify Playback SDK uses localStorage; we use sessionStorage for app state. PyWebView shares storage between pages within the same window. Confirm both work in early build verification.

### `result.html`

```
┌──────────┬─────────────────────────────────────────────┐
│ Sidebar  │   😊                                         │
│          │   You seem Happy!                            │
│          │   We've made a playlist to match this vibe. │
│          │                                              │
│          │   ┌───────┐  Happy Playlist                 │
│          │   │  😊   │  ─────                          │
│          │   │       │  Track 1     Artist     3:45    │
│          │   └───────┘  Track 2     Artist     4:12    │
│          │   [Save][▶][Edit]   ...                     │
└──────────┴─────────────────────────────────────────────┘
```

As-built (detection view, `js/result.js`): reads `current_playlist` +
`playlist_emotion` (stashed by loading.js). If either is missing or unusable
(deep link, stale history) the page heads home — there is nothing real to
show. Otherwise it themes the mood banner per emotion, renders the real
tracks via the shared `playlists_ui.js` helpers, and computes the meta line
(per-emotion flavour lead + real `formatPlaylistMeta` counts).

Buttons under the title:

- **Save** (`#save-playlist-btn`, bookmark icon): calls
  `save_playlist(name, emotion, track_ids)` with a name like
  `Happy — Jul 12, 9:41 PM` (the timestamp keeps repeat saves of the same
  mood tellable apart in the flat sidebar list). On success the bookmark
  fills with the emotion accent, the button stays disabled (double-saving
  only clutters the sidebar), a toast confirms, and
  `refreshSidebarPlaylists()` (imported from `sidebar.js`) shows the new row
  live. On failure the button re-enables with an error toast. The saved
  view (`#playlist=<id>`) removes this button — it's already saved.
- **Play-all** (`#playlist-play-btn`): wired by `playback.js` (F7); removed
  in Free mode.
- **Edit** (remove tracks before saving): deferred — `data-placeholder`
  no-op for now. Adds (searching for new tracks) is a further stretch goal.

Toasts are a DIY 10-liner in result.js (PyWebView has no reliable
`alert()`): a fixed bottom-centre pill that fades after ~2 s.

As-built addition — **saved-playlist view**: when the page is opened as
`result.html#playlist=<id>` (sidebar rows, home showcase), `result.js` drops
the mood banner (a saved playlist isn't a fresh detection) and renders the
stored playlist from `load_playlist`: real tracks, a computed
songs-and-duration meta line, and the per-emotion accent (theme primary for
user-created playlists with no source emotion). Free accounts get the same
degradation as the detection view — no play-all affordances, each track opens
in Spotify via its real `track_id`. A deleted/unknown id shows "Playlist not
found". The page reloads itself on `hashchange` so sidebar clicks that only
change the hash re-render.

### `error.html`

Shows a message keyed by `sessionStorage.error_code` (`js/error_handler.js`):

```javascript
const ERROR_MESSAGES = {
  no_face:           "We couldn't see a face. Please centre your face in the frame and try again.",
  multiple_faces:    "We detected more than one face. Please make sure only one person is in the photo.",
  low_quality_blur:  "The image is too blurry. Please hold the camera steady.",
  low_quality_dark:  "The image is too dark. Move to a brighter spot.",
  low_quality_bright:"The image is too bright. Reduce glare or move away from direct light.",
  decode_failed:     "Something went wrong reading the photo. Please try again.",
  playlist_failed:   "We couldn't build a playlist just now. Please try again in a moment.",
  out_of_scope:      detected => `We detected ${detected}, which isn't supported for music recommendations. Try choosing your mood manually.`,
};
// Unknown codes (incl. "unexpected") fall back to
// "An unexpected error occurred. Please try again."
```

As-built details: the keys are read, not consumed, so refreshing the page
keeps the message; opened with no `error_code` at all (design preview) the
static prototype copy stays. "Back to Home Page" is a plain `<a href>`.

---

## Sidebar (shared across pages)

As-built: `chrome.js` renders the sidebar shell with an empty
`#sidebar-playlists` container on every chrome page; `js/sidebar.js` (a module
loaded right after `chrome.js`/`titlebar.js` on all six pages) fills it from
`list_user_playlists` on every page load (cheap query, newest-updated first).

Each row shows the emotion emoji (from `playlists_ui.js`'s `EMOTION_THEMES`;
`music_note` for user-created playlists without a source emotion), the name and
the song count. Interactions:

- **Click** → opens `result.html#playlist=<id>` (the saved-playlist view). The
  row of the playlist currently open on the result page is highlighted.
  `result.js` reloads on `hashchange`, so switching playlists while already on
  the result page works.
- **Kebab menu (⋯, appears on hover)** → **Rename** (inline input in place;
  Enter commits via `rename_playlist`, Esc/blur cancels) and **Delete** (the
  menu item turns into "Confirm delete?" — the second click calls
  `delete_playlist`; PyWebView doesn't reliably support `window.confirm`).
  Deleting the playlist currently open on the result page navigates home.

### Header profile chip (chrome.js)

The top-right circle shows the first letter of the Spotify display name from
`sessionStorage.spotify_profile` (stashed by the auth gate for Premium users
and by `premium_required.js` for Free mode); the generic person icon stays when
no profile is stashed. Clicking it opens an account dropdown — display name,
email, Premium/Free badge — with a **Log out** button that calls the `logout`
bridge method (directly via `pywebview.api`, since `chrome.js` is a plain
script) and returns to `login.html`. The notifications button was removed
(owner decision, July 2026).

---

## Spotify SDK integration

The SDK script is loaded in `index.html` (and any page that needs playback):

```html
<script src="https://sdk.scdn.co/spotify-player.js"></script>
```

The `window.onSpotifyWebPlaybackSDKReady` callback (see `docs/SPOTIFY_INTEGRATION.md`) initialises the player. Stash `window.spotifyPlayer` and `window.spotifyDeviceId` for use by `playback.js`'s play/pause/skip helpers.

The Premium check has already been done before any playback page is reachable, so by the time `playback.js` runs, we can assume Premium.

---

## Styling notes

The realised design system is **"Vibe Canvas"** (dark, glassmorphic). Tokens live in `js/tailwind-config.js`; the canonical reference is `DESIGN.md`.

- **Colour palette:** deep navy-charcoal surfaces (`background`/`surface` `#0b1326`, tiered `surface-container*` greys), soft-purple **primary** (`#ddb7ff`) for actions/active states, emerald **secondary** (`#4edea3`) for play/success. Result page applies an emotion-specific accent (happy → green, surprised → teal-green, sad → blue, neutral → amber, angry → red) — see `js/result.js`.
- **Typography:** Montserrat for headlines, Inter for body/labels — self-hosted (latin subset) in `css/fonts.css`, no network needed. Icons via the self-hosted Material Symbols Outlined variable font.
- **Layout:** fixed 280px sidebar + main canvas (max 1440px) + fixed 64px top app bar + fixed 96px bottom player. Flexbox throughout; CSS Grid for the mood card grid and the tracklist columns.
- **Sizing:** target 1280×800 minimum.
- **Elevation:** tonal layering + glassmorphism (`backdrop-blur`, 1px white/10 borders, primary-tinted soft shadows). Buttons are pill-shaped; cards/inputs use `rounded-lg` (8px), hero/scanner use `rounded-xl`+.

The planning doc's prototypes (Figures 17–22) were low-fidelity; the high-fidelity prototype (this Stitch/MoodStream export) is now imported — see *High-fidelity design import* above.

---

## Testing the frontend

For a vanilla JS app, manual testing is the default. Automated frontend tests are out of scope for CP1/CP2.

Manual test checklist (recorded in `docs/TESTING.md`):
- Cold start with no session → login flow appears.
- Login completes → home appears.
- Take photo with one face → result appears with a playlist.
- Take photo with no face → error page with correct message.
- Take photo with two faces → error page with correct message.
- Manual mood selection → result appears.
- Click play on a track → audio plays.
- Save a playlist → appears in sidebar after refresh.
- Delete a saved playlist → disappears from sidebar.
- Logout → returns to login.

---

## Common frontend pitfalls

1. **Forgetting `type="module"` on scripts that use `import`.** Browser silently fails. Use the dev tools console to verify.
2. **CORS issues calling Spotify Web API from `file://`-served pages.** PyWebView serves pages from `file://` by default. Spotify's API has permissive CORS, but some older endpoints don't. If a `fetch` to Spotify fails with CORS, route the call through Python.
3. **Webcam permission denied silently.** First-time `getUserMedia` prompts the OS for camera permission. On macOS this requires app-level entitlements; document the first-launch dialog.
4. **`sessionStorage` cleared on navigation.** It isn't — `sessionStorage` persists within the same window/tab. Don't confuse it with `localStorage`.
5. **PyWebView API not ready.** On very fast page loads, `pywebview.api.*` may not be available yet. Always wait for the `pywebviewready` event before first bridge call, or check `window.pywebview` exists.

---

## Related docs

- `docs/SPOTIFY_INTEGRATION.md` — every bridge method called from here.
- `docs/IMAGE_PIPELINE.md` — what `detect_emotion` does on the Python side.
- `docs/RECOMMENDATION.md` — what `generate_playlist` returns.
- `docs/ARCHITECTURE.md` — overall data flow.
