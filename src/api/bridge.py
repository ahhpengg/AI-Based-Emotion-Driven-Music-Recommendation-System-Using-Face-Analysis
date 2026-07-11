"""PyWebView bridge: the JS-callable API surface of the Python backend.

One flat class (:class:`BridgeApi`) is bound to the window as ``js_api``;
PyWebView exposes its public methods to JavaScript as ``pywebview.api.<method>``
promises (frontend wrapper: ``frontend/js/bridge.js``). This layer is
deliberately thin (docs/ARCHITECTURE.md): each method validates input, calls
one or two domain functions, and returns a JSON-serialisable result. Business
logic lives in the domain modules.

Expected failures (no face, out-of-scope emotion, ...) come back as status
dicts the frontend routes on; unexpected failures raise, which PyWebView
surfaces to JavaScript as a rejected promise the pages report via the error
page / toast.
"""

from __future__ import annotations

import logging
import threading
import webbrowser

import cv2
import numpy as np

from src.fer import image_pipeline, inference
from src.music import playlists, recommender
from src.spotify import account, auth

logger = logging.getLogger(__name__)

# The FER model keeps the RAF-DB label vocabulary ("surprise"); the frontend,
# the emotion_music_mapping seed, and the recommender all use "surprised". The
# bridge is the adapter between the two vocabularies — this is the only label
# that differs. `all_probs` keys are left in model vocabulary (debug data only).
_EMOTION_ALIASES = {"surprise": "surprised"}

# The photo page pings quick_face_check() at 2 Hz for the live guide colour; a
# small frame keeps each ping cheap and the count is just as reliable.
_QUICK_CHECK_MAX_DIM = 320

# MediaPipe's IMAGE-mode FaceLandmarker is not thread-safe, and PyWebView runs
# every bridge call on its own thread — so a face-count ping must never overlap
# a running detect_emotion().
_fer_lock = threading.Lock()

# URLs the frontend may open in the system browser. Kept deliberately tight so
# the bridge never becomes a generic "open anything" primitive for page content.
#   - www.spotify.com  -> the Premium upgrade page (premium_required.html).
#   - open.spotify.com -> per-track deep links for Free accounts, which cannot
#     use the in-app Web Playback SDK; result.js opens the song in Spotify
#     (external browser / desktop app) instead of playing it in the webview.
_ALLOWED_EXTERNAL_URL_PREFIXES = (
    "https://www.spotify.com/",
    "https://open.spotify.com/",
)

# The window's minimum size (also passed to create_window in src/main.py).
# Enforced here too because the custom resize drag bypasses the native limit.
MIN_WINDOW_WIDTH = 800
MIN_WINDOW_HEIGHT = 600

# Valid dragged edges/corners for a custom resize.
_RESIZE_EDGES = frozenset({"n", "s", "e", "w", "ne", "nw", "se", "sw"})


def _set_window_rect(hwnd: int, x: int, y: int, width: int, height: int) -> None:
    """One atomic move+resize via Win32 SetWindowPos (SWP_NOZORDER | SWP_NOACTIVATE).

    pywebview's own fix-point resize re-reads the form's cached bounds on every
    call; under a fast drag those reads race the UI thread's bounds updates and
    the positional error compounds until the window walks off-screen. Absolute
    coordinates computed from a drag-start anchor have no feedback loop.
    """
    import ctypes

    ctypes.windll.user32.SetWindowPos(hwnd, None, int(x), int(y), int(width), int(height), 0x0014)


