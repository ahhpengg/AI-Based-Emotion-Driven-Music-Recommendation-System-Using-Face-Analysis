"""Playlist persistence: save, load, list, update, rename, delete.

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
    SELECT playlist_id, name, description, source_emotion, created_at, updated_at
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
    ORDER BY updated_at DESC
    LIMIT %s
"""

_UPDATE_PLAYLIST_SQL = """
    UPDATE playlist
    SET name = %s, description = %s, updated_at = CURRENT_TIMESTAMP
    WHERE playlist_id = %s
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


def rename_playlist(playlist_id: int, name: str) -> bool:
    """Rename a playlist. Returns True if the playlist existed and changed.

    Renaming to the identical name changes no row and returns False.
    """
    affected = connection.execute(
        "UPDATE playlist SET name = %s WHERE playlist_id = %s",
        (name, playlist_id),
    )
    return affected > 0


def delete_playlist(playlist_id: int) -> bool:
    """Delete a playlist and (via ON DELETE CASCADE) its songs.

    Returns True if a playlist was deleted, False if none matched.
    """
    affected = connection.execute(
        "DELETE FROM playlist WHERE playlist_id = %s",
        (playlist_id,),
    )
    return affected > 0
