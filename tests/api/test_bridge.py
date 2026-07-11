"""Unit tests for the PyWebView bridge (src/api/bridge.py).

Every domain function the bridge delegates to is monkeypatched, so these tests
cover only the bridge's own responsibilities: input validation, the
surprise->surprised label aliasing, error-dict passthrough, frame downscaling
for the live face ping, and JSON-serialisability of everything handed to
JavaScript.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from src.api import bridge as bridge_module
from src.api.bridge import BridgeApi, _downscale


@pytest.fixture()
def api() -> BridgeApi:
    return BridgeApi()


# --- detect_emotion ---------------------------------------------------------


def _patch_pipeline(monkeypatch, process_result, predict_result=None):
    monkeypatch.setattr(bridge_module.image_pipeline, "process", lambda b64: process_result)
    if predict_result is not None:
        monkeypatch.setattr(
            bridge_module.inference, "predict_in_scope", lambda tensor: dict(predict_result)
        )


def test_detect_emotion_maps_surprise_to_surprised(monkeypatch, api):
    tensor = np.zeros((300, 300, 1), dtype="float32")
    _patch_pipeline(
        monkeypatch,
        {"status": "ok", "tensor": tensor},
        {"status": "ok", "emotion": "surprise", "confidence": 0.9, "all_probs": {}},
    )
    result = api.detect_emotion("b64")
    assert result["emotion"] == "surprised"


def test_detect_emotion_leaves_other_labels_unchanged(monkeypatch, api):
    tensor = np.zeros((300, 300, 1), dtype="float32")
    _patch_pipeline(
        monkeypatch,
        {"status": "ok", "tensor": tensor},
        {"status": "ok", "emotion": "happy", "confidence": 0.8, "all_probs": {}},
    )
    assert api.detect_emotion("b64")["emotion"] == "happy"


def test_detect_emotion_returns_pipeline_error_without_inference(monkeypatch, api):
    _patch_pipeline(monkeypatch, {"status": "error", "error": "no_face"})

    def _must_not_run(tensor):
        raise AssertionError("inference must not run when the pipeline fails")

    monkeypatch.setattr(bridge_module.inference, "predict_in_scope", _must_not_run)
    result = api.detect_emotion("b64")
    assert result == {"status": "error", "error": "no_face"}


def test_detect_emotion_passes_out_of_scope_through(monkeypatch, api):
    tensor = np.zeros((300, 300, 1), dtype="float32")
    _patch_pipeline(
        monkeypatch,
        {"status": "ok", "tensor": tensor},
        {"status": "out_of_scope", "detected": "fear", "confidence": 0.7, "all_probs": {}},
    )
    result = api.detect_emotion("b64")
    assert result["status"] == "out_of_scope"
    assert result["detected"] == "fear"


def test_detect_emotion_result_is_json_serialisable(monkeypatch, api):
    tensor = np.zeros((300, 300, 1), dtype="float32")
    _patch_pipeline(
        monkeypatch,
        {"status": "ok", "tensor": tensor},
        {
            "status": "ok",
            "emotion": "surprise",
            "confidence": 0.9,
            "all_probs": {"happy": 0.1, "surprise": 0.9},
        },
    )
    json.dumps(api.detect_emotion("b64"))


# --- quick_face_check --------------------------------------------------------


def test_quick_face_check_counts_faces_on_downscaled_frame(monkeypatch, api):
    frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    seen = {}

    def _fake_detect(rgb):
        seen["shape"] = rgb.shape
        return [np.zeros((478, 2))]

    monkeypatch.setattr(bridge_module.image_pipeline, "decode_image", lambda b64: frame)
    monkeypatch.setattr(bridge_module.image_pipeline, "detect_faces", _fake_detect)

    result = api.quick_face_check("b64")
    assert result == {"face_count": 1}
    assert max(seen["shape"][:2]) <= bridge_module._QUICK_CHECK_MAX_DIM
    json.dumps(result)


def test_quick_face_check_returns_zero_on_decode_failure(monkeypatch, api):
    def _bad_decode(b64):
        raise ValueError("image decode failed")

    monkeypatch.setattr(bridge_module.image_pipeline, "decode_image", _bad_decode)
    assert api.quick_face_check("not-b64") == {"face_count": 0}


def test_downscale_preserves_aspect_and_skips_small_frames():
    big = np.zeros((720, 1280, 3), dtype=np.uint8)
    small = _downscale(big, 320)
    assert small.shape == (180, 320, 3)

    tiny = np.zeros((240, 320, 3), dtype=np.uint8)
    assert _downscale(tiny, 320) is tiny


# --- generate_playlist -------------------------------------------------------


def test_generate_playlist_delegates_with_default_size(monkeypatch, api):
    calls = {}

    def _fake_generate(emotion, size):
        calls["emotion"], calls["size"] = emotion, size
        return [{"track_id": "t1"}]

    monkeypatch.setattr(bridge_module.recommender, "generate_playlist", _fake_generate)
    result = api.generate_playlist("happy")
    assert result == [{"track_id": "t1"}]
    assert calls == {"emotion": "happy", "size": bridge_module.recommender.DEFAULT_PLAYLIST_SIZE}
    json.dumps(result)


@pytest.mark.parametrize("bad_size", [0, -3])
def test_generate_playlist_rejects_non_positive_size(monkeypatch, api, bad_size):
    monkeypatch.setattr(
        bridge_module.recommender,
        "generate_playlist",
        lambda emotion, size: pytest.fail("must not be called"),
    )
    with pytest.raises(ValueError):
        api.generate_playlist("happy", bad_size)


def test_generate_playlist_coerces_js_number_size(monkeypatch, api):
    # PyWebView delivers JS numbers as float when they cross the bridge.
    seen = {}

    def _fake_generate(emotion, size):
        seen["size"] = size
        return []

    monkeypatch.setattr(bridge_module.recommender, "generate_playlist", _fake_generate)
    api.generate_playlist("sad", 25.0)
    assert seen["size"] == 25
    assert isinstance(seen["size"], int)


# --- playlist CRUD -----------------------------------------------------------


def test_save_playlist_delegates_and_returns_id(monkeypatch, api):
    seen = {}

    def _fake_save(name, track_ids, source_emotion):
        seen.update(name=name, track_ids=track_ids, source_emotion=source_emotion)
        return 7

    monkeypatch.setattr(bridge_module.playlists, "save_playlist", _fake_save)
    assert api.save_playlist("Happy — today", "happy", ["t1", "t2"]) == 7
    assert seen == {"name": "Happy — today", "track_ids": ["t1", "t2"], "source_emotion": "happy"}


def test_save_playlist_allows_user_created_without_emotion(monkeypatch, api):
    monkeypatch.setattr(
        bridge_module.playlists,
        "save_playlist",
        lambda name, track_ids, source_emotion: 1,
    )
    assert api.save_playlist("My mix", None, []) == 1


@pytest.mark.parametrize("bad_name", ["", "   "])
def test_save_playlist_rejects_blank_name(api, bad_name):
    with pytest.raises(ValueError):
        api.save_playlist(bad_name, "happy", ["t1"])


def test_save_playlist_rejects_unknown_emotion(api):
    with pytest.raises(ValueError):
        api.save_playlist("Mix", "fear", ["t1"])


def test_rename_playlist_rejects_blank_name(api):
    with pytest.raises(ValueError):
        api.rename_playlist(1, "  ")


def test_playlist_crud_delegates_with_int_coercion(monkeypatch, api):
    seen = {}
    monkeypatch.setattr(bridge_module.playlists, "list_playlists", lambda: [{"playlist_id": 1}])
    monkeypatch.setattr(
        bridge_module.playlists,
        "load_playlist",
        lambda pid: seen.setdefault("load", pid) and None,
    )
    monkeypatch.setattr(
        bridge_module.playlists,
        "rename_playlist",
        lambda pid, name: seen.setdefault("rename", (pid, name)) and True,
    )
    monkeypatch.setattr(
        bridge_module.playlists,
        "delete_playlist",
        lambda pid: seen.setdefault("delete", pid) and True,
    )

    assert api.list_user_playlists() == [{"playlist_id": 1}]
    api.load_playlist(3.0)  # JS numbers arrive as float
    api.rename_playlist(4.0, "New name")
    api.delete_playlist(5.0)
    assert seen == {"load": 3, "rename": (4, "New name"), "delete": 5}
    assert all(isinstance(v, int) for v in (seen["load"], seen["rename"][0], seen["delete"]))


# --- window controls ---------------------------------------------------------


class _FakeHandle:
    def ToInt64(self):  # noqa: N802 - mimics System.IntPtr
        return 42


class _FakeNative:
    def __init__(self, state: str):
        self.WindowState = state
        self.Left = 100
        self.Top = 50
        self.Width = 1280
        self.Height = 800
        self.Handle = _FakeHandle()


class _FakeWindow:
    """Mimics the pywebview Window surface the bridge touches."""

    def __init__(self):
        self.native = _FakeNative("Normal")
        self.calls = []
        self.width = 1280
        self.height = 800

    def minimize(self):
        self.calls.append("minimize")

    def maximize(self):
        self.calls.append("maximize")
        self.native.WindowState = "Maximized"

    def restore(self):
        self.calls.append("restore")
        self.native.WindowState = "Normal"

    def destroy(self):
        self.calls.append("destroy")


def test_window_controls_require_bound_window(api):
    with pytest.raises(RuntimeError):
        api.window_minimize()


def test_window_toggle_maximize_follows_native_state(api):
    win = _FakeWindow()
    api._bind_window(win)
    assert api.window_toggle_maximize() is True
    assert api.window_is_maximized() is True
    assert api.window_toggle_maximize() is False
    assert api.window_is_maximized() is False
    assert win.calls == ["maximize", "restore"]


def test_window_minimize_and_close_delegate(api):
    win = _FakeWindow()
    api._bind_window(win)
    api.window_minimize()
    api.window_close()
    assert win.calls == ["minimize", "destroy"]


def test_window_get_size_reports_native_size(api):
    win = _FakeWindow()
    api._bind_window(win)
    assert api.window_get_size() == {"width": 1280, "height": 800}
    json.dumps(api.window_get_size())


@pytest.fixture()
def rects(monkeypatch):
    """Capture _set_window_rect calls instead of hitting Win32."""
    calls = []
    monkeypatch.setattr(
        bridge_module,
        "_set_window_rect",
        lambda hwnd, x, y, w, h: calls.append((hwnd, x, y, w, h)),
    )
    return calls


def test_window_resize_anchors_opposite_edge_from_drag_start(api, rects):
    # Fake native rect: left=100 top=50 width=1280 height=800 -> right=1380 bottom=850.
    win = _FakeWindow()
    api._bind_window(win)

    assert api.window_begin_resize("nw") == {"width": 1280, "height": 800}
    api.window_resize(1000, 700)
    # Bottom-right corner stays pinned even if the fake native rect changes
    # afterwards (the anchor was captured at drag start).
    win.native.Left = 999
    win.native.Width = 1
    api.window_resize(900, 650)
    assert rects == [
        (42, 380, 150, 1000, 700),
        (42, 480, 200, 900, 650),
    ]


def test_window_resize_east_edge_keeps_origin(api, rects):
    win = _FakeWindow()
    api._bind_window(win)
    api.window_begin_resize("se")
    api.window_resize(1000, 700)
    assert rects == [(42, 100, 50, 1000, 700)]


def test_window_resize_clamps_to_minimum(api, rects):
    win = _FakeWindow()
    api._bind_window(win)
    api.window_begin_resize("se")
    api.window_resize(10, 10)
    assert rects == [(42, 100, 50, bridge_module.MIN_WINDOW_WIDTH, bridge_module.MIN_WINDOW_HEIGHT)]


def test_window_begin_resize_rejects_unknown_edge(api, rects):
    win = _FakeWindow()
    api._bind_window(win)
    with pytest.raises(ValueError):
        api.window_begin_resize("x")
    assert rects == []


def test_window_resize_requires_begin(api, rects):
    win = _FakeWindow()
    api._bind_window(win)
    with pytest.raises(RuntimeError):
        api.window_resize(900, 700)
    assert rects == []


# --- open_external_url -------------------------------------------------------


@pytest.mark.parametrize(
    "good_url",
    [
        "https://www.spotify.com/premium/",  # Premium upgrade page
        "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",  # Free deep link
    ],
)
def test_open_external_url_opens_allowlisted_url(monkeypatch, api, good_url):
    opened = []
    monkeypatch.setattr(bridge_module.webbrowser, "open", lambda url: opened.append(url) or True)
    assert api.open_external_url(good_url) is True
    assert opened == [good_url]


@pytest.mark.parametrize(
    "bad_url",
    [
        "http://www.spotify.com/premium/",  # not https
        "https://evil.example/phish",
        "javascript:alert(1)",
        "https://www.spotify.com.evil.example/",
    ],
)
def test_open_external_url_rejects_non_allowlisted_url(monkeypatch, api, bad_url):
    monkeypatch.setattr(bridge_module.webbrowser, "open", lambda url: pytest.fail("must not open"))
    with pytest.raises(ValueError):
        api.open_external_url(bad_url)


# --- Spotify passthroughs ----------------------------------------------------


def test_spotify_methods_delegate(monkeypatch, api):
    monkeypatch.setattr(bridge_module.auth, "has_spotify_session", lambda: True)
    monkeypatch.setattr(
        bridge_module.auth, "start_login_flow", lambda: {"success": True, "error": None}
    )
    monkeypatch.setattr(bridge_module.auth, "get_valid_access_token", lambda: "tok")
    monkeypatch.setattr(bridge_module.account, "verify_premium", lambda: {"premium": True})
    monkeypatch.setattr(bridge_module.account, "get_user_profile", lambda: {"premium": True})
    logged_out = []
    monkeypatch.setattr(bridge_module.auth, "logout", lambda: logged_out.append(True))

    assert api.has_spotify_session() is True
    assert api.start_spotify_login() == {"success": True, "error": None}
    assert api.get_spotify_access_token() == "tok"
    assert api.verify_premium() == {"premium": True}
    assert api.get_user_profile() == {"premium": True}
    api.logout()
    assert logged_out == [True]
