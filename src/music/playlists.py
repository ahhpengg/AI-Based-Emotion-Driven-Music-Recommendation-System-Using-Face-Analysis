"""Playlist persistence: save, load, list, update, rename, delete, add songs.

CRUD over the ``playlist`` and ``playlist_song`` tables (docs/DATABASE.md).
Playlists are both system-generated (from an emotion detection) and
user-created. Timestamps are returned as ISO-8601 strings so results stay
JSON-serialisable across the PyWebView bridge.
"""

from __future__ import annotations

from datetime import datetime

from src.db import connection

_INSERT_PLAYLIST_SQL = """
    INSERT INTO playlist (name, description, source_emotion)
    VALUES (%s, %s, %s)
"""

_INSERT_SONG_SQL = """
    INSERT INTO playlist_song (playlist_id, track_id, position)
    VALUES (%s, %s, %s)
"""

_SELECT_HEADER_SQL = """
    SELECT playlist_id, name, description, source_emotion, saved, created_at, updated_at
    FROM playlist
    WHERE playlist_id = %s
"""

_SELECT_SONGS_SQL = """
    SELECT m.track_id, m.track_name, m.artists, m.album_name, m.duration_ms,
           ps.position
    FROM playlist_song ps
    JOIN music m ON m.track_id = ps.track_id
    WHERE ps.playlist_id = %s
    ORDER BY ps.position
"""

_LIST_SQL = """
    SELECT playlist_id, name, source_emotion, created_at, updated_at,
           (SELECT COUNT(*) FROM playlist_song WHERE playlist_id = p.playlist_id)
               AS track_count
    FROM playlist p
    WHERE p.saved = 1
    ORDER BY updated_at DESC
    LIMIT %s
"""

_UPDATE_PLAYLIST_SQL = """
    UPDATE playlist
    SET name = %s, description = %s, updated_at = CURRENT_TIMESTAMP
    WHERE playlist_id = %s
"""

_INSERT_STUB_TRACK_SQL = """
    INSERT INTO music (track_id, track_name, artists, album_name, duration_ms)
    VALUES (%s, %s, %s, %s, %s)
"""


def _iso(value: datetime | None) -> str | None:
    """Render a datetime column as an ISO-8601 string (JSON-safe), or None."""
    return value.isoformat() if value is not None else None


def save_playlist(
    name: str,
    track_ids: list[str],
    source_emotion: str | None = None,
    description: str | None = None,
) -> int:
    """Create a playlist and its ordered songs in a single transaction.

    Args:
        name:           Display name for the playlist.
        track_ids:      Spotify track IDs, in playlist order (index becomes the
                        0-based ``position``). May be empty.
        source_emotion: The emotion that produced this playlist, or None for a
                        user-created one.
        description:    Optional user-facing description, or None for none.

    Returns the new ``playlist_id``. Any duplicate track in ``track_ids`` or a
    track absent from the catalogue aborts the whole save (fail loud).
    """
    with connection.get_cursor(commit=True) as cur:
        cur.execute(_INSERT_PLAYLIST_SQL, (name, description, source_emotion))
        playlist_id = cur.lastrowid
        if track_ids:
            rows = [
                (playlist_id, track_id, position) for position, track_id in enumerate(track_ids)
            ]
            cur.executemany(_INSERT_SONG_SQL, rows)
    return playlist_id


def update_playlist(
    playlist_id: int,
    name: str,
    track_ids: list[str],
    description: str | None = None,
) -> bool:
    """Replace a playlist's name, description and track list in one transaction.

    The songs are fully replaced (delete + re-insert), so removals repack the
    0-based ``position`` automatically. ``updated_at`` is bumped explicitly so
    a tracks-only edit still floats the playlist to the top of the sidebar.

    Returns False if the playlist does not exist, True otherwise — even when
    the submitted values are identical to what is stored.
    """
    with connection.get_cursor(commit=True) as cur:
        cur.execute("SELECT 1 FROM playlist WHERE playlist_id = %s", (playlist_id,))
        if cur.fetchone() is None:
            return False
        cur.execute(_UPDATE_PLAYLIST_SQL, (name, description, playlist_id))
        cur.execute("DELETE FROM playlist_song WHERE playlist_id = %s", (playlist_id,))
        if track_ids:
            rows = [
                (playlist_id, track_id, position) for position, track_id in enumerate(track_ids)
            ]
            cur.executemany(_INSERT_SONG_SQL, rows)
    return True