def _downscale(rgb: np.ndarray, max_dim: int) -> np.ndarray:
    """Shrink an RGB frame so its longest side is at most ``max_dim`` pixels."""
    h, w = rgb.shape[:2]
    scale = max_dim / max(h, w)
    if scale >= 1.0:
        return rgb
    return cv2.resize(rgb, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


class BridgeApi:
    """Methods exposed to JavaScript as ``pywebview.api.*``.

    Every return value is JSON-serialisable (dict / list / scalar / None) —
    PyWebView cannot marshal arbitrary Python objects across the bridge.
    Underscore-prefixed members are NOT exposed to JavaScript.
    """

    def __init__(self) -> None:
        # The pywebview window, bound by main.py right after create_window();
        # needed by the window-control methods for the custom title bar.
        self._window = None
        # Anchor rectangle of the in-progress edge-resize drag (see
        # window_begin_resize); None outside a drag.
        self._resize_drag = None

    def _bind_window(self, window) -> None:
        self._window = window

    def _require_window(self):
        if self._window is None:
            raise RuntimeError("No window bound; window controls are unavailable.")
        return self._window

    # --- Window controls (custom title bar on the frameless window) ---------

    def window_is_maximized(self) -> bool:
        """True if the window is currently maximized (sets the initial icon).

        Reads the real native state (WinForms ``FormWindowState``) rather than
        tracking a flag, so Win+Arrow snapping can't desync the toggle.
        """
        native = getattr(self._require_window(), "native", None)
        return str(getattr(native, "WindowState", "")) == "Maximized"

    def window_minimize(self) -> None:
        """Minimize the app window."""
        self._require_window().minimize()

    def window_toggle_maximize(self) -> bool:
        """Maximize or restore the window; returns True when now maximized."""
        window = self._require_window()
        if self.window_is_maximized():
            window.restore()
            return False
        window.maximize()
        return True

    def window_close(self) -> None:
        """Close the app window (quits the application)."""
        self._require_window().destroy()

    def window_get_size(self) -> dict:
        """Current native window size (native pixels, not CSS pixels)."""
        window = self._require_window()
        return {"width": window.width, "height": window.height}

    def window_begin_resize(self, edge: str) -> dict:
        """Start a custom edge-resize drag: capture the anchor rectangle ONCE.

        ``edge`` is the dragged edge/corner (n/s/e/w/ne/nw/se/sw). The native
        geometry is read a single time here — reading it again on every step
        races the UI thread's bounds updates and the error compounds until the
        window walks off-screen. Returns the starting size so the frontend can
        calibrate its CSS-px → native-px scale factor.
        """
        if edge not in _RESIZE_EDGES:
            raise ValueError(f"Unknown resize edge: {edge!r}")
        native = self._require_window().native
        left, top = int(native.Left), int(native.Top)
        width, height = int(native.Width), int(native.Height)
        self._resize_drag = {
            "edge": edge,
            "left": left,
            "top": top,
            "right": left + width,
            "bottom": top + height,
            "hwnd": native.Handle.ToInt64(),
        }
        return {"width": width, "height": height}

    def window_resize(self, width: int, height: int) -> bool:
        """One step of the active resize drag (after ``window_begin_resize``).

        The edge opposite the dragged one stays pinned to the anchor captured
        at drag start; sizes are clamped to the app minimum. Returns True so
        the frontend's promise chain has a value to settle on.
        """
        drag = self._resize_drag
        if drag is None:
            raise RuntimeError("window_begin_resize must be called before window_resize.")
        width = max(int(width), MIN_WINDOW_WIDTH)
        height = max(int(height), MIN_WINDOW_HEIGHT)
        x = drag["right"] - width if "w" in drag["edge"] else drag["left"]
        y = drag["bottom"] - height if "n" in drag["edge"] else drag["top"]
        _set_window_rect(drag["hwnd"], x, y, width, height)
        return True

    # --- Spotify session & account (docs/SPOTIFY_INTEGRATION.md) ------------

    def has_spotify_session(self) -> bool:
        """True if a Spotify token is cached (the user has logged in before)."""
        return auth.has_spotify_session()

    def start_spotify_login(self) -> dict:
        """Run the interactive PKCE login; blocks until the OAuth callback returns.

        Returns ``{"success": bool, "error": str | None}``.
        """
        return auth.start_login_flow()

    def logout(self) -> None:
        """Delete the cached Spotify token; the frontend then returns to login."""
        auth.logout()

    def get_spotify_access_token(self) -> str:
        """Fresh access token for the Web Playback SDK, refreshed if near expiry."""
        return auth.get_valid_access_token()

    def verify_premium(self) -> dict:
        """Fetch ``/me`` and report Premium status — the hard playback gate.

        Returns ``{"premium": bool, "product": ..., "display_name": ..., "email": ...}``.
        """
        return account.verify_premium()

    def get_user_profile(self) -> dict:
        """Session-cached profile; fetches once via ``verify_premium()``."""
        return account.get_user_profile()

    def open_external_url(self, url: str) -> bool:
        """Open an allowlisted URL in the system's default browser.

        Outward links (e.g. the Spotify Premium upgrade page) must not navigate
        the embedded webview away from the app, so they go through this method.
        Raises ValueError for URLs outside the allowlist.
        """
        if not url.startswith(_ALLOWED_EXTERNAL_URL_PREFIXES):
            raise ValueError(f"URL not allowed: {url!r}")
        return webbrowser.open(url)

    # --- FER (docs/IMAGE_PIPELINE.md, docs/FER_MODEL.md) --------------------

    def detect_emotion(self, image_b64: str) -> dict:
        """Classify the emotion in a captured frame (base64 PNG/JPEG).

        Returns one of:
            ``{"status": "ok", "emotion": ..., "confidence": ..., "all_probs": ...}``
            ``{"status": "out_of_scope", "detected": ..., ...}``
            ``{"status": "error", "error": "<code>", ...}``

        The error codes are the ones frontend/js/error_handler.js maps to
        user-facing messages (no_face, multiple_faces, low_quality_*, ...).
        """
        with _fer_lock:
            processed = image_pipeline.process(image_b64)
            if processed["status"] == "error":
                logger.info("detect_emotion pipeline rejected frame: %s", processed["error"])
                return processed
            result = inference.predict_in_scope(processed["tensor"])
        if result["status"] == "ok":
            result["emotion"] = _EMOTION_ALIASES.get(result["emotion"], result["emotion"])
        return result

    def quick_face_check(self, image_b64: str) -> dict:
        """Cheap face count for the photo page's live guide (2 Hz ping).

        Returns ``{"face_count": int}``. A frame that cannot be decoded counts
        as zero faces — the shutter simply stays disabled, which is the right
        behaviour for one transient bad frame.
        """
        try:
            rgb = image_pipeline.decode_image(image_b64)
        except ValueError:
            return {"face_count": 0}
        small = _downscale(rgb, _QUICK_CHECK_MAX_DIM)
        with _fer_lock:
            faces = image_pipeline.detect_faces(small)
        return {"face_count": len(faces)}

    # --- Recommendation & playlists (docs/RECOMMENDATION.md) -----------------

    def generate_playlist(
        self, emotion: str, size: int = recommender.DEFAULT_PLAYLIST_SIZE
    ) -> list[dict]:
        """Build a playlist of ``size`` tracks for a supported emotion.

        Unseeded on purpose: repeat requests for the same emotion vary. Raises
        ValueError for unsupported emotions or a non-positive size.
        """
        size = int(size)
        if size < 1:
            raise ValueError(f"Playlist size must be >= 1, got {size}")
        return recommender.generate_playlist(emotion, size=size)

    def save_playlist(self, name: str, emotion: str | None, track_ids: list[str]) -> int:
        """Persist a playlist and its ordered tracks; returns the new playlist_id.

        ``emotion`` is the detection that produced the playlist, or None for a
        user-created one.
        """
        name = name.strip()
        if not name:
            raise ValueError("Playlist name must not be empty")
        if emotion is not None and emotion not in recommender.SUPPORTED_EMOTIONS:
            raise ValueError(f"Unsupported emotion: {emotion!r}")
        return playlists.save_playlist(name, list(track_ids), source_emotion=emotion)

    def list_user_playlists(self) -> list[dict]:
        """Saved playlists for the sidebar, newest-updated first."""
        return playlists.list_playlists()

    def load_playlist(self, playlist_id: int) -> dict | None:
        """A playlist's metadata plus ordered tracks, or None if it no longer exists."""
        return playlists.load_playlist(int(playlist_id))

    def rename_playlist(self, playlist_id: int, name: str) -> bool:
        """Rename a saved playlist. True if a row actually changed."""
        name = name.strip()
        if not name:
            raise ValueError("Playlist name must not be empty")
        return playlists.rename_playlist(int(playlist_id), name)

    def delete_playlist(self, playlist_id: int) -> bool:
        """Delete a saved playlist (songs cascade). True if it existed."""
        return playlists.delete_playlist(int(playlist_id))
