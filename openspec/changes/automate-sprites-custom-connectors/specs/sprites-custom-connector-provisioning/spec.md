## ADDED Requirements

### Requirement: Secrets never enter the Sprite runtime

The system SHALL keep webhook, git, and user-supplied credentials out of the Sprite
runtime and inject them only at a gateway/Worker after the caller is proven to be
the authorized Sprite.

#### Scenario: Secret is required for an outbound call

- **WHEN** a Sprite makes an outbound request that needs a credential (webhook,
  git, or a user API)
- **THEN** the credential is injected downstream of the Sprite and is never present
  in the Sprite's env, files, process args, or trust-store-readable material

#### Scenario: Sprite is compromised

- **WHEN** a process inside the Sprite reads all available Sprite state
- **THEN** it obtains no reusable credential for webhook, git, or user APIs

### Requirement: Transparent Sprite-side egress proxy

The system SHALL run a Sprite-local transparent proxy that captures outbound HTTPS,
strips any client-supplied authorization, and rewrites requests to a connector
gateway according to a destination routing table, failing closed for unrouted
destinations.

#### Scenario: Outbound HTTPS with no proxy configuration

- **WHEN** a Sprite process makes an HTTPS request without proxy environment
  variables
- **THEN** the request is redirected to the local proxy, MITM-terminated with the
  Sprite-trusted local CA, and rewritten to the configured gateway URL

#### Scenario: Destination has no route

- **WHEN** a Sprite requests a destination not present in the routing table
- **THEN** the proxy blocks it (or passes it through unmodified per policy) and
  never forwards it with an injected secret

### Requirement: Worker egress secret custody and injection

The system SHALL provide a Worker egress route that validates the gateway-injected
shared secret, resolves the calling Sprite to its session/environment, matches the
requested destination to a custodied secret linked to that environment, and injects
the real credential.

#### Scenario: Authorized egress call

- **WHEN** the egress route receives a request carrying the valid gateway-injected
  shared secret for a resolvable Sprite/session, targeting a destination with a
  linked custodied secret
- **THEN** the Worker decrypts that secret, injects it, and forwards to the upstream

#### Scenario: Missing or invalid shared secret

- **WHEN** a request reaches the egress route without the valid gateway-injected
  shared secret
- **THEN** the Worker rejects it and injects no credential

### Requirement: Egress SSRF protection

The system SHALL restrict Worker egress forwarding to permitted destinations and
MUST block private, link-local, and cloud-metadata address ranges and internal
redirects.

#### Scenario: Sprite requests an internal or metadata address

- **WHEN** an egress request targets a private/link-local/metadata address or would
  redirect to an internal host
- **THEN** the Worker blocks the request and does not forward it

### Requirement: Webhook impersonation prevention

The system SHALL accept a session webhook callback only when it arrives via the
gateway with a valid shared secret and a Sprite identity that maps to that session.

#### Scenario: Forged webhook from outside the gateway

- **WHEN** a webhook callback for a session arrives without passing through the
  sprite-scoped gateway with the valid shared secret
- **THEN** the Worker rejects it

### Requirement: Git access without extractable credentials

The system SHALL route git fetch and push through the egress path with the git
credential injected at the Worker, retain branch validation, and enable pull and
push without leaving an extractable token in the Sprite.

#### Scenario: Agent pulls and pushes

- **WHEN** the agent performs git fetch and push
- **THEN** the operations succeed through the egress path with the credential
  injected downstream, branch validation still applied, and no reusable git token
  present in the Sprite

### Requirement: Dashboard-backed Custom API connector creation

The system SHALL create Sprites Custom API connectors through the dashboard flow
(no public REST create exists) and scope them via REST, failing closed if creation
or scoping cannot complete.

#### Scenario: Create and scope the internal connector

- **WHEN** the system provisions the internal egress connector
- **THEN** it creates the connector via the dashboard flow and scopes it via
  `PATCH /v1/oauth/connections/{id}` so only labeled session Sprites may use it

#### Scenario: Create or scope fails

- **WHEN** the dashboard flow or the REST scope/verify step fails
- **THEN** the system deletes any partial connector and records a sanitized failure
  without exposing a secret to a Sprite runtime

### Requirement: Connector access scoped to session Sprites

The system SHALL scope each provisioned connector by Sprite id or Sprite label and
MUST verify the policy is not `allow_all` before marking it ready.

#### Scenario: Scope verified before use

- **WHEN** a connector finishes provisioning
- **THEN** the system confirms the access policy limits use to the intended Sprite
  id or label and that `allow_all` is disabled

### Requirement: Connector and secret metadata persistence

The system SHALL persist connector metadata (gateway connection id and dashboard
detail id, org, base URL, auth method, access-policy summary, status) and user
secret metadata (name, allowed hosts, linked environments) in D1, storing secret
values only encrypted.

#### Scenario: Successful provisioning persists metadata

- **WHEN** provisioning completes
- **THEN** the system stores both connector ids and non-secret metadata, and stores
  any secret value encrypted at rest

### Requirement: Provisioner-only dashboard authentication

The system SHALL keep Sprites dashboard authentication material scoped to the
connector provisioner and MUST NOT expose dashboard cookies, storage state, CSRF
tokens, or session payloads to clients, Sprite runtimes, logs, or D1.

#### Scenario: Dashboard auth expires

- **WHEN** the provisioner dashboard session is expired or rejected
- **THEN** connector provisioning stops with a reauthentication-required status
  instead of falling back to raw secret injection

### Requirement: Synchronous fail-closed provisioning

The system SHALL install the egress proxy, CA, redirect rules, routing table, and
per-session secrets synchronously as part of session provisioning, and MUST fail
session creation closed if any step does not complete.

#### Scenario: A provisioning step fails

- **WHEN** any secrets-proxy provisioning step fails during session creation
- **THEN** the session does not start and no Sprite runs with secrets in the clear
  or an unsecured egress path
