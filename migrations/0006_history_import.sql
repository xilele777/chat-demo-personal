CREATE TABLE history_imports (
  id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE history_import_sessions (
  import_id TEXT NOT NULL REFERENCES history_imports(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  PRIMARY KEY(import_id, id)
);
CREATE INDEX history_imports_expiry ON history_imports(expires_at);
