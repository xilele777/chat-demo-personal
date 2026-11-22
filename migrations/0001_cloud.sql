CREATE TABLE cloud_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation TEXT NOT NULL,
  revision TEXT NOT NULL
);
INSERT INTO cloud_state VALUES (1, lower(hex(randomblob(16))), lower(hex(randomblob(16))));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX sessions_updated ON sessions(deleted, updated_at DESC);
CREATE TRIGGER sessions_insert AFTER INSERT ON sessions BEGIN
  UPDATE cloud_state SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER sessions_update AFTER UPDATE ON sessions BEGIN
  UPDATE cloud_state SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
CREATE TRIGGER sessions_delete AFTER DELETE ON sessions BEGIN
  UPDATE cloud_state SET revision = lower(hex(randomblob(16))) WHERE id = 1;
END;
