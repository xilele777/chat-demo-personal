CREATE TABLE mcp_oauth (
  server_id TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  tokens TEXT,
  lock_id TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE mcp_oauth_flows (
  state TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  server_id TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX mcp_oauth_flows_expiry ON mcp_oauth_flows(expires_at);