def load_playlist(playlist_id: int) -> dict | None:
    """Return a playlist's metadata plus its ordered tracks, or None if absent.

    The returned dict has the playlist columns (with ISO-string timestamps) and
    a ``tracks`` list ordered by position.
    """
    header = connection.fetchone(_SELECT_HEADER_SQL, (playlist_id,))
    if header is None:
        return None
    header["created_at"] = _iso(header["created_at"])
    header["updated_at"] = _iso(header["updated_at"])
    # TINYINT(1) comes back as 0/1 — hand the frontend a real bool.
    header["saved"] = bool(header["saved"])
    header["tracks"] = connection.fetchall(_SELECT_SONGS_SQL, (playlist_id,))
    return header


def list_playlists(limit: int = 50) -> list[dict]:
    """Return playlists for the sidebar, newest-updated first.

    Each row carries ``track_count`` and ISO-string timestamps (``created_at``
    feeds the sidebar's "N songs · Jul 12" subtitle).
    """
    rows = connection.fetchall(_LIST_SQL, (limit,))
    for row in rows:
        row["created_at"] = _iso(row["created_at"])
        row["updated_at"] = _iso(row["updated_at"])
    return rows


def playlists_containing_track(track_id: str) -> list[int]:
    """IDs of every playlist that already contains the given track.

    Feeds the header search's add-to-playlists popup, which shows those
    playlists as already-added (checked and locked).
    """
    rows = connection.fetchall(
        "SELECT playlist_id FROM playlist_song WHERE track_id = %s",
        (track_id,),
    )
    return [row["playlist_id"] for row in rows]


def add_track_to_playlists(
    track_id: str,
    playlist_ids: list[int],
    track_meta: dict | None = None,
) -> dict:
    """Append one song to several playlists in a single transaction.

    The song lands at the end of each playlist (max position + 1), and each
    playlist that gains it has ``updated_at`` bumped so it floats to the top
    of the sidebar. Playlists that already contain the track, or that no
    longer exist (deleted while the popup was open), are skipped rather than
    failing the whole batch.

    Args:
        track_id:     Spotify track ID of the song to append.
        playlist_ids: Target playlists, in submission order.
        track_meta:   Display metadata (``track_name``, ``artists``, optional
                      ``album_name``/``duration_ms``) for a song that may not
                      be in the catalogue — the bottom player can be playing
                      anything the user queued from their own Spotify. When
                      given and the track is unknown, a feature-less ``music``
                      row (NULL valence/energy/tempo, migration 0008) is
                      inserted in the same transaction: playable from
                      playlists like any catalogue song and findable in the
                      header search, but never emotion-recommended (the
                      recommender's BETWEEN filters exclude NULL features).
                      A track already in the catalogue keeps its real row —
                      the metadata is ignored.

    Returns ``{"added": [ids], "skipped": [ids]}`` in the order submitted.
    Without ``track_meta``, a track absent from the catalogue violates the FK
    and aborts the batch (fail loud — search results can only carry real
    catalogue tracks).
    """
    added: list[int] = []
    skipped: list[int] = []
    stub_inserted = False
    with connection.get_cursor(commit=True) as cur:
        if track_meta is not None:
            cur.execute("SELECT 1 FROM music WHERE track_id = %s", (track_id,))
            if cur.fetchone() is None:
                cur.execute(
                    _INSERT_STUB_TRACK_SQL,
                    (
                        track_id,
                        track_meta["track_name"],
                        track_meta["artists"],
                        track_meta.get("album_name"),
                        track_meta.get("duration_ms"),
                    ),
                )
                stub_inserted = True
        for playlist_id in playlist_ids:
            cur.execute("SELECT 1 FROM playlist WHERE playlist_id = %s", (playlist_id,))
            if cur.fetchone() is None:
                skipped.append(playlist_id)
                continue
            cur.execute(
                "SELECT 1 FROM playlist_song WHERE playlist_id = %s AND track_id = %s",
                (playlist_id, track_id),
            )
            if cur.fetchone() is not None:
                skipped.append(playlist_id)
                continue
            cur.execute(
                "SELECT COALESCE(MAX(position) + 1, 0) AS next_position"
                " FROM playlist_song WHERE playlist_id = %s",
                (playlist_id,),
            )
            next_position = cur.fetchone()["next_position"]
            cur.execute(_INSERT_SONG_SQL, (playlist_id, track_id, next_position))
            cur.execute(
                "UPDATE playlist SET updated_at = CURRENT_TIMESTAMP WHERE playlist_id = %s",
                (playlist_id,),
            )
            added.append(playlist_id)
        if stub_inserted and not added:
            # Every target playlist was deleted while the popup was open:
            # don't leave an orphan catalogue row that lives in no playlist.
            cur.execute("DELETE FROM music WHERE track_id = %s", (track_id,))
    return {"added": added, "skipped": skipped}


