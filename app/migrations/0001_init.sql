-- clips made by the PC worker (or imported), waiting for approval
CREATE TABLE clips (
  id TEXT PRIMARY KEY,
  streamer TEXT NOT NULL,
  title TEXT NOT NULL,              -- readable name, also the YouTube Shorts title
  caption_tiktok TEXT NOT NULL DEFAULT '',
  caption_instagram TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  video_key TEXT,                   -- R2 key of the full-quality mp4
  thumb_key TEXT,                   -- R2 key of a jpg preview
  duration REAL,
  score REAL,
  source_vod TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','approved','skipped')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX clips_status ON clips(status);

-- one row per clip per platform
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('instagram','tiktok','youtube')),
  scheduled_at TEXT NOT NULL,       -- UTC ISO time
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','posting','posted','failed')),
  remote_id TEXT,
  remote_url TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (clip_id, platform)
);
CREATE INDEX posts_due ON posts(status, scheduled_at);

-- "make clips from this Twitch link" jobs for the PC worker
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  twitch_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  progress TEXT NOT NULL DEFAULT '',
  log TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- connected platform accounts (tokens are encrypted before they get here)
CREATE TABLE accounts (
  platform TEXT PRIMARY KEY,
  display_name TEXT,
  tokens TEXT,
  expires_at TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('slots', '["12:00","17:00","21:00"]'),
  ('platforms', '["instagram","tiktok","youtube"]'),
  ('auto_schedule', 'true');
