import { AccessPolicySchema, type AccessPolicy } from "@repo/sprites-client";

export type SessionConnectorStatus = "active" | "pending_revocation";

/** Non-secret metadata for a session's internal Sprites connector (D1). */
export interface SessionConnectorRecord {
  sessionId: string;
  gatewayConnectorId: string;
  connectorName: string;
  policySummary: AccessPolicy | null;
  status: SessionConnectorStatus;
  createdAt: string;
  updatedAt: string;
}

interface SessionConnectorRow {
  session_id: string;
  gateway_connection_id: string;
  connector_name: string;
  policy_summary_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * D1-backed metadata store for per-session internal connectors. Stores only
 * non-secret metadata; the injected session token stays in DO SQLite.
 */
export class SessionConnectorsRepository {
  constructor(private readonly database: D1Database) {}

  /** Returns the session's connector record, or null when none exists. */
  async get(sessionId: string): Promise<SessionConnectorRecord | null> {
    const row = await this.database
      .prepare("SELECT * FROM session_connectors WHERE session_id = ?")
      .bind(sessionId)
      .first<SessionConnectorRow>();
    return row ? rowToRecord(row) : null;
  }

  /** Records a verified connector as the session's active connector. */
  async upsertActive(params: {
    sessionId: string;
    gatewayConnectorId: string;
    connectorName: string;
    policySummary: AccessPolicy;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO session_connectors
           (session_id, gateway_connection_id, connector_name, policy_summary_json, status)
         VALUES (?, ?, ?, ?, 'active')
         ON CONFLICT(session_id) DO UPDATE SET
           gateway_connection_id = excluded.gateway_connection_id,
           connector_name = excluded.connector_name,
           policy_summary_json = excluded.policy_summary_json,
           status = 'active',
           updated_at = datetime('now')`,
      )
      .bind(
        params.sessionId,
        params.gatewayConnectorId,
        params.connectorName,
        JSON.stringify(params.policySummary),
      )
      .run();
  }

  /**
   * Marks the connector as pending external revocation so the gateway
   * connector id is never lost when teardown partially fails.
   */
  async markPendingRevocation(sessionId: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE session_connectors
         SET status = 'pending_revocation', updated_at = datetime('now')
         WHERE session_id = ?`,
      )
      .bind(sessionId)
      .run();
  }

  /** Removes the record after external connector deletion is confirmed. */
  async delete(sessionId: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM session_connectors WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }
}

function rowToRecord(row: SessionConnectorRow): SessionConnectorRecord {
  return {
    sessionId: row.session_id,
    gatewayConnectorId: row.gateway_connection_id,
    connectorName: row.connector_name,
    policySummary: parsePolicySummary(row.policy_summary_json),
    status: parseStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parsePolicySummary(json: string): AccessPolicy | null {
  try {
    const result = AccessPolicySchema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseStatus(status: string): SessionConnectorStatus {
  switch (status) {
    case "active":
      return "active";
    case "pending_revocation":
      return "pending_revocation";
    default:
      // Unknown statuses degrade to pending_revocation so a bad row is
      // treated as needing reconciliation, never as an active connector.
      return "pending_revocation";
  }
}
