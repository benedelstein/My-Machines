## ADDED Requirements

### Requirement: Protected credentials stay outside the Sprite with narrow Git exceptions

The system SHALL keep webhook, upstream GitHub, provider, and environment credentials
out of the Sprite runtime. Fly SHALL authorize the specific Sprite and inject a
connector credential downstream. For refreshable provider OAuth, the connector
credential SHALL authenticate a control-plane inference proxy, and that proxy SHALL
refresh/read the encrypted provider credential and inject it only on the provider
hop. The initial repository clone MAY retain the existing short-lived,
contents-read-only GitHub installation token inside the Sprite to avoid proxying the
bulk clone transfer. While Fly rejects Git smart-HTTP content types, the
connector MAY exchange its identity-bound session credential for a five-minute
opaque Git-proxy capability. This interim capability SHALL be scoped to the
session Git proxy, stored and validated in the session DO, and SHALL NOT contain
or expose a GitHub credential.

#### Scenario: Secret is required for an outbound call

- **WHEN** a Sprite makes a protected credential-bearing outbound call after initial
  clone (webhook, git fetch/push, provider API, or an environment credential's
  upstream)
- **THEN** the upstream credential is injected downstream of the Sprite and is
  never present in the Sprite's env, files, process args, or
  trust-store-readable material
- **AND** the interim Git-proxy capability is held only by the credential-helper
  process and expires within five minutes

#### Scenario: Sprite is compromised

- **WHEN** a process inside the Sprite reads all available Sprite state
- **THEN** it obtains no webhook, GitHub, provider, or environment credential
- **AND** any extracted interim Git-proxy capability expires within five minutes
  and can be revoked immediately from DO SQLite

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
- **AND** all subsequent fetch and push operations use connector-minted
  capabilities against the Worker Git proxy

### Requirement: Environment header credentials via connectors

The system SHALL let an environment define at most one header credential per
upstream hostname, mint an environment-scoped Sprites connector that custodies the
value, route the Sprite's egress to that upstream through the connector via the
transparent proxy, and MUST store only credential metadata (never plaintext) in D1.
Non-header authentication and multiple credentials for one environment/hostname are
out of scope for v1. Endpoint restrictions for class-B connectors are OPTIONAL: a
user MAY authorize the full configured upstream origin or choose narrower paths.

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

#### Scenario: User authorizes the whole upstream origin

- **WHEN** an environment credential is defined without endpoint restrictions
- **THEN** the class-B connector may forward any path on its configured upstream
  origin
- **AND** it cannot forward to a different origin with the injected credential

### Requirement: Class-B connector lifecycle is reconciled and fail-closed

The system SHALL store the gateway connection id and lifecycle status with each
environment credential's non-secret metadata. Create SHALL expose only a verified
active connector. Delete SHALL remove the connector from active lookup before
external revocation and SHALL retain a pending-revocation record until deletion or
verified deny-all is confirmed. Editing the credential value, upstream origin, or
header configuration SHALL create and verify a replacement, atomically swap the
active metadata, and revoke the old connector; it SHALL NOT assume that a
Sprites-custodied value can be updated in place.

#### Scenario: Replacement fails before activation

- **WHEN** a replacement connector cannot be created, scoped, verified, or persisted
- **THEN** the old connector remains authoritative
- **AND** the partial replacement is deleted or retained for reconciliation

#### Scenario: Replacement activates while a Sprite has a stale route

- **WHEN** D1 points to the verified replacement but an existing Sprite still routes
  to the revoked connector id
- **THEN** that Sprite's request fails closed until its non-secret routing entry is
  refreshed or its agent process is restarted
- **AND** the old credential is not kept active solely for continuity

#### Scenario: Environment is deleted

- **WHEN** an environment is deleted
- **THEN** every owned class-B connector is removed from active lookup and externally
  revoked
- **AND** partial failures remain pending and are retried by reconciliation

### Requirement: User-defined connector targets are public HTTPS origins

