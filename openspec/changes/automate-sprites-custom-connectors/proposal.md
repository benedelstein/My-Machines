## Why

Sprites Custom API connectors are the right primitive for keeping user and
Cloude control-plane secrets out of Sprite runtimes, but Sprites does not expose
Custom API connector creation through the public REST API today. Cloude needs a
controlled dashboard-backed provisioning path so sessions can receive
connector-gated authority without embedding extractable webhook, git, or API
secrets in the Sprite.

## What Changes

- Add an internal Sprites dashboard automation service that can create Custom API
  connectors by driving the Phoenix LiveView dashboard flow. This flow is proven
  end to end by a live browser-automation spike (2026-07-06); see `design.md`.
- Expose the dashboard automation as an on-demand `mintConnector` primitive — the
  "create connector" API route Sprites never shipped — that creates, scopes, and
  verifies one connector per call.
- Mint a per-session Sprite→Worker "proxy URL": call `mintConnector` at session
  creation with the Cloude Worker callback endpoint as upstream and a per-session
  webhook token as the secret, scoped to that session's Sprite, so a Sprite calls
  back through a connector-gated gateway URL and the callback secret never enters
  the Sprite runtime.
- Store Sprites connector metadata in D1, including the Sprites connection id,
  intended upstream, access-policy scope, environment links, provisioning state,
  and last observed dashboard shape/version.
- Keep raw user API secrets in Sprites connector custody after creation; Cloude
  should not store recoverable plaintext user API secrets.
- Support connector access policies scoped by Sprite id or Sprite tag so dynamic
  session Sprites can use only the connectors provisioned for them.
- Add reconciliation and drift detection for dashboard-created connectors using
  the supported REST API surfaces where available.
- Add a guarded fallback plan for when dashboard automation breaks, including
  clear degraded behavior instead of silently falling back to raw env vars.

## Capabilities

### New Capabilities

- `sprites-custom-connector-provisioning`: Programmatically create, track, and
  reconcile Sprites Custom API connectors through a dashboard-backed automation
  flow while keeping connector secrets out of Sprite runtimes.

### Modified Capabilities

- None.

## Impact

- New api-server integration for Sprites dashboard automation and connector
  metadata persistence.
- New D1 tables for connector metadata, environment links, and provisioning
  attempts.
- Session provisioning changes to attach Sprite ids/labels to the correct Sprites
  connector access policies, and to hand session Sprites a gateway connection-id
  URL for Sprite→Worker callbacks instead of an embedded webhook secret.
- New Worker session-callback health endpoint (used as the connector test URL)
  and per-session webhook-secret validation.
- New provisioner service boundary and Worker→provisioner RPC/job call that backs
  the `mintConnector` primitive (a Worker cannot drive a browser).
- Secrets handling policy changes for user-provided API keys and Cloude internal
  webhook/git authority, including keeping the per-session callback secret in
  Sprites custody.
