CREATE TABLE session_connectors (
  session_id TEXT PRIMARY KEY,
  gateway_connection_id TEXT NOT NULL,
  connector_name TEXT NOT NULL,
  policy_summary_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
