-- Videos stay on the PC: the clip remembers where the file is,
-- and small preview images live in the database instead of R2.
ALTER TABLE clips ADD COLUMN local_path TEXT;

CREATE TABLE thumbs (
  clip_id TEXT PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,
  data BLOB NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg'
);

-- last time the PC poster checked in (shown in the app)
INSERT INTO settings (key, value) VALUES ('pc_last_seen', 'null')
  ON CONFLICT(key) DO NOTHING;
