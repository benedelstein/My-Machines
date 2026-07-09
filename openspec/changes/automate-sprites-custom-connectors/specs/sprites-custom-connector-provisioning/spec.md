## ADDED Requirements

### Requirement: No credential enters the Sprite

The system SHALL keep every protected credential — webhook, git, provider, and
user-defined secrets — out of the Sprite runtime and inject it only at the Sprites
gateway after Fly authorizes the specific Sprite.

#### Scenario: Secret is required for an outbound call

- **WHEN** a Sprite makes any credential-bearing outbound call (webhook, git,
  provider API, or a user-defined secret's upstream)
- **THEN** the credential is injected downstream of the Sprite and is never present
  in the Sprite's env, files, process args, or trust-store-readable material

#### Scenario: Sprite is compromised

- **WHEN** a process inside the Sprite reads all available Sprite state
- **THEN** it obtains no reusable webhook, git, provider, or user credential

### Requirement: Arbitrary user-defined secrets via connectors

The system SHALL let users define arbitrary secrets bound to upstream host(s), mint a
per-secret Sprites connector that custodies the value, route the Sprite's egress to
that upstream through the connector via the transparent proxy, and MUST store only
secret metadata (never plaintext) in D1.

#### Scenario: User adds a secret and the agent uses it

- **WHEN** a user defines a secret for an upstream (e.g. an OpenAI key) and a session
  entitled to it calls that upstream
- **THEN** the transparent proxy routes the call to the per-secret connector, Fly
  injects the real key, and the agent completes the call without ever holding the key

#### Scenario: Secret value custody

- **WHEN** a user-defined secret is created
- **THEN** its value is custodied by Sprites in the connector and D1 stores only
  metadata (name, upstream host(s), connector ids, scope), never the plaintext value

### Requirement: Credential connectors are scoped to entitled Sprites

The system SHALL scope each per-secret connector so only Sprites entitled to that
secret (by server-decided environment entitlement) can use it, and MUST NOT let a
Sprite assert its own entitlement.

#### Scenario: Non-entitled session

- **WHEN** a session not entitled to a secret attempts to reach that secret's upstream
- **THEN** the request has no routing entry and is blocked, and the connector's access
  policy would reject the Sprite regardless

#### Scenario: Entitlement decided server-side

- **WHEN** a session is provisioned
- **THEN** its entitled secrets are determined from its environment server-side, and
  the connector scoping (label or Sprite-id policy) is applied without trusting any
  in-Sprite assertion

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

### Requirement: Network egress lockdown is the hard boundary

The system SHALL apply a Sprites network egress policy that restricts the Sprite to
reaching only the connector gateway (and any provisioning-time exceptions), enforced
outside the VM so in-Sprite root cannot lift it. Security MUST NOT depend on the
in-Sprite transparent proxy.

#### Scenario: Root agent attempts direct egress

- **WHEN** a process with root in the Sprite removes the local redirect rules and
  connects directly to a non-gateway upstream
- **THEN** the network egress policy blocks the connection, and the process obtains
  no credential (none exist in the Sprite)

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

The system SHALL provision one Custom API connector per session, scoped to that
session's Sprite, whose injected credential is a per-session shared secret, and the
Worker SHALL identify the session by that injected secret.

#### Scenario: Injected secret identifies the session

- **WHEN** a request arrives at the Worker with the gateway-injected per-session
  secret
- **THEN** the Worker resolves it to the owning session and treats the call as that
  session's, without relying on a gateway-forwarded Sprite identity

### Requirement: Webhook impersonation prevention

The system SHALL accept a session webhook callback only when it arrives through the
sprite-scoped gateway carrying the valid injected per-session secret for that
session.

#### Scenario: Forged webhook from outside the gateway

- **WHEN** a webhook callback for a session arrives without the valid gateway-
  injected per-session secret
- **THEN** the Worker rejects it

### Requirement: Git access is caller-identity-bound

The system SHALL route git fetch and push through the per-session connector so the
Sprite→Worker call is authorized by verified Sprite identity, MUST stop accepting a
Sprite-held bearer on the git-proxy endpoint, and SHALL retain branch validation,
repo allowlisting, and Worker-custodied GitHub tokens.

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
