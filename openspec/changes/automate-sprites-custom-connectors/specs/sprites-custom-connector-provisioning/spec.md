## ADDED Requirements

### Requirement: Protected credentials stay outside the Sprite with a read-only clone exception

The system SHALL keep webhook, post-clone git, provider, and environment credentials
out of the Sprite runtime. Fly SHALL authorize the specific Sprite and inject a
connector credential downstream. For refreshable provider OAuth, the connector
credential SHALL authenticate a control-plane inference proxy, and that proxy SHALL
refresh/read the encrypted provider credential and inject it only on the provider
hop. The initial repository clone MAY retain the existing short-lived,
contents-read-only GitHub installation token inside the Sprite to avoid proxying the
bulk clone transfer.

#### Scenario: Secret is required for an outbound call

- **WHEN** a Sprite makes a protected credential-bearing outbound call after initial
  clone (webhook, git fetch/push, provider API, or an environment credential's
  upstream)
- **THEN** the credential is injected downstream of the Sprite and is never present
  in the Sprite's env, files, process args, or trust-store-readable material

#### Scenario: Sprite is compromised

- **WHEN** a process inside the Sprite reads all available Sprite state
- **THEN** it obtains no reusable webhook, post-clone git, provider, or environment
  credential

### Requirement: Provider OAuth is injected through the session-scoped control plane

For a compatible provider CLI, the system SHALL route inference through the
session's existing class-A connector and a provider-specific path under
`/internal/session/:sessionId/inference`. The Worker SHALL validate the
connector-injected session credential, resolve the provider credential from the
authenticated session's user, refresh the encrypted OAuth record, replace client
authorization, preserve provider protocol headers and streaming, and forward the
response without exposing provider access or refresh tokens to the Sprite. Provider
connection changes MUST NOT create or mutate a separate Sprites connector. Claude
MAY egress directly from the Worker. For Codex, the Worker SHALL delegate only the
final ChatGPT hop to a shared stateless native HTTP service.

#### Scenario: Claude runs with non-provider local credentials

- **WHEN** an entitled Sprite runs Claude Code with `ANTHROPIC_BASE_URL` set to the
  Claude path under its session connector gateway and `ANTHROPIC_AUTH_TOKEN` set to
  a literal non-secret placeholder
- **THEN** Claude skips interactive login and sends inference to the connector
- **AND** Fly authorizes the Sprite and injects its session control-plane credential
  that the Worker can unambiguously distinguish from the untrusted placeholder
- **AND** the Worker injects the current D1-custodied Claude OAuth access token
- **AND** the Worker adds the OAuth beta capability and the streamed inference
  completes

#### Scenario: Codex runs through native control-plane egress

- **WHEN** an entitled Sprite runs Codex with a custom Responses provider whose base
  URL is the Codex path under its session connector gateway and whose bearer is a
  non-provider placeholder
- **THEN** Fly authorizes the Sprite and injects its session control-plane credential
- **AND** the Worker validates the session, refreshes the current D1-custodied OAuth
  record, and delegates only the final ChatGPT request to the native egress shim
- **AND** the native shim injects the access token and `ChatGPT-Account-ID`
- **AND** it removes inbound `cf-*`, forwarding, proxy-loop, cookie, and competing
  credential headers before ChatGPT egress
- **AND** the streamed inference completes without any provider OAuth credential
  entering the Sprite

#### Scenario: Placeholder is extracted

- **WHEN** a process in the Sprite reads `ANTHROPIC_AUTH_TOKEN`
- **THEN** it obtains only a fixed placeholder that neither the connector nor Worker
  accepts as authority

#### Scenario: Another session uses the same provider account

- **WHEN** another session for the same user starts
- **THEN** the provisioner mints only that session's normal class-A connector
- **AND** the Worker resolves the same encrypted provider account after validating
  the new session
- **AND** no provider-specific connector is created or edited

#### Scenario: Provider authorization is replayed

- **WHEN** an off-Sprite caller or a Sprite without the session label attempts to use
  the session connector's inference path
- **THEN** Fly rejects it before the session credential or provider OAuth can be used

#### Scenario: Initial private repository clone

- **WHEN** provisioning clones the repository for the first time
- **THEN** it MAY execute the clone inside the Sprite with a short-lived,
  contents-read-only installation token
