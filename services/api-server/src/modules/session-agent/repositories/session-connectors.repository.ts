import { AccessPolicySchema, type AccessPolicy } from "@repo/sprites-client";

export type SessionConnectorStatus = "active" | "pending_revocation";

/** Non-secret metadata for a session's internal Sprites connector (D1). */
export interface SessionConnectorRecord {
  sessionId: string;
  gatewayConnectionId: string;
  connectorName: string;
  policySummary: AccessPolicy | null;
  desiredRevision: string | null;
  attemptIdentity: string | null;
  status: SessionConnectorStatus;
  createdAt: string;
  updatedAt: string;
}

interface SessionConnectorRow {
  session_id: string;
  gateway_connection_id: string;
  connector_name: string;
  policy_summary_json: string;
  desired_revision?: string | null;
  attempt_identity?: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface SessionConnectorAttemptRecord {
  sessionId: string;
  desiredRevision: string;
  attemptIdentity: string;
  connectorName: string;
  gatewayConnectionId: string | null;
  previousGatewayConnectionId: string | null;
}

interface SessionConnectorAttemptRow {
  session_id: string;
  desired_revision: string;
  attempt_identity: string;
  connector_name: string;
  gateway_connection_id: string | null;
  previous_gateway_connection_id: string | null;
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
    gatewayConnectionId: string;
    connectorName: string;
    policySummary: AccessPolicy;
    desiredRevision?: string | null;
    attemptIdentity?: string | null;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO session_connectors
           (session_id, gateway_connection_id, connector_name, policy_summary_json,
            desired_revision, attempt_identity, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')
         ON CONFLICT(session_id) DO UPDATE SET
           gateway_connection_id = excluded.gateway_connection_id,
           connector_name = excluded.connector_name,
           policy_summary_json = excluded.policy_summary_json,
           desired_revision = excluded.desired_revision,
           attempt_identity = excluded.attempt_identity,
           status = 'active',
           updated_at = datetime('now')`,
      )
      .bind(
        params.sessionId,
        params.gatewayConnectionId,
        params.connectorName,
        JSON.stringify(params.policySummary),
        params.desiredRevision ?? null,
        params.attemptIdentity ?? null,
      )
      .run();
  }

  /** Returns durable provenance for a connector create/replacement attempt. */
  async getAttempt(sessionId: string): Promise<SessionConnectorAttemptRecord | null> {
    const row = await this.database
      .prepare("SELECT * FROM session_connector_attempts WHERE session_id = ?")
      .bind(sessionId)
      .first<SessionConnectorAttemptRow>();
    return row ? attemptRowToRecord(row) : null;
  }

  /** Records intent before connector creation so an uncertain response is discoverable. */
  async beginAttempt(params: {
    sessionId: string;
    desiredRevision: string;
    attemptIdentity: string;
    connectorName: string;
    previousGatewayConnectionId: string | null;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO session_connector_attempts
           (session_id, desired_revision, attempt_identity, connector_name,
            previous_gateway_connection_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           desired_revision = excluded.desired_revision,
           attempt_identity = excluded.attempt_identity,
           connector_name = excluded.connector_name,
           gateway_connection_id = NULL,
           previous_gateway_connection_id = excluded.previous_gateway_connection_id,
           updated_at = datetime('now')`,
      )
      .bind(
        params.sessionId,
        params.desiredRevision,
        params.attemptIdentity,
        params.connectorName,
        params.previousGatewayConnectionId,
      )
      .run();
  }

  /** Checkpoints the external ID before mirroring the verified active connector. */
  async setAttemptConnectionId(sessionId: string, gatewayConnectionId: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE session_connector_attempts
         SET gateway_connection_id = ?, updated_at = datetime('now')
         WHERE session_id = ?`,
      )
      .bind(gatewayConnectionId, sessionId)
      .run();
  }

  /** Clears completed create/replacement provenance after cleanup succeeds. */
  async deleteAttempt(sessionId: string): Promise<void> {
    await this.database
      .prepare("DELETE FROM session_connector_attempts WHERE session_id = ?")
      .bind(sessionId)
      .run();
  }

  /**
   * Marks the connector as pending external revocation so the gateway
   * connection id is never lost when teardown partially fails.
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
    gatewayConnectionId: row.gateway_connection_id,
    connectorName: row.connector_name,
    policySummary: parsePolicySummary(row.policy_summary_json),
    desiredRevision: row.desired_revision ?? null,
    attemptIdentity: row.attempt_identity ?? null,
    status: parseStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attemptRowToRecord(row: SessionConnectorAttemptRow): SessionConnectorAttemptRecord {
  return {
    sessionId: row.session_id,
    desiredRevision: row.desired_revision,
    attemptIdentity: row.attempt_identity,
    connectorName: row.connector_name,
    gatewayConnectionId: row.gateway_connection_id,
    previousGatewayConnectionId: row.previous_gateway_connection_id,
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
