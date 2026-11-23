CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE mcp_approvals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  expires_at INTEGER NOT NULL
);