- **AND** that token cannot push
- **AND** all subsequent fetch and push operations use the class-A connector

### Requirement: Environment header credentials via connectors

The system SHALL let an environment define at most one header credential per
upstream hostname, mint an environment-scoped Sprites connector that custodies the
value, route the Sprite's egress to that upstream through the connector via the
transparent proxy, and MUST store only credential metadata (never plaintext) in D1.
Non-header authentication and multiple credentials for one environment/hostname are
out of scope for v1.

#### Scenario: User adds a secret and the agent uses it

- **WHEN** an environment defines a header credential for an upstream and a session
  in that environment calls that upstream
- **THEN** the transparent proxy routes the call to the environment connector, Fly
  injects the real key, and the agent completes the call without ever holding the key

#### Scenario: Secret value custody

- **WHEN** an environment header credential is created
- **THEN** its value is custodied by Sprites in the connector and D1 stores only
  metadata (environment, name, upstream hostname, header configuration, connector
  ids, scope), never the plaintext value

### Requirement: Credential connectors are scoped to entitled Sprites

The system SHALL mint each class-B connector once with
`sprite_labels: [env:<environmentId>]`, SHALL link sessions by placing that
environment label on their Sprites through the Sprites API, MUST NOT let a Sprite
assert its own entitlement, and MUST NOT edit the connector policy during session
create or teardown.

#### Scenario: Non-entitled session

- **WHEN** a session from another environment attempts to reach the credential's upstream
- **THEN** the request has no routing entry and is blocked, and the connector's access
  policy would reject the Sprite regardless

#### Scenario: Entitlement decided server-side

- **WHEN** a session is provisioned
- **THEN** the server creates it with `session:<sessionId>` and
  `env:<environmentId>` labels before connector use or agent start
- **AND** existing environment connector policies remain unchanged

#### Scenario: Session teardown

- **WHEN** a session ends
- **THEN** the system deletes its class-A connector and Sprite
- **AND** does not remove or add anything in a class-B connector policy

### Requirement: Transparent Sprite-side egress proxy

The system SHALL run a Sprite-local transparent proxy that captures class-A/B HTTPS
through destination-targeted iptables/nft redirection, MITM-terminates it with a
Sprite-trusted local CA, strips the configured client credential header, and
rewrites requests to the single connector gateway URL assigned to that hostname,
failing closed for unrouted destinations. Class-C and gateway traffic SHALL not
enter the proxy.

#### Scenario: Outbound HTTPS with no proxy configuration

- **WHEN** a Sprite process resolves a class-A/B hostname and makes an HTTPS request
  with no proxy environment set
- **THEN** the local resolver returns the reserved dummy destination
- **AND** nft/iptables redirects that destination's TCP/443 traffic to the local
  proxy
- **AND** the proxy MITM-terminates it, strips the configured credential header, and
  rewrites it to the configured connector gateway URL

#### Scenario: Destination has no route

- **WHEN** a Sprite requests a destination absent from the routing table
- **THEN** the proxy blocks it and does not forward it with an injected secret

#### Scenario: Class-C and gateway calls are not intercepted

- **WHEN** a process accesses a class-C hostname or the proxy accesses the Sprites
  gateway
- **THEN** DNS returns a real destination rather than the dummy destination
- **AND** the targeted redirect does not intercept the connection

#### Scenario: Unsupported protocol

- **WHEN** a request requires HTTP/2-only operation, gRPC, HTTP/3, an alternate
  port, non-header authentication, or multiple credentials for one hostname
- **THEN** v1 rejects or documents the request as unsupported rather than silently
  bypassing connector enforcement

### Requirement: Network egress lockdown is the hard boundary

The system SHALL apply a Sprites network egress policy that restricts the Sprite to
reaching only the connector gateway (and any provisioning-time exceptions), enforced
outside the VM so in-Sprite root cannot lift it. Security MUST NOT depend on the
in-Sprite transparent proxy.

#### Scenario: Root agent attempts direct egress

- **WHEN** a process with root in the Sprite removes the local redirect rules and
  connects directly to a non-gateway upstream
- **THEN** the network egress policy blocks the connection, and the process obtains
  no protected runtime credential (the initial clone token is no longer present)

