-- Soft-delete flag for playlists. Un-saving a playlist from the result page's
-- bookmark hides it (saved = 0) instead of deleting it, so it keeps its id,
-- created_at and songs and can be re-saved unchanged. list_playlists shows only
-- saved = 1; load_playlist loads either (the result page keeps an un-saved
-- playlist on screen until the user leaves or re-saves it). Orphaned un-saved
-- playlists are purged at app startup. The sidebar's explicit Delete is still a
-- hard delete. No index: the playlist table is tiny (a user's own playlists),
-- so the added WHERE saved = 1 scans trivially. See docs/DATABASE.md.

ALTER TABLE playlist ADD COLUMN saved TINYINT(1) NOT NULL DEFAULT 1 AFTER source_emotion;
