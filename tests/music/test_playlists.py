"""Tests for playlist CRUD.

Integration tests against the real ``echosoul`` database. These *write* rows
(playlists + songs), so every created playlist is tracked and deleted in
teardown. Skipped if MySQL is unreachable.
"""

from __future__ import annotations

import mysql.connector
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


@pytest.fixture(scope="module")
def extra_track_id(track_ids) -> str:
    """A catalogue track that is NOT in the base `track_ids` fixture."""
    rows = connection.fetchall("SELECT track_id FROM music LIMIT 8")
    remaining = [r["track_id"] for r in rows if r["track_id"] not in track_ids]
    assert remaining, "catalogue must be seeded for playlist tests"
    return remaining[0]


def test_add_track_appends_at_end_of_each_playlist(track_ids, extra_track_id, cleanup):
    id_a = playlists.save_playlist("Add A", track_ids, "happy")
    id_b = playlists.save_playlist("Add B", track_ids[:2], "sad")
    cleanup.extend([id_a, id_b])

    result = playlists.add_track_to_playlists(extra_track_id, [id_a, id_b])
    assert result == {"added": [id_a, id_b], "skipped": []}

    loaded_a = playlists.load_playlist(id_a)
    assert [t["track_id"] for t in loaded_a["tracks"]] == track_ids + [extra_track_id]
    assert loaded_a["tracks"][-1]["position"] == len(track_ids)
    loaded_b = playlists.load_playlist(id_b)
    assert [t["track_id"] for t in loaded_b["tracks"]] == track_ids[:2] + [extra_track_id]


def test_add_track_skips_playlist_already_containing_it(track_ids, cleanup):
    playlist_id = playlists.save_playlist("Add Dup", track_ids)
    cleanup.append(playlist_id)

    result = playlists.add_track_to_playlists(track_ids[0], [playlist_id])
    assert result == {"added": [], "skipped": [playlist_id]}
    assert len(playlists.load_playlist(playlist_id)["tracks"]) == len(track_ids)


def test_add_track_skips_missing_playlist(track_ids, extra_track_id, cleanup):
    playlist_id = playlists.save_playlist("Add Partial", track_ids)
    cleanup.append(playlist_id)

    result = playlists.add_track_to_playlists(extra_track_id, [2_000_000_000, playlist_id])
    assert result == {"added": [playlist_id], "skipped": [2_000_000_000]}


def test_add_track_bumps_updated_at(track_ids, extra_track_id, cleanup):
    playlist_id = playlists.save_playlist("Add Bump", track_ids)
    cleanup.append(playlist_id)
    # Push updated_at into the past so the CURRENT_TIMESTAMP bump is visible
    # regardless of how fast the test runs (the column has 1 s resolution).
    connection.execute(
        "UPDATE playlist SET updated_at = '2020-01-01 00:00:00' WHERE playlist_id = %s",
        (playlist_id,),
    )

    playlists.add_track_to_playlists(extra_track_id, [playlist_id])
    assert playlists.load_playlist(playlist_id)["updated_at"] > "2020-01-02"


# A track id that cannot exist in the catalogue (real Spotify IDs are base62;
# this one is synthetic). Used to exercise the bottom player's add path, where
# the playing song may not be an EchoSoul catalogue track at all.
_EXTERNAL_TRACK_ID = "ZZechosoulTESTtrack001"


@pytest.fixture
def external_track_cleanup():
    """Remove the synthetic external track and any playlist rows pointing at it.

    Deletes playlist_song references first so the music delete never trips the
    FK, regardless of which playlists the test's `cleanup` already removed.
    """
    yield
    connection.execute(
        "DELETE FROM playlist_song WHERE track_id = %s", (_EXTERNAL_TRACK_ID,)
    )
    connection.execute("DELETE FROM music WHERE track_id = %s", (_EXTERNAL_TRACK_ID,))


def test_add_unknown_track_with_meta_creates_catalogue_row(
    track_ids, cleanup, external_track_cleanup
):
    playlist_id = playlists.save_playlist("Add External", track_ids)
    cleanup.append(playlist_id)

    meta = {
        "track_name": "External Song",
        "artists": "Ext Artist;Feat Artist",
        "album_name": "External Album",
        "duration_ms": 201_000,
    }
    result = playlists.add_track_to_playlists(
        _EXTERNAL_TRACK_ID, [playlist_id], track_meta=meta
    )
    assert result == {"added": [playlist_id], "skipped": []}

    # The playlist renders it with the stored metadata (INNER JOIN on music).
    last = playlists.load_playlist(playlist_id)["tracks"][-1]
    assert last["track_id"] == _EXTERNAL_TRACK_ID
    assert last["track_name"] == "External Song"
    assert last["artists"] == "Ext Artist;Feat Artist"
    assert last["duration_ms"] == 201_000

    # Feature-less catalogue row: NULL features keep it out of every emotion
    # rule (BETWEEN never matches NULL) and out of v_in_scope_music.
    row = connection.fetchone(
        "SELECT valence, energy, tempo, popularity FROM music WHERE track_id = %s",
        (_EXTERNAL_TRACK_ID,),
    )
    assert row == {"valence": None, "energy": None, "tempo": None, "popularity": None}


def test_add_known_track_with_meta_keeps_catalogue_row(track_ids, extra_track_id, cleanup):
    playlist_id = playlists.save_playlist("Add Known Meta", track_ids)
    cleanup.append(playlist_id)
    before = connection.fetchone(
        "SELECT track_name, artists, valence FROM music WHERE track_id = %s",
        (extra_track_id,),
    )

    meta = {"track_name": "Wrong Name", "artists": "Wrong Artist"}
    result = playlists.add_track_to_playlists(extra_track_id, [playlist_id], track_meta=meta)
    assert result == {"added": [playlist_id], "skipped": []}

    after = connection.fetchone(
        "SELECT track_name, artists, valence FROM music WHERE track_id = %s",
        (extra_track_id,),
    )
    assert after == before


def test_add_unknown_track_without_meta_fails_loud(track_ids, cleanup, external_track_cleanup):
    playlist_id = playlists.save_playlist("Add External NoMeta", track_ids)
    cleanup.append(playlist_id)

    with pytest.raises(mysql.connector.Error):
        playlists.add_track_to_playlists(_EXTERNAL_TRACK_ID, [playlist_id])
    # The whole transaction rolled back: no partial playlist rows.
    assert len(playlists.load_playlist(playlist_id)["tracks"]) == len(track_ids)


def test_add_unknown_track_all_skipped_leaves_no_orphan_row(external_track_cleanup):
    meta = {"track_name": "External Song", "artists": "Ext Artist"}
    result = playlists.add_track_to_playlists(
        _EXTERNAL_TRACK_ID, [2_000_000_000], track_meta=meta
    )
    assert result == {"added": [], "skipped": [2_000_000_000]}
    # Every target was gone, so the stub row must not linger in the catalogue.
    assert (
        connection.fetchone(
            "SELECT 1 FROM music WHERE track_id = %s", (_EXTERNAL_TRACK_ID,)
        )
        is None
    )


def test_playlists_containing_track(track_ids, extra_track_id, cleanup):
    id_a = playlists.save_playlist("Contains A", track_ids)
    id_b = playlists.save_playlist("Contains B", track_ids[:1])
    cleanup.extend([id_a, id_b])

    containing = playlists.playlists_containing_track(track_ids[0])
    assert id_a in containing
    assert id_b in containing
    assert id_a not in playlists.playlists_containing_track(extra_track_id)


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
