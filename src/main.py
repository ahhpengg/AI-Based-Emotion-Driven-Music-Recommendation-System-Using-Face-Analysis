"""EchoSoul desktop app entry point: PyWebView window + JS bridge binding.

Run from the repository root:

    python -m src.main

Opens the native window over ``frontend/index.html`` (the auth gate), binds
:class:`BridgeApi` as ``pywebview.api``, and warms the FER model on a worker
thread so the first detection doesn't pay the model-load + graph-build cost.

Set ``ECHOSOUL_DEBUG=1`` (env or ``.env``) to open the webview devtools.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import webview
from dotenv import load_dotenv
from mysql.connector import Error as MySQLError

_REPO_ROOT = Path(__file__).resolve().parents[1]

# Allow running this file directly (python src/main.py, or an IDE Run button):
# the absolute `src.*` imports need the repo root on sys.path, which
# `python -m src.main` provides but direct execution does not.
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from src.api import BridgeApi  # noqa: E402
from src.api.bridge import MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH  # noqa: E402
from src.db import connection  # noqa: E402
from src.fer import inference  # noqa: E402
from src.music import playlists  # noqa: E402

logger = logging.getLogger(__name__)
FRONTEND_INDEX = _REPO_ROOT / "frontend" / "index.html"

WINDOW_TITLE = "EchoSoul"
WINDOW_WIDTH = 1280  # design target 1280×800 (docs/FRONTEND.md "Styling notes")
WINDOW_HEIGHT = 800
# Responsive floor is ≈700 px wide; stay safely above it. Shared with the
# bridge because the custom edge-resize drag enforces the same minimum.
MIN_SIZE = (MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
WINDOW_ICON = _REPO_ROOT / "frontend" / "assets" / "img" / "app.ico"  # generated from logo.png


def _check_database() -> None:
    """Fail fast with a diagnostic if MySQL is unreachable (docs/ARCHITECTURE.md).

    Every screen after login needs the catalogue, so starting without a
    database would only defer the failure to a less debuggable place.
    """
    try:
        connection.fetchone("SELECT 1")
    except (KeyError, MySQLError) as exc:
        # KeyError = missing DB_* variable in .env; MySQLError = server/creds.
        logger.critical(
            "Cannot connect to MySQL (%s). Check the server is running and the "
            "DB_* values in .env are correct, then start the app again.",
            exc,
        )
        raise SystemExit(1) from exc


def _purge_unsaved_playlists() -> None:
    """Finalise deferred deletes from previous sessions (docs/DATABASE.md).

    Un-saving a playlist from the result page's bookmark is a soft delete
    (``saved = 0``) so it can be re-saved while the page is open; once the app
    restarts nothing could re-save it, so drop those rows now. Best-effort — a
    cleanup failure (e.g. the 0011 migration not yet applied) must not stop the
    app starting.
    """
    try:
        purged = playlists.purge_unsaved_playlists()
        if purged:
            logger.info("purged %d un-saved playlist(s) from a previous session", purged)
    except MySQLError as exc:
        logger.warning("could not purge un-saved playlists: %s", exc)


def _warm_up_model() -> None:
    """Load + warm the FER model in the background (via ``webview.start(func=...)``).

    A missing model file is not fatal: manual mood selection and playback still
    work; only the camera flow needs the model.
    """
    try:
        inference.warmup()
        logger.info("FER model loaded and warmed up.")
    except FileNotFoundError as exc:
        logger.error("FER model unavailable — camera flow will fail: %s", exc)


def _set_windows_app_identity() -> None:
    """Give the process its own taskbar identity on Windows.

    Without an explicit AppUserModelID, Windows groups the window under
    python.exe and shows the Python icon in the taskbar regardless of the
    window's own icon.
    """
    if sys.platform != "win32":
        return
    import ctypes

    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("EchoSoul.App")


def _set_webview2_browser_args() -> None:
    """Assemble the WebView2 browser arguments (Windows only).

    ``WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`` **overrides** — does not append
    to — the ``AdditionalBrowserArguments`` pywebview sets programmatically
    (verified live 2026-07-13: with the env var set, pywebview's own flags
    vanish from the browser command line). So besides adding our flag, this
    must restate pywebview 5.x's flags:

    - ``--allow-file-access-from-files``: pywebview passes this because
      ``ALLOW_FILE_URLS`` defaults on. Losing it is fatal — ES module
      ``<script>`` tags on ``file://`` pages are blocked by CORS (opaque
      origin) and no page script runs at all.
    - ``--disable-features=ElasticOverscroll``: pywebview's default (cosmetic).
    - ``--autoplay-policy=no-user-gesture-required``: ours. The app navigates
      between real HTML files, so a page that resumes music (playback.js's
      cross-page transfer) has no user activation yet; Chromium would block
      the audio. playback.js still handles the SDK's ``autoplay_failed`` in
      case this flag ever stops working — the player then just stays paused.

    Flags already present in the env var (e.g. a dev launcher's
    ``--remote-debugging-port``) are preserved.
    """
    if sys.platform != "win32":
        return
    flags = [
        "--disable-features=ElasticOverscroll",
        "--allow-file-access-from-files",
        "--autoplay-policy=no-user-gesture-required",
    ]
    existing = os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
    merged = [existing] + [flag for flag in flags if flag not in existing]
    os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join(merged).strip()


def _set_window_icon(window: webview.Window) -> None:
    """Set the title-bar/taskbar icon on the native window.

    pywebview's own ``icon`` option is GTK/QT-only, so on Windows (WinForms
    backend) we set ``Form.Icon`` through pythonnet instead. Two rules apply:
    the native form must exist (wait for the ``shown`` event — this function
    runs on pywebview's worker thread, possibly before the GUI loop built the
    window), and WinForms UI members may only be touched from the UI thread
    (marshal the assignment with ``Form.Invoke``). Purely cosmetic: any failure
    logs and the app carries on.
    """
    if not WINDOW_ICON.exists():
        logger.warning("Window icon missing: %s", WINDOW_ICON)
        return
    try:
        window.events.shown.wait(15)

        from System import Action  # pythonnet; loaded by pywebview's WinForms backend
        from System.Drawing import Icon

        form = window.native

        def apply_icon() -> None:
            form.Icon = Icon(str(WINDOW_ICON))

        form.Invoke(Action(apply_icon))
        logger.info("Window icon applied.")
    except Exception as exc:  # noqa: BLE001 — cosmetic; never let the icon kill the app
        logger.warning("Could not set the window icon: %s", exc)


def _round_corners(window: webview.Window) -> None:
    """Windows 11: round the frameless window's corners.

    A ``FormBorderStyle.None`` window loses DWM's automatic rounding, so ask
    for it explicitly (DWMWA_WINDOW_CORNER_PREFERENCE=33, DWMWCP_ROUND=2).
    Silently does nothing on Windows 10, which ignores the attribute.
    """
    try:
        import ctypes

        window.events.shown.wait(15)
        hwnd = window.native.Handle.ToInt64()
        preference = ctypes.c_int(2)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(preference), 4)
    except Exception as exc:  # noqa: BLE001 — cosmetic; never let corners kill the app
        logger.warning("Could not round the window corners: %s", exc)


def _on_start(window: webview.Window) -> None:
    """Post-start tasks, run by pywebview on a worker thread."""
    _set_window_icon(window)
    _round_corners(window)
    _warm_up_model()


def main() -> None:
    """Start the EchoSoul desktop app."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    load_dotenv(_REPO_ROOT / ".env")
    debug = os.environ.get("ECHOSOUL_DEBUG", "0").lower() in {"1", "true", "yes"}

    _check_database()
    _purge_unsaved_playlists()
    _set_windows_app_identity()
    _set_webview2_browser_args()

    api = BridgeApi()
    # frameless: the OS title bar is replaced by the in-page one (js/titlebar.js
    # + the window_* bridge methods). easy_drag stays off — only elements with
    # the `pywebview-drag-region` class drag the window, not the whole page.
    window = webview.create_window(
        WINDOW_TITLE,
        url=FRONTEND_INDEX.as_uri(),
        js_api=api,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=MIN_SIZE,
        frameless=True,
        easy_drag=False,
    )
    api._bind_window(window)
    # private_mode=False so localStorage and cookies persist across runs — the
    # Spotify Web Playback SDK keeps state in localStorage
    # (docs/SPOTIFY_INTEGRATION.md, "SDK + PyWebView gotchas").
    webview.start(func=_on_start, args=(window,), debug=debug, private_mode=False)


if __name__ == "__main__":
    main()
