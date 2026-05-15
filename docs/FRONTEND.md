# docs/FRONTEND.md

The HTML/CSS/JS layer that runs inside the PyWebView window.

For the Python side of the bridge, see `docs/SPOTIFY_INTEGRATION.md` and the `api/` module. For UI requirements that come from the planning doc, see CP1 §3.5 (Low-Fidelity Prototypes).

---

## Stack choices

| Decision | Choice | Why |
|---|---|---|
| Framework | None — vanilla HTML/CSS/JS | Minimum dependencies for a solo capstone. No build step. |
| Module system | Native ES modules (`<script type="module">`) | Supported in Chromium-based webviews. No bundler needed. |
| CSS approach | One stylesheet per page + a shared `base.css` | Small project; component libraries are overkill |
| Templating | None — DOM manipulation directly | Pages are few and simple |
| Routing | Window-level navigation between HTML files | PyWebView allows `window.location = 'pages/result.html'`; no SPA router needed |
| Audio | Spotify Web Playback SDK | See `docs/SPOTIFY_INTEGRATION.md` |
| Webcam | `navigator.mediaDevices.getUserMedia` (built-in) | No library required |

**Do not** introduce React, Vue, Svelte, or any framework. The owner is a sole developer; the frontend is small enough that vanilla JS stays cleanest.

---

## Pages

Per CP1 §3.5, there are 6 pages plus the OAuth/Premium gating screens at first launch.

```
frontend/
├── index.html              ← landing; routes based on auth state
├── pages/
│   ├── login.html          ← Spotify login button, Premium-required notice
│   ├── premium_required.html ← shown when /me returns product != "premium"
│   ├── home.html           ← main screen (Figure 17 in planning doc)
│   ├── photo.html          ← webcam capture (Figure 18)
│   ├── mood.html           ← manual mood selection (Figure 19)
│   ├── loading.html        ← inference in progress (Figure 20)
│   ├── result.html         ← recommended playlist (Figure 22)
│   └── error.html          ← error states with retry (Figure 21)
├── css/
│   ├── base.css            ← shared: colours, typography, layout primitives
│   ├── sidebar.css         ← shared sidebar with saved playlists
│   └── pages/*.css         ← per-page styles
└── js/
    ├── bridge.js           ← wrapper for pywebview.api with timeout + error handling
    ├── auth_gate.js        ← runs on index.html; routes to login / premium / home
    ├── camera.js           ← webcam preview + capture
    ├── home.js             ← home page logic
    ├── photo.js            ← photo page logic
    ├── mood.js             ← mood page logic
    ├── result.js           ← result page logic
    ├── playback.js         ← Spotify SDK initialisation + playback control
    ├── sidebar.js          ← saved-playlists sidebar
    └── error_handler.js    ← maps error codes to user-facing messages
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

PyWebView's `pywebview.api.method(...)` returns a Promise. Wrap it for consistent error handling:

```javascript
// frontend/js/bridge.js
const BRIDGE_TIMEOUT_MS = 30000;

