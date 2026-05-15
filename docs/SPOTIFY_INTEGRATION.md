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
| Enrich artist genres (data prep, one-off) | `GET /v1/artists?ids=...` | No — Client Credentials |
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

Used **once**, offline, by the maintainer, in `scripts/enrich_artist_genres.py`. Authenticates the *app*, not a user. Used only to call public endpoints like `/artists`.

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
   - **Redirect URI:** `http://127.0.0.1:8888/callback`
     - Spotify rejects `http://localhost` in newer dashboard versions but accepts `http://127.0.0.1`. Use the IP form.
     - The port (8888) is fixed; the local OAuth callback server binds to it.
   - APIs used: tick **Web API** and **Web Playback SDK**.
3. Copy the **Client ID** into `.env` (`SPOTIPY_CLIENT_ID`).
4. Copy the **Client Secret** into `.env` (`SPOTIPY_CLIENT_SECRET`). Used **only** by the enrichment script, not by the desktop app.

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
         │  3. SpotifyPKCE generates PKCE verifier+challenge,
         │     builds the authorize URL with redirect_uri,
         │     starts a tiny local HTTP server on 127.0.0.1:8888,
         │     opens the URL in the user's default browser
         ▼
┌──────────────────────────┐  4. User logs into Spotify,
│ Spotify accounts.spotify │      grants the scopes
│         .com             │
└────────┬─────────────────┘
         │
         │  5. Browser redirected to http://127.0.0.1:8888/callback?code=...
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
# src/spotify/auth.py
import webbrowser
from spotipy.oauth2 import SpotifyPKCE

REDIRECT_URI = "http://127.0.0.1:8888/callback"
CACHE_HANDLER = KeyringCacheHandler()  # see below

def get_pkce_manager() -> SpotifyPKCE:
    return SpotifyPKCE(
        client_id=os.environ["SPOTIPY_CLIENT_ID"],
        redirect_uri=REDIRECT_URI,
        scope=" ".join(SPOTIFY_SCOPES),
        cache_handler=CACHE_HANDLER,
        open_browser=False,    # we'll open it manually for clarity
    )

def start_login_flow() -> str:
    """Opens browser to Spotify, returns URL the user is now on. Blocks until callback received."""
    auth = get_pkce_manager()
    url = auth.get_authorize_url()
    webbrowser.open(url)
    # Spotipy's built-in local server handles the callback.
    # See SpotifyOAuth.get_access_token() with as_dict=True for details.
    token_info = auth.get_access_token(as_dict=True)
    return token_info  # already cached by CACHE_HANDLER
```

### Token cache: store in OS keychain

Don't write Spotify tokens to a plain file. Use `keyring`:

```python
# src/spotify/keyring_cache.py
import json
import keyring
from spotipy.cache_handler import CacheHandler

class KeyringCacheHandler(CacheHandler):
    SERVICE = "EmotionMusicRec"
    USERNAME = "spotify_token"

    def get_cached_token(self):
        raw = keyring.get_password(self.SERVICE, self.USERNAME)
        return json.loads(raw) if raw else None

    def save_token_to_cache(self, token_info):
        keyring.set_password(self.SERVICE, self.USERNAME,
                             json.dumps(token_info))
```

`keyring` uses:
- Windows: Credential Locker
- macOS: Keychain
- Linux: Secret Service (gnome-keyring / KWallet)

If `keyring` fails (e.g. headless Linux without Secret Service), fall back to a file in the user's home directory with mode `0o600`. Document the fallback path in the README.

### Refresh

`spotipy.SpotifyPKCE.get_access_token()` automatically refreshes when the access token is < 60 seconds from expiry. The bridge wrapper exposes this:

```python
def get_valid_access_token() -> str:
    auth = get_pkce_manager()
    token_info = auth.get_access_token(as_dict=True)  # refreshes if needed
    return token_info["access_token"]
