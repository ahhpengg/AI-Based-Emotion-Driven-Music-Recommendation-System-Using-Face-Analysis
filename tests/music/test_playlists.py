"""Tests for playlist CRUD.

Integration tests against the real ``echosoul`` database. These *write* rows
(playlists + songs), so every created playlist is tracked and deleted in
teardown. Skipped if MySQL is unreachable.
"""

from __future__ import annotations

import pytest

from src.db import connection
from src.music import playlists


def _db_available() -> bool:
    try:
        with connection.get_connection() as conn:
            conn.ping(reconnect=False, attempts=1)
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _db_available(), reason="MySQL not reachable / .env not configured"
)


@pytest.fixture(scope="module")
def track_ids() -> list[str]:
    """A handful of real catalogue track IDs to build playlists from."""
    rows = connection.fetchall("SELECT track_id FROM music LIMIT 4")
    ids = [r["track_id"] for r in rows]
    assert len(ids) == 4, "catalogue must be seeded for playlist tests"
    return ids


@pytest.fixture
def cleanup():
    """Collect playlist IDs created by a test and hard-delete them afterwards."""
    created: list[int] = []
    yield created
    for playlist_id in created:
        playlists.delete_playlist(playlist_id)


def test_save_returns_new_int_id(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Test A", track_ids, "happy")
    cleanup.append(playlist_id)
    assert isinstance(playlist_id, int)
    assert playlist_id > 0


def test_save_and_load_roundtrip(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Test Roundtrip", track_ids, "sad")
    cleanup.append(playlist_id)

    loaded = playlists.load_playlist(playlist_id)
    assert loaded["name"] == "Test Roundtrip"
    assert loaded["source_emotion"] == "sad"
    assert [t["track_id"] for t in loaded["tracks"]] == track_ids
    # Position is the 0-based list index, in order.
    assert [t["position"] for t in loaded["tracks"]] == [0, 1, 2, 3]


def test_load_missing_returns_none():
    assert playlists.load_playlist(2_000_000_000) is None


def test_description_roundtrip(track_ids, cleanup):
    playlist_id = playlists.save_playlist(
        "Test Desc", track_ids, "happy", description="Curated for your joyful moments"
    )
    cleanup.append(playlist_id)
    assert playlists.load_playlist(playlist_id)["description"] == "Curated for your joyful moments"


def test_description_defaults_to_none(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Test No Desc", track_ids)
    cleanup.append(playlist_id)
    assert playlists.load_playlist(playlist_id)["description"] is None


def test_timestamps_are_iso_strings(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Test TS", track_ids)
    cleanup.append(playlist_id)
    loaded = playlists.load_playlist(playlist_id)
    # ISO-8601 (JSON-safe) rather than a datetime object.
    assert isinstance(loaded["created_at"], str)
    assert isinstance(loaded["updated_at"], str)


def test_save_empty_playlist_has_no_tracks(cleanup):
    playlist_id = playlists.save_playlist("Test Empty", [])
    cleanup.append(playlist_id)
    loaded = playlists.load_playlist(playlist_id)
    assert loaded["tracks"] == []


def test_list_includes_saved_with_track_count(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Test List", track_ids, "angry")
    cleanup.append(playlist_id)

    match = next(
        (p for p in playlists.list_playlists() if p["playlist_id"] == playlist_id),
        None,
    )
    assert match is not None
    assert match["track_count"] == len(track_ids)
    assert isinstance(match["created_at"], str)  # sidebar subtitle date
    assert isinstance(match["updated_at"], str)


def test_update_replaces_header_and_tracks(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Before", track_ids, "happy", description="old")
    cleanup.append(playlist_id)

    # Drop the second track: positions must repack to a gapless 0-based run.
    kept = [track_ids[0], track_ids[2], track_ids[3]]
    assert playlists.update_playlist(playlist_id, "After", kept, description="new") is True

    loaded = playlists.load_playlist(playlist_id)
    assert loaded["name"] == "After"
    assert loaded["description"] == "new"
    assert [t["track_id"] for t in loaded["tracks"]] == kept
    assert [t["position"] for t in loaded["tracks"]] == [0, 1, 2]


def test_update_clears_description_with_none(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Test Clear", track_ids, description="something")
    cleanup.append(playlist_id)
    assert playlists.update_playlist(playlist_id, "Test Clear", track_ids, description=None)
    assert playlists.load_playlist(playlist_id)["description"] is None


def test_update_with_identical_values_still_true(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Same", track_ids, description="same")
    cleanup.append(playlist_id)
    assert playlists.update_playlist(playlist_id, "Same", track_ids, description="same") is True


def test_update_missing_returns_false():
    assert playlists.update_playlist(2_000_000_000, "Nope", []) is False


def test_rename_changes_name(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Old Name", track_ids)
    cleanup.append(playlist_id)

    assert playlists.rename_playlist(playlist_id, "New Name") is True
    assert playlists.load_playlist(playlist_id)["name"] == "New Name"


def test_rename_missing_returns_false():
    assert playlists.rename_playlist(2_000_000_000, "Nope") is False


def test_delete_removes_playlist(track_ids):
    playlist_id = playlists.save_playlist("Test Delete", track_ids)
    assert playlists.delete_playlist(playlist_id) is True
    assert playlists.load_playlist(playlist_id) is None


def test_delete_missing_returns_false():
    assert playlists.delete_playlist(2_000_000_000) is False


def test_delete_cascades_to_songs(track_ids):
    playlist_id = playlists.save_playlist("Test Cascade", track_ids)
    playlists.delete_playlist(playlist_id)
    remaining = connection.fetchone(
        "SELECT COUNT(*) AS n FROM playlist_song WHERE playlist_id = %s",
        (playlist_id,),
    )
    assert remaining["n"] == 0