export async function callPy(method, ...args) {
  const fn = pywebview?.api?.[method];
  if (typeof fn !== "function") {
    throw new Error(`Bridge method not found: ${method}`);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Bridge call timed out: ${method}`)),
      BRIDGE_TIMEOUT_MS
    );
    fn(...args)
      .then(result => { clearTimeout(timer); resolve(result); })
      .catch(err =>   { clearTimeout(timer); reject(err); });
  });
}
```

Use it as: `const result = await callPy("detect_emotion", base64Image);`

The 30-second timeout is a guard against the Python side hanging (e.g. model loading failing silently). 30 seconds is generous — actual end-to-end should be < 5 s.

---

## Page-by-page detail

### `index.html` — auth gate

Single responsibility: check session state and redirect.

```javascript
// frontend/js/auth_gate.js
import { callPy } from "./bridge.js";

window.addEventListener("load", async () => {
  if (!await callPy("has_spotify_session")) {
    window.location.assign("pages/login.html");
    return;
  }
  const profile = await callPy("verify_premium");
  if (!profile.premium) {
    window.location.assign("pages/premium_required.html");
    return;
  }
  // Save profile to sessionStorage for sidebar / header use
  sessionStorage.setItem("spotify_profile", JSON.stringify(profile));
  window.location.assign("pages/home.html");
});
```

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
document.querySelector("#login-btn").addEventListener("click", async () => {
  document.querySelector("#login-btn").disabled = true;
  document.querySelector("#status").textContent =
    "Opening Spotify in your browser…";
  try {
    const result = await callPy("start_spotify_login");
    if (result.success) {
      window.location.assign("../index.html");  // re-runs auth gate
    } else {
      showError(result.error);
    }
  } catch (err) {
    showError(err.message);
  }
});
```

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

### `photo.html`

Two states:
1. **Preview** — live webcam feed with a centred oval guide. A face-detection ping every 500 ms updates the guide's colour: red (no face / multiple), green (one face). Shutter button enabled only when green.
2. **Captured** — frozen frame, "Use this" and "Retake" buttons.

```html
<video id="webcam-preview" autoplay muted playsinline></video>
<canvas id="capture-canvas" hidden></canvas>
<svg id="face-guide" viewBox="0 0 100 100">
  <ellipse cx="50" cy="50" rx="30" ry="40" class="guide-outline" />
</svg>
<button id="shutter" disabled>📷 Take Photo</button>
<p id="instructions">
  Centre your face. Remove glasses, masks, and obstructions.
</p>
```

```javascript
// frontend/js/camera.js
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 1280, height: 720, facingMode: "user" },
    audio: false,
  });
  const video = document.querySelector("#webcam-preview");
  video.srcObject = stream;
  return stream;
}

// Lightweight face-detection ping (uses the same Python bridge)
async function checkFacePresence() {
  const dataUrl = captureFrame(); // downscaled for speed
  const result = await callPy("quick_face_check", dataUrl.split(",")[1]);
  // result.face_count: 0 | 1 | 2+
  updateGuideColour(result.face_count);
  document.querySelector("#shutter").disabled = result.face_count !== 1;
}

setInterval(checkFacePresence, 500);  // 2 Hz
```

Python side needs a corresponding lightweight bridge method:

```python
def quick_face_check(self, b64: str) -> dict:
    img = decode_image(b64)
    img = maybe_downsample(img, max_dim=320)  # extra-aggressive downsample for speed
    faces = detect_faces(img)
    return {"face_count": len(faces)}
```

This adds latency overhead from the bridge call but the user gets useful real-time feedback. If the bridge call latency proves problematic (> 100 ms each), do face detection client-side via the lighter `face-api.js` or browser-native `FaceDetector` (Chromium has experimental support).

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
document.querySelectorAll(".mood-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const emotion = btn.dataset.emotion;
    sessionStorage.setItem("last_emotion", emotion);
    sessionStorage.setItem("emotion_source", "manual");
    window.location.assign("loading.html?next=result");
  });
});
```

### `loading.html`

Shown briefly during model inference. Shows a rotating set of statuses based on a `?stage=` query parameter or via polling. Simplest: do the bridge work directly on this page, then navigate to result.

```javascript
window.addEventListener("load", async () => {
  const emotionSource = sessionStorage.getItem("emotion_source");

  if (emotionSource === "manual") {
    // Skip inference; emotion is already chosen
    const emotion = sessionStorage.getItem("last_emotion");
    await generatePlaylistAndGoToResult(emotion);
    return;
  }

  // Camera path: image was saved to sessionStorage by photo.html
  const b64 = sessionStorage.getItem("captured_image_b64");
  updateStatus("Detecting face…");
  const result = await callPy("detect_emotion", b64);

  if (result.status === "error") {
    sessionStorage.setItem("error_code", result.error);
    window.location.assign("error.html");
    return;
  }
  if (result.status === "out_of_scope") {
    sessionStorage.setItem("error_code", "out_of_scope");
    sessionStorage.setItem("detected_emotion", result.detected);
    window.location.assign("error.html");
    return;
  }

  sessionStorage.setItem("last_emotion", result.emotion);
  sessionStorage.setItem("emotion_source", "camera");
  await generatePlaylistAndGoToResult(result.emotion);
});

async function generatePlaylistAndGoToResult(emotion) {
  updateStatus("Building your playlist…");
  const playlist = await callPy("generate_playlist", emotion, 25);
  sessionStorage.setItem("current_playlist", JSON.stringify(playlist));
  sessionStorage.setItem("playlist_emotion", emotion);
  window.location.assign("result.html");
}
```

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

