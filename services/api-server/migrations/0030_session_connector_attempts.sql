ALTER TABLE session_connectors ADD COLUMN desired_revision TEXT;
ALTER TABLE session_connectors ADD COLUMN attempt_identity TEXT;

CREATE TABLE session_connector_attempts (
  session_id TEXT PRIMARY KEY,
  desired_revision TEXT NOT NULL,
  attempt_identity TEXT NOT NULL,
  connector_name TEXT NOT NULL,
  gateway_connection_id TEXT,
  previous_gateway_connection_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
