-- Playlist description, editable from the result page alongside the name.
-- NULL means "no description" (the UI hides the line). See docs/DATABASE.md.

ALTER TABLE playlist ADD COLUMN description VARCHAR(500) DEFAULT NULL AFTER name;