#### Scenario: Lockdown applied before the agent runs

- **WHEN** a session is provisioned
- **THEN** the egress policy is tightened to gateway-only before the session agent
  starts (after any provisioning-time toolchain install)

### Requirement: Redirection toolchain is present or the session fails closed

The system SHALL ensure the nft/iptables redirection toolchain is available in the
Sprite (bundled or staged) and MUST fail session creation closed if egress
redirection cannot be established.

#### Scenario: Toolchain missing

- **WHEN** the nft/iptables toolchain cannot be installed or the redirect rules
  cannot be applied
- **THEN** the session does not start rather than running with uncaptured egress

### Requirement: Caller-identity-bound authorization (no off-Sprite replay)

The system SHALL authorize each protected credential by the caller's verified Sprite
identity (the connector gateway's access policy), not by possession of a bearer
secret, so that an extracted credential cannot be replayed from anywhere other than
the authorized Sprite.

#### Scenario: Extracted credential replayed from off-Sprite

- **WHEN** a caller that is not the authorized session Sprite (e.g. a laptop, or a
  Sprite in another org) presents the connector URL or an extracted secret
- **THEN** the request is rejected because the gateway access policy verifies Sprite
  identity before injecting the credential

#### Scenario: Another Sprite attempts to use the connector

- **WHEN** a Sprite other than the scoped session Sprite tries to use the connector
- **THEN** the gateway access policy denies it

### Requirement: Per-session connector carries session identity

The system SHALL create the Sprite with a unique session label and then provision
one Custom API connector scoped to that label. The connector SHALL inject the
existing Durable Object session token (currently stored as `webhook_token`). The
Worker SHALL resolve the Durable Object from each allowlisted route's `:sessionId`,
and the Durable Object SHALL validate the injected token from its SQLite. The same
connector and token SHALL authorize webhook, post-clone git, and provider inference
paths; no provider-specific connector SHALL be created.

#### Scenario: Injected secret identifies the session

- **WHEN** a request arrives at
  `/internal/session/:sessionId/chunks` or
  `/internal/session/:sessionId/events`,
  `/git-proxy/:sessionId/...`, or
  `/internal/session/:sessionId/inference/:provider/...` with the gateway-injected
  token
- **THEN** the Worker resolves the Durable Object from `:sessionId`
- **AND** the Durable Object validates the token from its SQLite
- **AND** no generic `/webhook` or D1 secret-to-session mapping is required

### Requirement: Webhook impersonation prevention

The system SHALL accept a session webhook callback only when it arrives through the
sprite-scoped gateway carrying the valid injected Durable Object webhook token for
that session.

#### Scenario: Forged webhook from outside the gateway

- **WHEN** a webhook callback for a session arrives without the valid
  gateway-injected Durable Object webhook token
- **THEN** the Worker rejects it

### Requirement: Git access is caller-identity-bound

The system SHALL route post-clone git fetch and push through the per-session connector so the
Sprite→Worker call is authorized by verified Sprite identity, MUST stop accepting a
Sprite-held bearer on the git-proxy endpoint, and SHALL retain branch validation,
repo allowlisting, and Worker-custodied GitHub tokens. The initial clone MAY use the
explicit contents-read-only token exception defined above.

#### Scenario: Agent pulls and pushes

- **WHEN** the agent performs git fetch and push
- **THEN** the operations succeed through the connector with the GitHub credential
  injected downstream and branch validation still applied

#### Scenario: Extracted git secret replayed off-Sprite

- **WHEN** an extracted git-proxy secret is presented to the Worker from a caller
  that did not pass through this session's sprite-scoped gateway
- **THEN** the Worker rejects it

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
detail id, org, base URL, auth method, access-policy summary, status) in D1. The
per-session control-plane token SHALL remain in Durable Object SQLite and SHALL NOT
be duplicated in D1.

#### Scenario: Successful provisioning persists metadata

- **WHEN** provisioning completes
- **THEN** the system stores both connector ids and non-secret metadata in D1
- **AND** the Durable Object remains the only persisted owner of its session token

#### Scenario: Session teardown

- **WHEN** a session ends
- **THEN** the system deletes the connector via REST and deletes the Durable
  Object's session token
- **AND** leaves every environment connector policy unchanged

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
