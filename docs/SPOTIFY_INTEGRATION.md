# docs/SPOTIFY_INTEGRATION.md

How the app talks to Spotify: OAuth login, token management, Premium verification, and the Web Playback SDK.

This doc has the most moving parts in the project. Read it carefully before touching the auth flow.

---

## What we use Spotify for (and what we don't)

| Use | How | OAuth needed? |
|---|---|---|
| Stream audio tracks (playback) | Web Playback SDK (JavaScript, in the webview) | Yes — user OAuth |
| Verify Premium account | `GET /v1/me` → check `product == "premium"` | Yes — user OAuth |
| Get user's profile (display name, avatar) | `GET /v1/me` | Yes — user OAuth |
| Enrich artist genres (data prep, one-off) | **Last.fm `artist.getTopTags`** (Spotify's `/artists` genres were removed for this app — see `docs/MUSIC_DATA.md` Stage 3) | No (Last.fm API key) |
| **DO NOT USE: audio features** | `/v1/audio-features` (deprecated Nov 2024) | — |
| **DO NOT USE: recommendations** | `/v1/recommendations` (deprecated Nov 2024) | — |
| **DO NOT USE: related artists** | `/v1/artists/{id}/related-artists` (deprecated Nov 2024) | — |

If a task description mentions any of the "DO NOT USE" endpoints, stop and ask the owner. They were deprecated for new third-party apps on 27 November 2024 and will return HTTP 403 for our app.

---

## Two auth flows, two purposes

We use **two different OAuth flows** for two different purposes. Don't confuse them.

### Flow 1: Authorization Code with PKCE (for the desktop app)

Used at runtime, every user, in the main application. Authenticates the end user and grants the app permission to play music on their behalf.

- No `client_secret` is shipped with the app.
- Uses Spotipy's `SpotifyPKCE`.
- Tokens stored locally in the OS keychain.

### Flow 2: Client Credentials (for the enrichment script)

Used **once**, offline, by the maintainer. Authenticates the *app*, not a user.

> ⚠️ **Update (June 2026):** this flow is **no longer used for genre enrichment** — Spotify removed artist `genres` for this app (batch `/artists` returns 403; the artist object omits `genres`). `scripts/enrich_artist_genres.py` now uses the **Last.fm** API instead (see `docs/MUSIC_DATA.md` Stage 3). Client Credentials remains documented here only in case a future task needs another public Spotify endpoint.

- Requires `client_secret`, but the secret stays in the maintainer's `.env` and is **never** shipped.
- Uses Spotipy's `SpotifyClientCredentials`.
- Tokens are short-lived and discarded after the script run.

---

## Spotify Developer Dashboard setup (one-time)

The maintainer (the student) creates a single Spotify app at https://developer.spotify.com/dashboard:

1. Log in with a Spotify account.
2. "Create app":
   - Name: `EmotionMusicRec`
   - Description: capstone project, brief
   - **Redirect URI:** `http://127.0.0.1:8888/echosoul-callback` — register this exact value.
     - Spotify requires the **`127.0.0.1` IP literal with a port**. `http://localhost` and port-less forms (`http://127.0.0.1/...`) are both rejected with *"This redirect URI is not secure"* (verified in the dashboard).
     - The **port** (`8888`) and **path** (`/echosoul-callback`) must match `SPOTIFY_REDIRECT_URI` in `.env` byte-for-byte. The path is freely customisable; the host and scheme are not.
   - APIs used: tick **Web API** and **Web Playback SDK**.
3. Copy the **Client ID** into `.env` (`SPOTIFY_CLIENT_ID`).
4. Copy the **Client Secret** into `.env` (`SPOTIFY_CLIENT_SECRET`). Used **only** by the enrichment script, not by the desktop app.

**Important:** Spotify apps default to *Development Mode*. In Development Mode, only the maintainer's Spotify account (and up to 25 additional users explicitly invited via the dashboard) can authenticate. This is fine for a capstone — invite the supervisor and any test users. To support arbitrary users would require a *Quota Extension Request*, which Spotify reviews manually and which is out of scope.

---

## Required OAuth scopes

Requested at login time. The user sees these on the Spotify consent screen.

| Scope | Why |
|---|---|
| `streaming` | Web Playback SDK requires it to stream audio |
| `user-read-email` | Read `email` field of `/me` (optional but standard) |
| `user-read-private` | Read `product` field of `/me` — the Premium check |
| `user-modify-playback-state` | Issue play/pause/seek commands to the SDK player |
| `user-read-playback-state` | Read current playback state for the UI |
| `playlist-read-private` | (Optional, future) read user's existing Spotify playlists |

Request **only what we use.** Don't add `user-library-modify` or other scopes pre-emptively; Spotify's consent screen lists them all and excess scopes look intrusive to the user.

```python
SPOTIFY_SCOPES = [
    "streaming",
    "user-read-email",
    "user-read-private",
    "user-modify-playback-state",
    "user-read-playback-state",
]
```

---

## OAuth flow (desktop, PKCE) — step by step

```
┌──────────────────┐  1. User clicks "Login with Spotify"
│   Frontend (JS)  │─────────────────────────────────────┐
└──────────────────┘                                       │
                                                           ▼
┌──────────────────┐  2. api.start_spotify_login()       ┌──────────┐
│  Python backend  │←─────────────────────────────────── │   API    │
└────────┬─────────┘                                      │  layer   │
         │                                                └──────────┘
         │  3. We bind our own tiny HTTP server on 127.0.0.1:8888,
         │     SpotifyPKCE builds the authorize URL (verifier+challenge+state),
         │     open the URL in the user's default browser
         ▼
┌──────────────────────────┐  4. User logs into Spotify,
│ Spotify accounts.spotify │      grants the scopes
│         .com             │
└────────┬─────────────────┘
         │
         │  5. Browser redirected to http://127.0.0.1:8888/echosoul-callback?code=...&state=...
         ▼
┌──────────────────┐
│ Local HTTP server │  6. Captures `code`, exchanges it for tokens via PKCE
│  inside Python    │     (no client_secret needed thanks to PKCE)
└────────┬─────────┘
         │
         │  7. Tokens (access + refresh) saved to OS keychain via `keyring`
         │     Local HTTP server shuts down
         │     Browser tab shows "You can close this tab and return to the app"
         ▼
┌──────────────────┐
│  Python backend  │  8. Bridge call returns success to frontend
└────────┬─────────┘
         │
         │  9. Frontend verifies Premium (api.verify_premium())
         ▼
┌──────────────────┐
│   Frontend (JS)  │  10. Loads Web Playback SDK with access token,
└──────────────────┘      navigates to home page
```

### Implementation outline

```python
# src/spotify/auth.py  (as-built — the module carries the full docstrings)
import os, secrets, webbrowser
from spotipy.oauth2 import SpotifyPKCE

REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/echosoul-callback")
CACHE_HANDLER = KeyringCacheHandler()  # see below

def _pkce_manager() -> SpotifyPKCE:
    return SpotifyPKCE(
        client_id=os.environ["SPOTIFY_CLIENT_ID"],   # .env var name; PKCE needs no secret
        redirect_uri=REDIRECT_URI,
        scope=" ".join(SPOTIFY_SCOPES),
        cache_handler=CACHE_HANDLER,
        open_browser=False,      # we drive the browser + callback ourselves
    )

def start_login_flow() -> dict:
    """Blocks until the OAuth callback returns. Result is JSON-serialisable."""
    try:
        with _CallbackServer(CALLBACK_HOST, CALLBACK_PORT, CALLBACK_PATH) as server:
            auth = _pkce_manager()
            state = secrets.token_urlsafe(16)
            webbrowser.open(auth.get_authorize_url(state=state))
            code, error = server.wait_for_code(state, LOGIN_TIMEOUT_SECONDS)
            if error:
                return {"success": False, "error": error}
            auth.get_access_token(code=code, check_cache=False)   # exchange + cache
            return {"success": True, "error": None}
    except OSError as exc:       # fixed callback port already in use
        return {"success": False, "error": f"port {CALLBACK_PORT} busy: {exc}"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
```

> **Why our own callback server (not Spotipy's built-in):** Spotipy's local server only starts *when the redirect URI has a port*, but its convenience path gives us no control over the callback page or CSRF `state` handling. We register a **fixed-port** loopback URI with a **custom path** (`/echosoul-callback`), bind our own `_CallbackServer`, serve a branded "you can close this tab" page, and validate `state`. Spotify's dashboard **requires the explicit `127.0.0.1` IP and a port** — `localhost` and port-less forms are rejected as "not secure" (verified in the dashboard), so a dynamic/port-less redirect is not possible.

> **API note (spotipy 2.26, verified empirically):** `SpotifyPKCE.get_access_token(code=None, check_cache=True)` has **no `as_dict` argument** (removed) and returns the access-token *string*; the full token dict is written to the cache handler as a side effect. Passing `check_cache=False` forces exchange of the fresh `code` even if a stale token is cached. Env var is `SPOTIFY_CLIENT_ID` (per `.env.example`), not `SPOTIPY_CLIENT_ID`.

### Token cache: store in OS keychain

Don't write Spotify tokens to a plain file. Use `keyring`:

```python
# src/spotify/keyring_cache.py  (abridged — see the module for the file fallback)
import json
import keyring
from spotipy.cache_handler import CacheHandler

class KeyringCacheHandler(CacheHandler):
    SERVICE = "EchoSoul"          # shows up in Windows Credential Manager
    USERNAME = "spotify_token"

    def get_cached_token(self):
        raw = keyring.get_password(self.SERVICE, self.USERNAME)
        return json.loads(raw) if raw else None

    def save_token_to_cache(self, token_info):
        keyring.set_password(self.SERVICE, self.USERNAME,
                             json.dumps(token_info))

    def delete_cached_token(self):   # used by auth.logout()
        ...
```

The as-built handler wraps every keyring call in a `try/except KeyringError`
and, on failure (no Secret Service backend), falls back to a `0o600` JSON file
under `~/.echosoul/`. On the owner's Windows machine the backend is
`WinVaultKeyring` (Credential Locker), so the fallback never triggers.

`keyring` uses:
- Windows: Credential Locker
- macOS: Keychain
- Linux: Secret Service (gnome-keyring / KWallet)

If `keyring` fails (e.g. headless Linux without Secret Service), fall back to a file in the user's home directory with mode `0o600`. Document the fallback path in the README.

### Refresh

`spotipy.SpotifyPKCE.get_access_token()` automatically refreshes when the access token is < 60 seconds from expiry. The bridge wrapper exposes this:

```python
def get_valid_access_token() -> str:
    auth = get_pkce_manager(open_browser=False)
    try:
        token_info = auth.get_cached_token()  # reads cache, refreshes if near expiry
    except SpotifyOauthError as exc:
        if exc.error == "invalid_grant":          # refresh token revoked/expired
            raise SpotifySessionExpiredError() from exc
        raise                                     # config bug (bad client id) — surface raw
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
        raise SpotifyNetworkError() from exc
    if not token_info:
        raise RuntimeError("No Spotify session; call start_login_flow() first.")
    return token_info["access_token"]
```

Refresh failures are classified into typed exceptions (`src/spotify/auth.py`) so the frontend can show a specific notice instead of a generic one:

| Exception | Underlying cause | User-facing message says |
|---|---|---|
| `SpotifySessionExpiredError` | Token endpoint answered `invalid_grant` — refresh token revoked (user removed the app at spotify.com/account/apps) or expired | Session expired/revoked, log in again |
| `SpotifyNetworkError` | `requests` `ConnectionError`/`Timeout` — offline, DNS failure, Spotify down. Also raised by `verify_premium()` when `/me` is unreachable | Check your internet connection, try again |
| `SpotifyUserNotRegisteredError` (in `account.py`) | `/me` → 403: account not in the Development-Mode allowlist | Account isn't authorized, ask the app owner |

pywebview turns a raised Python exception into a rejected JS promise with `error.name = type(e).__name__`, which is how `auth_gate.js` picks the message (see `docs/FRONTEND.md` > auth gate). Anything not in that table falls back to the generic "couldn't restore your session" notice.

`SpotifyPKCE.get_cached_token()` reads the stored token via the cache handler
and refreshes it (using the refresh token) when it is within 60 s of expiry —
without ever opening a browser. It returns `None` when nothing is cached.

This is called immediately before any operation that needs a fresh token — including immediately before yielding the token to JavaScript for the Web Playback SDK.

### Logout

```python
def logout():
    CACHE_HANDLER.delete_cached_token()   # removes from keychain (service "EchoSoul")
    # Frontend then reloads the login page
```

No way to revoke the token server-side from a desktop client; the user must revoke at https://www.spotify.com/account/apps if they want to be thorough. Document this in the report's privacy section.

---

## Premium verification

The Web Playback SDK silently fails for Free users — the player initialises but never produces audio. To avoid confusion, check the user's product type immediately after login:

```python
# src/spotify/account.py
import spotipy

def verify_premium() -> dict:
    """
    Returns {'premium': bool, 'product': str, 'display_name': str, 'email': str|None}.
    Raises RuntimeError if no valid token; SpotifyUserNotRegisteredError if the
    account is not in the app's Development-Mode allowlist (/me returned 403).
    """
    token = get_valid_access_token()
    sp = spotipy.Spotify(auth=token)
    try:
        me = sp.current_user()
    except spotipy.SpotifyException as exc:
        if exc.http_status == 403:
            raise SpotifyUserNotRegisteredError() from exc
        raise
    return {
        "premium": me.get("product") == "premium",
        "product": me.get("product"),
        "display_name": me.get("display_name"),
        "email": me.get("email"),
    }
```

If `premium` is false, the frontend displays a hard block: "This app requires Spotify Premium. Please upgrade your account and try again." Provide a link to Spotify's upgrade page. **Do not** let the user proceed to the home page — the playback will fail and the experience is worse than a clear gate.

> ⚠️ **Development-Mode allowlist (verified empirically, July 2026):** while the Spotify app is in Development Mode, only accounts added under **User Management** in the developer dashboard (max 25) may call the Web API. A non-allowlisted account **completes OAuth normally and receives a token** — the rejection only appears afterwards, as `/me` → 403 "User not registered in the Developer Dashboard". `verify_premium()` translates that 403 into `SpotifyUserNotRegisteredError`; pywebview rejects the JS promise with `error.name` set to the Python class name, which is how the auth gate distinguishes it from transient failures and shows the actionable "account isn't authorized" notice instead of the generic session-restore one. **Every user-study tester's Spotify account must be allowlisted before their session.**

The Premium check runs:
- Immediately after first OAuth completion.
- On every app start (in case the user downgraded their subscription).
- The result is cached for the session; not re-checked between recommendations.

---

## Web Playback SDK (frontend)

The SDK is JavaScript-only. It instantiates a Spotify player inside the webview that Spotify treats as a Spotify Connect device (named **EchoSoul**) — like the user's phone or speakers.

As-built, everything below lives in `frontend/js/playback.js`, an ES module loaded on every chrome page that shows the bottom player (home / mood / loading / result / error). It no-ops entirely for Free accounts (chrome.js doesn't even render the player) and on pages without the footer. It drives the bottom player and exports one function for other modules:

```javascript
playTracks(trackIds, startIndex, context)  // context = "playlist" (default) | "single"
// used by result.js (play-all + per-track), home.js (latest-playlist showcase rows),
// and search.js / create_playlist.js (single-track previews, context "single")
```

`context` is persisted (`sessionStorage.playback_context = {type, trackIds}`) so the footer's prev/next can tell a **playlist** (walk the tracks, loop at the end) from a **standalone track** (prev restarts, next ends it) even after a page navigation — see the transport notes below.

### Loading the SDK

`playback.js` injects `<script src="https://sdk.scdn.co/spotify-player.js">` **dynamically** (not a static tag in each page's `<head>`) so it can attach an `onerror` fallback — offline, the player shows *"Playback unavailable — check your internet connection"* instead of dying silently — and so the SDK only loads where the player exists. The SDK calls `window.onSpotifyWebPlaybackSDKReady` when loaded; the callback must be assigned **before** the script tag is appended.

### Page navigation & session resume

The app navigates between real HTML files (docs/FRONTEND.md "Routing"), so the SDK — and its Connect device, whose `device_id` changes every time — is torn down and recreated on every page change. Continuity is server-side: Spotify keeps the playback session (queue + position) alive for a while after a device disconnects.

- On `pagehide`, the outgoing page stashes `sessionStorage.playback_resume = "playing" | "paused"` **and** `sessionStorage.playback_position` (the current position in ms, extrapolated from the last SDK state so it's accurate between the 1 s polls), then calls `player.disconnect()`.
- On `ready`, the incoming page transfers the session to its new device — `PUT /me/player {device_ids: [id], play: stash === "playing"}` — then, if it was playing, **seeks back to the stashed position**. Spotify resumes a transfer from its last server-synced position, which lags a few seconds behind and audibly rewinds the track (seen live: the track could restart near its beginning); the seek undoes that. Because seeking a just-transferred device no-ops until its audio has loaded, the seek waits (polling `getCurrentState`) for a live, playing state first. A failed transfer (typically 404: session expired or taken over by another device) drops the stash.
- **No unconditional transfer on ready.** The CP1-era sketch transferred playback to the webview on every page load; as-built that would silently hijack the user's phone/desktop Spotify session every time the app shows a page. Transfer happens only when *resuming* (stash present) or when the user explicitly plays (`playTracks` carries `device_id`, which switches the active device).
- Only a page whose SDK actually reached `ready` may clear the stash — the short-lived loading page often navigates away before the SDK finishes connecting and must leave the stash for the result page to consume.

Resuming after a navigation happens with **no user gesture in the new document**, which Chromium's autoplay policy would normally block. `src/main.py` therefore adds `--autoplay-policy=no-user-gesture-required` via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`. ⚠️ That env var **overrides** (does not append to) the browser arguments pywebview sets programmatically — verified live 2026-07-13: with the env var set, pywebview's own flags vanished, including `--allow-file-access-from-files`, without which ES module scripts on `file://` pages are CORS-blocked and **no page JS runs at all**. `_set_webview2_browser_args()` therefore restates pywebview 5.x's flags alongside ours. Belt and braces: the SDK's `autoplay_failed` event is handled anyway — if the flag ever stops working, the player just stays paused with a *"Press play to resume your music"* toast.

### Initialising the player (as-built outline)

```javascript
// frontend/js/playback.js (abridged — see the module)
window.onSpotifyWebPlaybackSDKReady = () => {
  player = new Spotify.Player({
    name: "EchoSoul",
    getOAuthToken: (cb) => {
      // Called by the SDK whenever it needs a (possibly refreshed) token.
      callPy("get_spotify_access_token").then(cb).catch(/* expired session -> auth handler */);
    },
    volume: 0.7,
  });

  // Error listeners (REQUIRED — silent failure is the default), see table below
  player.addListener("initialization_error", ({ message }) => onSdkError("init", message));
  player.addListener("authentication_error", ({ message }) => onSdkError("auth", message));
  player.addListener("account_error",        ({ message }) => onSdkError("account", message));
  player.addListener("playback_error",       ({ message }) => onSdkError("playback", message));
  player.addListener("autoplay_failed",      () => showToast("Press play to resume your music."));

  player.addListener("ready", ({ device_id }) => { /* resolve deviceReady; consume resume stash */ });
  player.addListener("not_ready", () => renderState(null));
  player.addListener("player_state_changed", (state) => renderState(state));

  player.connect();
};
```

### Playing tracks

`playTracks(trackIds, startIndex, context = "playlist")`:

1. Records the playback context (`sessionStorage.playback_context`) so prev/next know whether this is a playlist or a standalone track.
2. Waits for the device (`ready`) with a 12 s timeout — a click right after page load must not race the SDK connect.
3. Calls `player.activateElement()` (we're inside a user-gesture handler — Spotify's recommended autoplay unlock).
4. `PUT /me/player/play?device_id=<id>` with `{uris: ["spotify:track:...", ...], offset: {position: startIndex}}` — the whole list becomes the queue, started at the clicked track, so prev/next on the player walk it.
5. Retries once (700 ms) on 404: a just-connected device can take a moment to register with Spotify's backend.

The SDK then handles streaming; audio plays out of the system's audio output device.

### The bottom player (chrome pages)

`chrome.js` renders the player idle ("Nothing playing", transport disabled); `playback.js` drives it from `player_state_changed`: track name / artists / smallest album image, play↔pause icon, shuffle highlight (icon tint **plus** a small accent dot — the tint alone was too easy to miss — with the button titled *"Shuffle playlist"*), and the waveform-bar progress display, which doubles as the **seek bar**. The SDK only pushes state on *changes*, so while music plays a 1 s poll of `player.getCurrentState()` keeps the clock honest (extrapolating the position locally was tried first and ran a dead session's clock to the end of the track — seen live).

The waveform strip is wider than its bars, so a click maps X→fraction using the **bars' actual left/right extent** (first bar's left edge to the last bar's right edge), not the strip's bounding box — otherwise the seek landed a bit to the left of the cursor and the user had to aim right of where they wanted (seen live). The bars are laid out `justify-between` so they span the full strip.

**Transport goes through the Web API, not the SDK's local methods** (resume `PUT /me/player/play?device_id=`, skip `POST /me/player/next|previous`, seek `PUT /me/player/seek`, shuffle `PUT /me/player/shuffle`): after a *paused* cross-page transfer the device holds the session's metadata but no loaded media, and the SDK's `togglePlay()`/`nextTrack()`/`seek()` silently no-op (verified live). The API commands make the device load the media first. Pausing stays local (`player.pause()`) — media is always loaded while actually playing — and the play button flips the UI state optimistically so a pause immediately followed by a navigation stashes the right resume state. Volume (hover-revealed slider + mute toggle) uses `player.setVolume` and persists across pages via `sessionStorage.playback_volume` — each page creates a fresh player that would otherwise reset to the default.

**Prev/next depend on the playback context** (`sessionStorage.playback_context`, set by `playTracks`):

- **Within a playlist** — *Previous*: past the first 2 s of the current song it restarts that song; within the first 2 s (e.g. straight after a restart) it steps to the previous track when one exists (`POST /me/player/previous`), so a first press restarts and a second within 0:02 goes back. *Next*: advances (`POST /me/player/next`); on the **last** song it starts a fresh round of the whole playlist (`playTracks(trackIds, 0)`) rather than Spotify's default of wrapping to the first track and stopping.
- **Standalone track** (context `"single"`, e.g. a header-search result) — *Previous* always restarts the track; *Next* ends it (local `player.pause()` + seek to 0), since nothing follows it.

The current position for the "past 2 s?" test is `currentPositionMs()` — `lastState.position` extrapolated by the elapsed wall-clock since that state, so it's right even between the 1 s polls.

### Error handling (as-built)

All listeners funnel into `onSdkError(kind, message)`:

| Listener | Common cause | Handler in playback.js |
|---|---|---|
| `initialization_error` | SDK couldn't start (no DRM/CDM, browser too old) | Player shows "Playback unavailable" + reason |
| `authentication_error` | Token expired, invalid, or insufficient scope | Redirect to the auth gate (`index.html`) — **once per session** (sessionStorage guard), so a persistent failure can't bounce the user between pages forever |
| `account_error` | Free account, restricted region | "Playback unavailable (Premium required)" — shouldn't happen behind the gate |
| `playback_error` | Network drop, track unavailable in region | Toast "Spotify couldn't play this track." — deliberately **no auto-skip**: a systematic failure would cascade toasts through all 25 tracks |
| `autoplay_failed` | Autoplay gate blocked an un-gestured resume | Toast "Press play to resume your music." |

### SDK + PyWebView gotchas

- **Autoplay restrictions.** See *Page navigation & session resume* above — main.py lifts the gate for cross-page resume; explicit plays run inside click handlers anyway and also call `player.activateElement()`.
- **DRM (Widevine).** The SDK streams EME/Widevine-protected audio. WebView2 supports Widevine (unlike PlayReady) and downloads the CDM component on demand — the very first playback on a fresh machine can fail until the CDM finishes installing. Verify during the F9 manual pass; a retry after a few seconds is the fix.
- **WebView audio output.** PyWebView passes audio through to the OS audio stack on all platforms; no extra config required.
- **Cookies / storage.** PyWebView's webview persists cookies between runs with `private_mode=False` (set in `src/main.py`). The SDK uses localStorage for some state — confirm it works on the first install before assuming.

---

## Rate limiting

### Web API

The desktop app's Web API usage is light:
- `GET /me` — once per app start.
- `PUT /me/player`, `PUT /me/player/play`, etc. — a few calls per session.

Rate limits won't be reached in normal use. The enrichment script (different story) is documented in `docs/MUSIC_DATA.md`.

### Implementing 429 handling for Web API calls

Even for low-volume use, code defensively:

```python
def spotify_request_with_backoff(method, url, headers, body=None, max_retries=3):
    for attempt in range(max_retries):
        resp = requests.request(method, url, headers=headers, json=body)
        if resp.status_code == 429:
            wait = int(resp.headers.get("Retry-After", 1)) + 1
            time.sleep(wait)
            continue
        resp.raise_for_status()
        return resp
    raise RuntimeError(f"Spotify API exhausted retries: {url}")
```

The frontend's `fetch` calls are simpler — let them surface errors to the user via toast. No retry loop needed there.

---

## Bridge methods (Python ↔ JS)

The complete list of Spotify-related bridge methods exposed via PyWebView:

```python
class BridgeApi:  # src/api/bridge.py (Spotify-related subset)
    def has_spotify_session(self) -> bool: ...
    def start_spotify_login(self) -> dict: ...     # returns {"success": bool, "error": str|None}
    def logout(self) -> None: ...
    def get_spotify_access_token(self) -> str: ... # fresh token, refreshed if needed
    def verify_premium(self) -> dict: ...          # {"premium": bool, "product": str, ...}
    def get_user_profile(self) -> dict: ...        # cached version of verify_premium()
    def open_external_url(self, url) -> bool: ...  # allowlisted (spotify.com only) system-browser
                                                   # opener; used by premium_required.html
```

All return JSON-serialisable types or raise — the API layer never returns Python objects that PyWebView can't serialise.

---

## Security considerations

### What's stored where

| Secret | Where it lives | Why |
|---|---|---|
| Spotify `client_id` | `.env`, plain text | Public by design — `client_id` is not a secret in PKCE flow |
| Spotify `client_secret` | `.env`, plain text, **maintainer machine only** | Used only by enrichment script; **never** shipped to end users |
| User access token | OS keychain via `keyring` | Refreshable, short-lived (1 hour) |
| User refresh token | OS keychain via `keyring` | Long-lived; revocable from Spotify account settings |
| MySQL password | `.env`, plain text | Localhost-only DB; threat model is laptop physical compromise, not network |

### Threat model (capstone scope)

- ✅ Protect tokens from other apps on the same machine → keyring.
- ✅ Don't ship `client_secret` → PKCE flow.
- ✅ Don't log tokens → enforce in logging config.
- ❌ Defend against a malicious user with physical access → out of scope.
- ❌ Defend against a compromised keychain → out of scope.

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| OAuth flow opens browser, returns to app, "login failed" | Redirect URI in `.env` doesn't match dashboard registration | Make sure both are `http://127.0.0.1:8888/echosoul-callback`, byte-exact |
| Dashboard: "This redirect URI is not secure" | Used `localhost` or omitted the port | Use the `127.0.0.1` IP literal **with** a port, e.g. `http://127.0.0.1:8888/echosoul-callback` |
| Browser shows "INVALID_CLIENT" | Wrong `client_id` in `.env` | Re-copy from dashboard |
| SDK loads but no audio plays | Free account | The Premium check should have caught this; surface clearly |
| SDK loads, "ready" fires, then "not_ready" immediately | OAuth scope missing `streaming` | Add scope, re-login |
| `transferPlaybackHere` returns 403 | Token doesn't have `user-modify-playback-state` | Add scope, re-login |
| First track plays, second doesn't | Token expired between songs | The `getOAuthToken` callback should refresh; check it's wired up |
| OAuth completes ("connected" page shows) but the gate bounces to login with "account isn't authorized" | App is in Development Mode and the account is not allowlisted — `/me` returns 403 after a successful token exchange | Add the account under **User Management** in the dashboard, log in again |

---

## What if Spotify itself changes

Spotify deprecated audio-features on Nov 27 2024 with ~30 days' notice. Assume more changes may come. If during CP2 a new endpoint we depend on is deprecated:

1. **Check the official developer blog:** https://developer.spotify.com/blog
2. **Migration paths** typically: Spotify announces a replacement endpoint, or recommends ingesting their open-data dumps.
3. **For playback specifically:** the Web Playback SDK has been stable for years. If it's deprecated, the project is in serious trouble — there is no second free streaming SDK we can swap to.

Document any post-CP1 Spotify changes in `docs/ARCHITECTURE.md` "Open questions" or a new "Changelog" section.

---

## Related docs

- `docs/MUSIC_DATA.md` — uses Client Credentials flow for the enrichment script.
- `docs/FRONTEND.md` — embeds the Web Playback SDK; calls the bridge methods listed here.
- `docs/ARCHITECTURE.md` — high-level view of how Spotify integrates.
