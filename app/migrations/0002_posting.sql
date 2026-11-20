-- when a post entered "posting" (Instagram processing timeout)
ALTER TABLE posts ADD COLUMN posting_started_at TEXT;
