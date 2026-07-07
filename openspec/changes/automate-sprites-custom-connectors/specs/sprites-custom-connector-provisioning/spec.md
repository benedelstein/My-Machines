## ADDED Requirements

### Requirement: Webhook and git secrets never enter the Sprite

The system SHALL keep the webhook and git credentials out of the Sprite runtime and
inject them only at the Sprites gateway after Fly authorizes the specific Sprite.

#### Scenario: Secret is required for an outbound call

- **WHEN** a Sprite makes a webhook callback or a git operation
- **THEN** the credential is injected downstream of the Sprite and is never present
  in the Sprite's env, files, process args, or trust-store-readable material

#### Scenario: Sprite is compromised

- **WHEN** a process inside the Sprite reads all available Sprite state
- **THEN** it obtains no reusable webhook or git credential

### Requirement: Transparent Sprite-side egress proxy

The system SHALL run a Sprite-local transparent proxy that captures outbound HTTPS
via iptables/nft redirection, MITM-terminates it with a Sprite-trusted local CA,
strips any client authorization, and rewrites requests to a connector gateway URL
according to a destination routing table, failing closed for unrouted destinations.

#### Scenario: Outbound HTTPS with no proxy configuration

- **WHEN** a Sprite process makes an HTTPS request with no proxy environment set
- **THEN** the request is redirected to the local proxy, MITM-terminated with the
  Sprite-trusted local CA, its client authorization stripped, and rewritten to the
  configured connector gateway URL

#### Scenario: Destination has no route

- **WHEN** a Sprite requests a destination absent from the routing table
- **THEN** the proxy blocks it and does not forward it with an injected secret

#### Scenario: Gateway calls are not intercepted

- **WHEN** the proxy makes its own upstream call to the Sprites gateway
- **THEN** that call is excluded from redirection so it is not intercepted

### Requirement: Redirection toolchain is present or the session fails closed

The system SHALL ensure the nft/iptables redirection toolchain is available in the
Sprite (bundled or staged) and MUST fail session creation closed if egress
redirection cannot be established.

#### Scenario: Toolchain missing

- **WHEN** the nft/iptables toolchain cannot be installed or the redirect rules
  cannot be applied
- **THEN** the session does not start rather than running with uncaptured egress

### Requirement: Per-session connector carries session identity

The system SHALL provision one Custom API connector per session, scoped to that
session's Sprite, whose injected credential is a per-session shared secret, and the
Worker SHALL identify the session by that injected secret.

#### Scenario: Injected secret identifies the session

- **WHEN** a request arrives at the Worker with the gateway-injected per-session
  secret
- **THEN** the Worker resolves it to the owning session and treats the call as that
  session's, without relying on a gateway-forwarded Sprite identity

#### Scenario: Another Sprite attempts to use the connector

- **WHEN** a Sprite other than the scoped session Sprite tries to use the connector
- **THEN** the gateway access policy denies it

### Requirement: Webhook impersonation prevention

The system SHALL accept a session webhook callback only when it arrives through the
sprite-scoped gateway carrying the valid injected per-session secret for that
session.

#### Scenario: Forged webhook from outside the gateway

- **WHEN** a webhook callback for a session arrives without the valid gateway-
  injected per-session secret
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

### Requirement: Dashboard-backed connector creation with REST scoping

The system SHALL create Sprites Custom API connectors through the dashboard flow (no
public REST create exists), scope them via REST, verify the policy is not
`allow_all`, and fail closed if creation or scoping cannot complete.

#### Scenario: Create, scope, and verify

- **WHEN** the system provisions a session connector
- **THEN** it creates the connector via the dashboard flow, scopes it via
  `PATCH /v1/oauth/connections/{id}` to the session Sprite, and confirms
  `allow_all` is disabled before use

#### Scenario: Create or scope fails

- **WHEN** the dashboard flow or the REST scope/verify step fails
- **THEN** the system deletes any partial connector and records a sanitized failure
  without exposing a secret to a Sprite runtime

### Requirement: Connector and secret metadata persistence

The system SHALL persist connector metadata (gateway connection id and dashboard
detail id, org, base URL, auth method, access-policy summary, status) in D1 and
SHALL store the per-session shared secret only encrypted, deleting it on session
teardown.

#### Scenario: Successful provisioning persists metadata

- **WHEN** provisioning completes
- **THEN** the system stores both connector ids and non-secret metadata and stores
  the per-session secret encrypted at rest

#### Scenario: Session teardown

- **WHEN** a session ends
- **THEN** the system deletes the connector via REST and deletes the stored secret

### Requirement: Provisioner-only dashboard authentication

The system SHALL keep Sprites dashboard authentication material scoped to the
connector provisioner and MUST NOT expose dashboard cookies, storage state, CSRF
tokens, or session payloads to clients, Sprite runtimes, logs, or D1.

#### Scenario: Dashboard auth expires

- **WHEN** the provisioner dashboard session is expired or rejected
- **THEN** connector provisioning stops with a reauthentication-required status
  instead of falling back to raw secret injection

### Requirement: Synchronous fail-closed provisioning

The system SHALL mint and scope the connector and install the egress proxy, CA,
redirect rules, and routing table synchronously as part of session provisioning, and
MUST fail session creation closed if any step does not complete.

#### Scenario: A provisioning step fails

- **WHEN** any connector or proxy provisioning step fails during session creation
- **THEN** the session does not start and no Sprite runs with a secret in the clear
  or an unsecured egress path
