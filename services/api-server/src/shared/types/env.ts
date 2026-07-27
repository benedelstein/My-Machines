export interface Env {
  // Durable Objects
  SESSION_AGENT: DurableObjectNamespace;
  USER_SESSIONS: DurableObjectNamespace;

  // D1 Database
  DB: D1Database;
  ATTACHMENTS_BUCKET: R2Bucket;
  TURN_NOTIFICATION_QUEUE: Queue;

  // Environment variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  WORKER_URL: string;
  WEB_ORIGIN: string;
  PREVIEW_ORIGIN_ALLOWLIST_REGEX: string;
  CODEX_MIN_VERSION?: string;
  /** "1"/"true" mints a per-session Sprites connector during provisioning. */
  SESSION_CONNECTORS_ENABLED?: string;
  /** "1"/"true" gives the VM the connector gateway base instead of DO_WEBHOOK_TOKEN. Implies minting. */
  SESSION_CONNECTOR_WEBHOOK_CUTOVER?: string;
  /** "1"/"true" routes post-clone git through the connector gateway. Implies minting. */
  SESSION_CONNECTOR_GIT_CUTOVER?: string;

  // Secrets
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  OPENAI_TRANSCRIPTION_MODEL?: string;
  SPRITES_API_KEY: string;
  SPRITES_API_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_SLUG: string;
  TOKEN_ENCRYPTION_KEY: string;
  NATIVE_ACCESS_TOKEN_SIGNING_KEY: string;
  WEBSOCKET_TOKEN_SIGNING_KEY: string;
  VOICE_TOKEN_SIGNING_KEY: string;
  FIREBASE_SERVICE_ACCOUNT_JSON_BASE64: string;
  PORT: string;
  INTEGRATION_SESSION_REQUEST_TOKEN?: string;
}