```javascript
window.addEventListener("load", () => {
  const playlist = JSON.parse(sessionStorage.getItem("current_playlist"));
  const emotion = sessionStorage.getItem("playlist_emotion");
  renderHeader(emotion);
  renderTrackList(playlist);

  document.querySelector("#play-btn").addEventListener("click", () => {
    const trackIds = playlist.map(t => t.track_id);
    playPlaylist(trackIds);  // from playback.js
  });
  document.querySelector("#save-btn").addEventListener("click", async () => {
    const name = `${capitalise(emotion)} — ${formatNow()}`;
    await callPy("save_playlist", name, emotion, playlist.map(t => t.track_id));
    showToast("Playlist saved");
  });
  document.querySelector("#edit-btn").addEventListener("click", () => {
    enterEditMode();
  });
});
```

Edit mode allows the user to remove individual tracks before saving. Adds (searching for new tracks) is a stretch goal — defer if time-constrained.

### `error.html`

Shows a message keyed by `sessionStorage.error_code`:

```javascript
const ERROR_MESSAGES = {
  no_face:           "We couldn't see a face. Please centre your face in the frame and try again.",
  multiple_faces:    "We detected more than one face. Please make sure only one person is in the photo.",
  low_quality_blur:  "The image is too blurry. Please hold the camera steady.",
  low_quality_dark:  "The image is too dark. Move to a brighter spot.",
  low_quality_bright:"The image is too bright. Reduce glare or move away from direct light.",
  out_of_scope:      detected => `We detected ${detected}, which isn't supported for music recommendations. Try choosing your mood manually.`,
  decode_failed:     "Something went wrong reading the photo. Please try again.",
};

const code = sessionStorage.getItem("error_code");
const detected = sessionStorage.getItem("detected_emotion");
const msg = typeof ERROR_MESSAGES[code] === "function"
  ? ERROR_MESSAGES[code](detected)
  : (ERROR_MESSAGES[code] || "An unexpected error occurred.");

document.querySelector("#error-message").textContent = msg;
document.querySelector("#back-btn").addEventListener("click", () => {
  window.location.assign("home.html");
});
```

---

## Sidebar (shared across pages)

Lists saved playlists. Refreshed on every page load (cheap query).

```javascript
// frontend/js/sidebar.js
window.addEventListener("load", async () => {
  const playlists = await callPy("list_user_playlists");
  renderSidebar(playlists);
});
```

Sidebar items:
- Click → load that playlist into result.html
- Right-click (or kebab menu) → delete / rename

Use `sessionStorage` to pass the selected playlist between pages, or pass via URL hash: `result.html#playlist=42`.

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

- **Colour palette** (suggested, refine in design phase):
  - Background: dark (e.g. `#1a1a1a`) — matches music-app aesthetic.
  - Accent: Spotify green (`#1DB954`) used sparingly for primary CTAs.
  - Emotion-specific accent on result page: yellow for happy, blue for sad, red for angry, etc.
- **Typography:** system font stack. No web font load — Spotify Circular is licensed, alternatives like Inter are fine but add a network dependency.
- **Layout:** flexbox-based. CSS Grid for the home grid.
- **Sizing:** target 1280×800 minimum. Layout should be responsive down to 1024×600 (smaller laptops).

The planning doc's prototypes (Figures 17–22) are low-fidelity. The high-fidelity prototype is a CP2 deliverable (Phase 2, week 2).

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
