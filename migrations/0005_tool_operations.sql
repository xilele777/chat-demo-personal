-- Recovery evidence only: never credentials, arguments, chat text or complete results.
CREATE TABLE tool_operations (
  id TEXT PRIMARY KEY,
  request_id TEXT,
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approval', 'dispatched', 'done', 'unknown', 'denied')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  result_sha256 TEXT
);
CREATE INDEX tool_operations_request ON tool_operations(request_id, created_at);
