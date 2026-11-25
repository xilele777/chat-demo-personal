CREATE TABLE object_pins (id TEXT PRIMARY KEY, version TEXT NOT NULL, keys TEXT NOT NULL);
CREATE TABLE object_gc_claims (key TEXT PRIMARY KEY);
-- A cleanup claim fences concurrent session/import commits until R2 deletion finishes.
CREATE TRIGGER sessions_gc_insert BEFORE INSERT ON sessions WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.data, '$.messages') m, json_each(m.value, '$.files') f, object_gc_claims c
  WHERE c.key = 'attachments/' || json_extract(f.value, '$.id') OR c.key = 'provider/' || json_extract(f.value, '$.serverId')
) BEGIN SELECT RAISE(ABORT, 'Attachment cleanup in progress; retry the save'); END;
CREATE TRIGGER sessions_gc_update BEFORE UPDATE ON sessions WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.data, '$.messages') m, json_each(m.value, '$.files') f, object_gc_claims c
  WHERE c.key = 'attachments/' || json_extract(f.value, '$.id') OR c.key = 'provider/' || json_extract(f.value, '$.serverId')
) BEGIN SELECT RAISE(ABORT, 'Attachment cleanup in progress; retry the save'); END;