The system SHALL reject URL userinfo, non-HTTPS origins, literal loopback,
link-local, private, and reserved addresses, and a test URL on another origin.
Before enabling user-defined class-B connectors, the system MUST also verify that
the Sprites connector service prevents DNS names from resolving or rebinding to
prohibited address ranges and prevents credential forwarding across redirects. If
the platform does not enforce those properties, the control plane SHALL enforce
resolved-address and redirect policy itself. A successful connection test
MUST NOT be treated as proof that the target is safe.

#### Scenario: Public hostname resolves to an internal address

- **WHEN** a user supplies a syntactically public hostname that resolves to a
  loopback, link-local, private, metadata, or otherwise reserved destination
- **THEN** connector creation is rejected before the credential can be sent there

#### Scenario: Credential-bearing upstream redirects to another origin

- **WHEN** the configured upstream responds with a redirect to a different origin
- **THEN** the connector does not forward the injected credential to that origin

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

### Requirement: Repository and environment revocation are independent

The system SHALL preserve the existing repository-access guard after the connector
cutover. The gateway-injected session credential SHALL authenticate the calling
session but SHALL NOT replace the per-request repository authorization check for Git
or pull-request operations. Repository access blocking SHALL reject new turns,
subsequent Git operations, and pull-request operations and SHALL stop the active
agent turn, but SHALL NOT by itself delete the Sprite, revoke the session token,
remove `session:` or `env:` labels, or revoke user-owned environment connectors.

Deleting an environment or environment credential SHALL independently make every
affected class-B connector unusable. The system MUST confirm connector deletion or
a deny-all policy before considering revocation complete and SHALL retain
non-secret metadata in a pending-revocation state for reconciliation after a
partial external teardown failure.

#### Scenario: Repository access is removed during a session

- **WHEN** repository access is blocked because user access changes, a repository is
  removed from the GitHub App installation, or the installation is
  suspended/deleted
- **THEN** new turns and every subsequent Git or pull-request operation are rejected
- **AND** the active turn and tracked agent process are stopped
- **AND** the existing checkout, Sprite, labels, session connector/token, and
  environment connectors remain available for access recovery

#### Scenario: Environment credential is deleted

- **WHEN** the user deletes an environment credential
- **THEN** the system stops resolving it for new sessions
- **AND** deletes its class-B connector or applies and verifies a deny-all policy
- **AND** existing labelled Sprites can no longer use that credential
- **AND** unrelated session and environment connectors remain unchanged

#### Scenario: Environment connector revocation partially fails

- **WHEN** external class-B connector teardown cannot be confirmed
- **THEN** the system does not report credential revocation as complete
- **AND** retains only the non-secret metadata needed to retry
- **AND** reconciliation continues until the connector is confirmed unusable

### Requirement: Transparent Sprite-side egress proxy

The system SHALL run a Sprite-local transparent proxy that captures class-B HTTPS
through destination-targeted iptables/nft redirection, MITM-terminates it with a
Sprite-trusted local CA, strips the configured client credential header, and
rewrites requests to the single connector gateway URL assigned to that hostname,
failing closed for unrouted destinations. Class-A traffic SHALL NOT enter the
proxy: webhook, Git capability mint/refresh, and provider CLI traffic are
explicitly configured to the connector gateway. Git smart-HTTP data is
explicitly configured directly to the Worker. Class-C and gateway traffic SHALL
not enter the proxy. The proxy, CA, resolver, and redirect
rules SHALL be installed only for sessions whose environment defines at least one
class-B credential.

#### Scenario: Outbound HTTPS with no proxy configuration

- **WHEN** a Sprite process resolves a class-B hostname and makes an HTTPS request
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

### Requirement: Network egress policy preserves the user's selected mode

The system SHALL preserve the environment's existing `open`, `default`, `custom`,
or `locked` network semantics while making the connector gateway reachable.
Restricted modes SHALL retain their external deny boundary; `open` SHALL remain
allow-all. Protected credential custody and caller-identity binding MUST NOT depend
on direct upstream egress being denied or on the in-Sprite transparent proxy.

