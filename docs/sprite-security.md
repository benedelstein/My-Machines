# Sprite Security & Authentication

How a session's Sprite VM is isolated, how its outbound traffic is classified,
and how each flow authenticates. **Roughly half of this architecture is
implemented today**; each section below is marked. The full plan and decision
history live in `openspec/changes/automate-sprites-custom-connectors/`.

![Sprite security architecture](assets/sprite-security-architecture.png)

## Trust model

- **In-VM root is untrusted.** The agent process runs arbitrary code, so
  anything readable on the Sprite — files, env vars, process memory — is
  extractable. Connector-backed session credentials therefore never rest on the
  VM, and planned provider inference proxying removes provider OAuth credentials
  from the VM path. Until that phase lands, provider OAuth follows the current
  delivery path described below.
- **Identity comes from the platform, not the VM.** Sprites carry
  `session:<sessionId>` labels that in-VM root cannot change. Fly's connector
  gateway verifies the calling Sprite's labels before injecting any credential,
  so possession of a URL is never authority by itself.
- **Credentials are injected at boundaries the Sprite can't cross.** The
  connector gateway injects session credentials after the identity check; the
  Worker injects GitHub installation tokens after validating the session
  credential. Planned provider inference proxying applies the same shape to
  Claude/Codex provider OAuth; the current provider runtime still receives
  provider credential files/env vars on the Sprite.

## Credential classes

Every outbound flow is classified and routed exactly one way
(see `design.md` in the openspec change for the full rationale):

| Class | Meaning | Examples | Path | Status |
|---|---|---|---|---|
| A | Credential → our control plane | webhooks, Git token mint, Claude/Codex inference | Sprite → per-session connector → Worker; Worker injects/delegates the upstream credential | Webhooks + Git mint **implemented**; inference **planned** (S4) |
| B | Credential → external upstream | environment header secrets (e.g. an API key for `api.stripe.com`) | Sprite → transparent egress proxy → environment connector → upstream | **Planned** (S3/S5) |
| C | Direct egress allowed by environment | npm, pypi, user-allowlisted hosts | Direct, no connector credential, per `open`/`default`/`custom`/`locked` | **Implemented** |
| D | Direct egress denied by environment | hosts outside a restricted mode's rules | Denied by network policy (empty under `open`) | **Implemented** |

Class A never enters the transparent proxy: implemented class-A clients (the
webhook base URL and Git credential helper), and the planned provider CLI base
URLs, are written by our provisioning code so they point straight at the
connector gateway. The proxy exists only for class B, where arbitrary
unmodified tools address the real hostname and can't be reconfigured.

## Implemented today

- **Per-session connector (class A).** Minted as a blocking setup task; scoped
  to the Sprite's `session:<sessionId>` label; injects the DO's `webhook_token`;
  endpoint allowlist pins the two webhook routes, the ephemeral Git token mint
  route, and `/health`. Deleted (with reconciliation) at teardown. See
  `docs/sprite-connectors.md`.
- **Webhook events (class A).** The vm-agent sends chunks/events through the
  connector gateway; the gateway-injected token is validated by the session's
  Durable Object, which persists to SQLite and forwards to clients.
- **Git (class A mint + direct data plane).** The initial clone injects a
  short-lived, read-only, repo-scoped installation token that never persists.
  Afterwards, a repo-local credential helper mints five-minute ephemeral Git
  tokens through the connector gateway and Git presents them (HTTP Basic)
  directly to the Worker Git proxy, which validates the token, repository, and
  branch policy in the DO, then forwards to GitHub with an installation token.
  Direct-to-Worker is an interim shape forced by the gateway's `Accept`
  allowlist; the exit plan (S2.4) returns Git data to the connector. See
  `docs/github-app-auth.md` and `docs/sprite-connectors.md`.
- **Network policy (classes C/D).** L3/L4 allow/deny built per environment
  network mode; the Worker hostname and connector gateway hostname are always
  reachable; denied hosts are blocked at the policy layer, not the proxy.
- **Teardown revocation.** Session deletion revokes ephemeral Git tokens and
  the webhook token before slow external cleanup, then deletes the connector.
- **Encrypted credential storage.** D1 holds session metadata, GitHub
  installations, and encrypted GitHub user credentials; session secrets
  (webhook token, ephemeral Git tokens) live in the DO's SQLite.
- **Current provider OAuth delivery.** Until S4 lands,
  `SpriteAgentProcessManager` resolves provider credentials with
  `getProviderCredentialAdapter(...)`, writes Claude credentials to
  `/home/sprite/.claude/.credentials.json` or Codex credentials to
  `/home/sprite/.codex/auth.json` with `writeCredentialFiles(...)`, and passes
  matching `CLAUDE_CREDENTIALS_JSON` or `CODEX_AUTH_JSON` env vars into the
  vm-agent process.

## Planned

- **Provider inference through the control plane (S4).** Claude/Codex CLIs get
  custom base URLs pointing at
  `/internal/session/:sessionId/inference/{claude|codex}` via the session
  connector. The Worker validates the gateway-injected session token, decrypts
  the user's provider OAuth record from D1, replaces the client authorization,
  and streams from the provider. Codex egress needs a small native shim
  (workerd's egress headers break ChatGPT), so the Worker delegates only the
  rebuilt final request to it. Until this lands, provider credentials follow
  their current delivery path.
- **Environment header credentials (class B, S3/S5).** A Sprite-local resolver
  maps protected hostnames to a reserved IP; a transparent MITM egress proxy
  (per-Sprite CA, per-host leaf certs) strips whatever placeholder credential
  the tool sent and routes to a per-hostname environment connector, which
  injects the real Sprites-custodied secret and forwards to the upstream.
  Environment connectors (`env:<environmentId>` label scope) and their D1
  metadata are part of this phase.
- **Git data back through the connector (S2.4).** Once Fly's gateway forwards
  Git's `application/x-git-*` Accept types, post-clone fetch/push move to the
  gateway with the injected session token, and ephemeral Git token issuance
  stops for new sessions.

## Known limits (accepted, documented)

- An extracted, still-valid ephemeral Git token is replayable off-Sprite for at
  most its five-minute TTL. Connector identity prevents off-Sprite mint/refresh,
  not replay inside the TTL; teardown revokes immediately.
- Sessions provisioned before connectors keep their legacy credential paths
  (Sprite-held webhook token, `git_proxy_secret` bearer) until they drain.

## Related docs

- `docs/sprite-connectors.md` — connector mint/verify/delete mechanics and the
  gateway `Accept` limitation.
- `docs/github-app-auth.md` — GitHub App tokens, clone auth, and the Git proxy.
- `openspec/changes/automate-sprites-custom-connectors/design.md` — full design,
  threat prongs, and sequence diagrams.