def rename_playlist(playlist_id: int, name: str) -> bool:
    """Rename a playlist. Returns True if the playlist existed and changed.

    Renaming to the identical name changes no row and returns False.
    """
    affected = connection.execute(
        "UPDATE playlist SET name = %s WHERE playlist_id = %s",
        (name, playlist_id),
    )
    return affected > 0


def set_playlist_saved(playlist_id: int, saved: bool) -> bool:
    """Mark a playlist as saved (shown in the sidebar) or un-saved (hidden).

    Un-saving is a *soft* delete: the row keeps its id, ``created_at`` and
    songs, so re-saving restores the playlist unchanged — this backs the result
    page's bookmark toggle. ``updated_at`` is bumped so a re-saved playlist
    floats to the top of the sidebar (the user just re-added it). Orphaned
    un-saved playlists are finalised by :func:`purge_unsaved_playlists` at app
    startup. The sidebar's explicit Delete stays a hard :func:`delete_playlist`.

    Returns True if the playlist exists, False otherwise.
    """
    with connection.get_cursor(commit=True) as cur:
        cur.execute("SELECT 1 FROM playlist WHERE playlist_id = %s", (playlist_id,))
        if cur.fetchone() is None:
            return False
        cur.execute(
            "UPDATE playlist SET saved = %s, updated_at = CURRENT_TIMESTAMP"
            " WHERE playlist_id = %s",
            (1 if saved else 0, playlist_id),
        )
    return True


def purge_unsaved_playlists() -> int:
    """Hard-delete every soft-deleted (``saved = 0``) playlist and its songs.

    Called once at app startup: an un-saved playlist stays re-saveable only for
    the session it was un-saved in (the result page keeps it on screen), so once
    the app restarts there is nothing left that could re-save it and the
    deferred delete is finalised. Returns the number of playlists purged.
    """
    return connection.execute("DELETE FROM playlist WHERE saved = 0")


def delete_playlist(playlist_id: int) -> bool:
    """Delete a playlist and (via ON DELETE CASCADE) its songs.

    A hard delete (the sidebar's explicit Delete) — contrast
    :func:`set_playlist_saved`, the reversible soft delete behind the bookmark.
    Returns True if a playlist was deleted, False if none matched.
    """
    affected = connection.execute(
        "DELETE FROM playlist WHERE playlist_id = %s",
        (playlist_id,),
    )
    return affected > 0