#### Scenario: Root agent attempts direct egress

- **WHEN** a process with root in a Sprite using a restricted network mode removes
  the local redirect rules and connects directly to a destination outside that
  mode's allow rules
- **THEN** the network egress policy blocks the connection
- **AND** regardless of whether a destination is direct-allowed, the process obtains
  no connector-custodied credential

#### Scenario: User selects open networking

- **WHEN** the environment's network mode is `open`
- **THEN** direct outbound connections remain allowed
- **AND** direct calls to a connector's upstream receive no connector credential
- **AND** the connector still checks Sprite identity before injecting its credential

#### Scenario: Lockdown applied before the agent runs

- **WHEN** a session is provisioned
- **THEN** the selected final environment policy plus connector-gateway reachability
  is applied before the session agent starts (after any provisioning-time toolchain
  install)

### Requirement: Redirection toolchain is present or the session fails closed

The system SHALL ensure the nft/iptables redirection toolchain is available in the
Sprite (bundled or staged) and MUST fail session creation closed if egress
redirection cannot be established.

#### Scenario: Toolchain missing

- **WHEN** the nft/iptables toolchain cannot be installed or the redirect rules
  cannot be applied
- **THEN** the session does not start rather than running with uncaptured egress

### Requirement: Upstream credentials use caller-identity-bound authorization

