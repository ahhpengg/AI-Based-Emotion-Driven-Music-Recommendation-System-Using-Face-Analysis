-- 0008_nullable_audio_features.sql
-- Allow catalogue rows without audio features (docs/DATABASE.md "External tracks").
--
-- The bottom player's add-to-playlist button can add whatever Spotify is
-- currently playing, including songs that are not in the merged catalogue
-- (started from the user's phone/desktop Spotify). Those are stored as
-- feature-less `music` rows built from the player's own metadata: playable
-- from playlists like any other row (playback only needs the track_id) and
-- searchable via the FULLTEXT index, but never emotion-recommended — the
-- recommender's BETWEEN predicates and the v_in_scope_music view both exclude
-- NULL features.
--
-- Rebuilds the 1.31M-row table (one-off; a few seconds to minutes locally).

ALTER TABLE music
    MODIFY valence FLOAT NULL,
    MODIFY energy  FLOAT NULL,
    MODIFY tempo   FLOAT NULL;