```

This is called immediately before any operation that needs a fresh token — including immediately before yielding the token to JavaScript for the Web Playback SDK.

### Logout

```python
def logout():
    KEYRING.delete_password("EmotionMusicRec", "spotify_token")
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
    Raises if no valid token.
    """
    token = get_valid_access_token()
    sp = spotipy.Spotify(auth=token)
    me = sp.current_user()
    return {
        "premium": me.get("product") == "premium",
        "product": me.get("product"),
        "display_name": me.get("display_name"),
        "email": me.get("email"),
    }
```

If `premium` is false, the frontend displays a hard block: "This app requires Spotify Premium. Please upgrade your account and try again." Provide a link to Spotify's upgrade page. **Do not** let the user proceed to the home page — the playback will fail and the experience is worse than a clear gate.

The Premium check runs:
- Immediately after first OAuth completion.
- On every app start (in case the user downgraded their subscription).
- The result is cached for the session; not re-checked between recommendations.

---

## Web Playback SDK (frontend)

The SDK is JavaScript-only. It instantiates a Spotify player inside the webview that Spotify treats as a Spotify Connect device — like the user's phone or speakers.

### Loading the SDK

```html
<!-- frontend/index.html, in <head> -->
<script src="https://sdk.scdn.co/spotify-player.js"></script>
```

The SDK calls `window.onSpotifyWebPlaybackSDKReady` when it's loaded.

### Initialising the player

```javascript
// frontend/js/playback.js

window.onSpotifyWebPlaybackSDKReady = async () => {
  // Get a fresh access token from Python
  const token = await pywebview.api.get_spotify_access_token();

  const player = new Spotify.Player({
    name: "Emotion Music Recommender",
    getOAuthToken: cb => {
      // Called by the SDK whenever it needs a (possibly refreshed) token.
      pywebview.api.get_spotify_access_token().then(cb);
    },
    volume: 0.5,
  });

  // Error listeners (REQUIRED — silent failure is the default)
  player.addListener("initialization_error",  ({ message }) => onSdkError("init", message));
  player.addListener("authentication_error",  ({ message }) => onSdkError("auth", message));
  player.addListener("account_error",         ({ message }) => onSdkError("account", message));
  player.addListener("playback_error",        ({ message }) => onSdkError("playback", message));

  // State listeners
  player.addListener("ready", ({ device_id }) => {
    window.spotifyDeviceId = device_id;
    transferPlaybackHere(device_id);
  });
  player.addListener("not_ready",   ({ device_id }) => { /* device went offline */ });
  player.addListener("player_state_changed", state => updatePlayerUI(state));

  await player.connect();
  window.spotifyPlayer = player;
};

async function transferPlaybackHere(deviceId) {
  const token = await pywebview.api.get_spotify_access_token();
  await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });
}
```

### Playing a track

```javascript
async function playTrack(trackId) {
  const token = await pywebview.api.get_spotify_access_token();
  await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${window.spotifyDeviceId}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: [`spotify:track:${trackId}`] }),
    }
  );
}

async function playPlaylist(trackIds) {
  // Queue an array of tracks (treated as an ad-hoc playlist by Spotify)
  const token = await pywebview.api.get_spotify_access_token();
  await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${window.spotifyDeviceId}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uris: trackIds.map(id => `spotify:track:${id}`) }),
    }
  );
}
```

The SDK then handles streaming. Audio plays out of the system's audio output device.

### SDK + PyWebView gotchas

- **Autoplay restrictions.** Browsers (including PyWebView's underlying Chromium) block audio playback that wasn't triggered by user interaction. The first `play` call must be in response to a button click event. Subsequent play calls within the same session work without further interaction.
- **`player.activateElement()`** — call this on the very first user click if the SDK reports that the player is "not yet active". It's a Spotify-recommended workaround for autoplay gating.
- **WebView audio output.** PyWebView passes audio through to the OS audio stack on all platforms; no extra config required.
- **Cookies / storage.** PyWebView's webview persists cookies between runs by default (per-platform behaviour). The SDK uses localStorage for some state — confirm it works on the first install before assuming.

### Error handling

The four error listeners (`initialization_error`, `authentication_error`, `account_error`, `playback_error`) each have specific causes:

| Listener | Common cause | Handler |
|---|---|---|
| `initialization_error` | SDK couldn't load (CDN blocked, browser too old) | Show diagnostic; suggest disabling ad blockers |
| `authentication_error` | Token expired, invalid, or insufficient scope | Force re-login |
| `account_error` | Free account, restricted region | Display Premium-required message |
| `playback_error` | Network drop, track unavailable in region | Toast + skip to next track |

Pipe all four into a single `onSdkError(kind, message)` that logs and surfaces an appropriate UI state.

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
class SpotifyAPI:
    def has_spotify_session(self) -> bool: ...
    def start_spotify_login(self) -> dict: ...     # returns {"success": bool, "error": str|None}
    def logout(self) -> None: ...
    def get_spotify_access_token(self) -> str: ... # fresh token, refreshed if needed
    def verify_premium(self) -> dict: ...          # {"premium": bool, "product": str, ...}
    def get_user_profile(self) -> dict: ...        # cached version of verify_premium()
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
| OAuth flow opens browser, returns to app, "login failed" | Redirect URI in app code doesn't match dashboard registration | Make sure both are `http://127.0.0.1:8888/callback`, byte-exact |
| Browser shows "INVALID_CLIENT" | Wrong `client_id` in `.env` | Re-copy from dashboard |
| SDK loads but no audio plays | Free account | The Premium check should have caught this; surface clearly |
| SDK loads, "ready" fires, then "not_ready" immediately | OAuth scope missing `streaming` | Add scope, re-login |
| `transferPlaybackHere` returns 403 | Token doesn't have `user-modify-playback-state` | Add scope, re-login |
| First track plays, second doesn't | Token expired between songs | The `getOAuthToken` callback should refresh; check it's wired up |
| OAuth dialog says "your account is not allowed" | App is in Development Mode and user is not whitelisted | Invite in dashboard, or accept this limitation |

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