The system SHALL authorize each protected upstream credential by the caller's verified Sprite
identity (the connector gateway's access policy), not by possession of a bearer
secret, so that an extracted credential cannot be replayed from anywhere other than
the authorized Sprite. The interim Git-proxy capability is a delegated, short-lived
exception governed by its separate requirement below.

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
connector and token SHALL authorize webhook, Git capability minting, and provider
inference paths; no provider-specific connector SHALL be created. The class-A
connector SHALL set `allowed_endpoints` to the exact session webhook,
Git capability-mint, provider-inference, and
health paths. It MUST NOT authorize unrelated Worker paths.

#### Scenario: Injected secret identifies the session

- **WHEN** a request arrives at
  `/internal/session/:sessionId/chunks` or
  `/internal/session/:sessionId/events`,
  `/internal/session/:sessionId/capabilities/git`, or
  `/internal/session/:sessionId/inference/:provider/...` with the gateway-injected
  token
- **THEN** the Worker resolves the Durable Object from `:sessionId`
- **AND** the Durable Object validates the token from its SQLite
- **AND** no generic `/webhook` or D1 secret-to-session mapping is required

#### Scenario: Session connector is aimed at another Worker path

- **WHEN** the authorized Sprite calls a Worker path outside the class-A
  connector's endpoint allowlist
- **THEN** the gateway rejects it before injecting the session token

### Requirement: Webhook impersonation prevention

The system SHALL accept a session webhook callback only when it arrives through the
sprite-scoped gateway carrying the valid injected Durable Object webhook token for
that session.

#### Scenario: Forged webhook from outside the gateway

- **WHEN** a webhook callback for a session arrives without the valid
  gateway-injected Durable Object webhook token
- **THEN** the Worker rejects it

### Requirement: Git capability minting is caller-identity-bound

Until the connector accepts Git smart-HTTP content types, the system SHALL
authenticate a short-lived Git capability mint through the per-session connector
and route post-clone fetch and push directly to the Worker Git proxy. New sessions
MUST stop accepting the legacy Sprite-held bearer and webhook token on the Git
proxy endpoint, and SHALL retain expiry checks, branch validation, repo
allowlisting, and Worker-custodied GitHub tokens. The initial clone MAY use the
explicit contents-read-only token exception defined above.

#### Scenario: Agent pulls and pushes

- **WHEN** the agent performs git fetch and push
- **THEN** the credential helper mints through the connector and the Git operation
  succeeds directly through the Worker with branch validation still applied

#### Scenario: Extracted Git capability replayed off-Sprite

- **WHEN** an extracted, still-valid Git capability is presented directly to the
  Worker from an off-Sprite caller
- **THEN** the Worker accepts it until its five-minute expiry or immediate DO
  revocation
- **AND** the off-Sprite caller cannot use it to mint or refresh another capability
  because minting requires the connector-injected webhook token

### Requirement: Git smart-HTTP returns to the connector after the gateway fix

The direct-Worker capability path SHALL be temporary. The system MUST NOT switch
Git data back based only on a platform announcement: the live gateway `Accept`
probe SHALL first demonstrate that Git's `application/x-git-*` requests reach the
Worker without `406`. After that verification, newly provisioned sessions SHALL
allowlist their session Git-proxy path on the per-session connector, configure
both post-clone fetch and push remotes to the connector gateway, and accept only
the gateway-injected session credential for those Git requests. New sessions
SHALL stop installing the Git credential helper and minting Git capabilities.
Capability mode MAY remain available only for already-provisioned sessions until
they are migrated or drained.

#### Scenario: Fly's fix is verified

- **WHEN** the live gateway probe confirms Git smart-HTTP `Accept` types reach the
  Worker through the connector
- **THEN** new post-clone Git fetch and push traffic traverses the per-session
  connector
- **AND** the gateway verifies Sprite identity and injects the session credential
- **AND** the Sprite receives neither a Git capability nor an upstream GitHub
  credential

#### Scenario: Fly reports a fix but the probe still fails

- **WHEN** Fly reports the limitation fixed but any Git smart-HTTP probe still
  returns `406` or fails to reach the Worker
- **THEN** the capability path remains active and production Git remotes are not
  switched

### Requirement: REST-backed Custom API connector creation

The system SHALL create Sprites Custom API connectors through
`POST /v1/oauth/connections/custom_api` with their final access policy, verify the
returned gateway connection id and policy through REST, and fail closed if creation
or verification cannot complete.

#### Scenario: Create, scope, and verify

- **WHEN** the system provisions a session connector
- **THEN** it creates the connector with `allow_all: false`, the session Sprite
  label, and the exact allowed endpoints in the initial REST request
- **AND** re-reads the returned gateway connection id and confirms the final policy
  before use

#### Scenario: Create or verification fails

- **WHEN** REST creation or verification fails
- **THEN** the system deletes any partial connector and records a sanitized failure
  without exposing a secret to a Sprite runtime

### Requirement: Connector and secret metadata persistence

The system SHALL persist connector metadata (gateway connection id, org, base URL,
auth method, access-policy summary, status) in D1. The
per-session control-plane token SHALL remain in Durable Object SQLite and SHALL NOT
be duplicated in D1.

#### Scenario: Successful provisioning persists metadata

- **WHEN** provisioning completes
- **THEN** the system stores the gateway connection id and non-secret metadata in D1
- **AND** the Durable Object remains the only persisted owner of its session token

#### Scenario: Session teardown

- **WHEN** a session ends
- **THEN** the system deletes the connector via REST and deletes the Durable
  Object's session token
- **AND** leaves every environment connector policy unchanged

### Requirement: Control-plane-only Sprites API authentication

The system SHALL keep the Sprites API token scoped to the API-server control plane and
MUST NOT expose it or submitted connector credentials to clients, Sprite runtimes,
logs, or D1.

#### Scenario: Sprites API authentication fails

- **WHEN** Sprites rejects the API server's API token
- **THEN** connector provisioning stops with a non-retryable authentication failure
  instead of falling back to raw secret injection

### Requirement: Synchronous fail-closed provisioning

The system SHALL mint and scope the connector, configure class-A clients directly
against the gateway, and — when the environment defines class-B credentials —
install the egress proxy, CA, redirect rules, and routing table, all synchronously
as part of session provisioning, and MUST fail session creation closed if any step
does not complete.

#### Scenario: A provisioning step fails

- **WHEN** any connector or proxy provisioning step fails during session creation
- **THEN** the session does not start and no Sprite runs with a secret in the clear
  or a partially configured protected route
