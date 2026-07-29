## Why

Session Sprites authenticate their egress with **bearer secrets** handed to the
Sprite (git today; webhook and provider auth on the same footing). A bearer
authorizes by possession, not identity, so the untrusted, root-capable agent can
extract it and replay its authority from anywhere — read/push the private repo from
a laptop, POST fake agent responses into the user's chat log, or reuse a key
off-Sprite. And there is no path for an environment-owned header credential to be
used without entering the Sprite.

The **Sprite secrets proxy** fixes all of this coherently, on three prongs that
share one mechanism:

1. **Caller-identity binding** — Fly verifies the calling Sprite against a
   connector's access policy before injecting the credential, so an extracted
   URL/upstream secret is useless to anyone who is not that Sprite. The interim
   ephemeral Git token remains replayable for its five-minute TTL, but only the
   authorized Sprite can mint or refresh it through the connector.
2. **Protected upstream secrets out of the sandbox** — webhook, GitHub installation,
   provider, and environment credentials are injected downstream. While Fly rejects
   Git smart-HTTP content types, the session connector mints a narrow five-minute
   ephemeral Git-proxy token which is stored and verified by the DO. Provider OAuth stays in
   our encrypted credential store so the control plane can refresh it; the same
   per-session connector used by webhook and git authenticates provider requests to
   that control-plane proxy.
   Initial clone explicitly retains the existing short-lived, contents-read-only
   GitHub token to avoid adding proxy latency to the bulk transfer. The Git
   ephemeral token is temporary: after a live probe confirms Fly forwards Git's media
   types, post-clone Git returns to the per-session connector and the token
   mint/helper are retired after compatibility sessions drain.
3. **Environment header credentials** — a Sprite-local transparent MITM proxy
   routes unmodified egress to one connector per environment and hostname, which
   injects a configured header secret without the agent holding it.

Sprites exposes Custom API connector creation through
`POST /v1/oauth/connections/custom_api`. The endpoint was confirmed by Fly support
and verified live on 2026-07-26 with label and endpoint policies, gateway credential
injection, and off-allowlist denial.

## What Changes

- **Connector abstraction (identity-bound):** every upstream credential-bearing egress goes
  through a Sprites Custom API connector — Fly verifies Sprite identity, injects the
  connector credential, and forwards. Two kinds: an **internal per-session
  connector** (webhook + ephemeral Git token mint + provider inference → our Worker, injects the
  Durable Object's per-session control-plane token) and **environment connectors**
  (environment header credential → external upstream, injects the real
  Sprites-custodied secret, scoped by an immutable environment label). Provider
  OAuth remains in D1 and is selected from the authenticated session's user, not
  from a second connector.
- **Transparent Sprite-side egress proxy (class B only):** local MITM + per-Sprite
  CA + local resolver + destination-targeted iptables/nft REDIRECT, with one
  connector route per class-B protected hostname and fail-closed default. Every
  class-A client is explicitly configured to the gateway URL (vm-agent webhook
  base, ephemeral Git token mint, provider CLI base URL) and never enters the proxy;
  the data plane is installed only for environments with class-B credentials.
  Class-C and gateway traffic never enter the proxy. Toolchain installed at
  provisioning via `sudo apt-get` (base image is fixed).
- **Network egress policy remains user-selected:** add the connector gateway without
  changing the environment's existing `open`, `default`, `custom`, or `locked`
  semantics. Restricted modes retain their external L3/L4 deny boundary; `open`
  deliberately permits direct egress. Connector security does not depend on direct
  egress being denied: bypassing the proxy reaches an upstream without the
  Sprites-custodied credential.
- **`mintConnector` primitive** (REST create with final policy +
  verify/reconcile/delete) in the API server, with the raw Sprites wire contract
  isolated in `@repo/sprites-client`.
- **Worker cutovers:** webhook requires the gateway-injected credential. New-session
  Git stops accepting the legacy bearer; an exact connector endpoint mints a
  five-minute ephemeral token used directly against the Worker Git proxy. Once Fly
  fixes Git content negotiation and the live probe passes, new-session Git
  smart-HTTP switches back to the connector gateway and its injected session
  credential.
- **Provider inference proxy:** provider inference is routed through the existing
  per-session class-A connector to session-scoped Worker routes. The Worker validates
  the injected session credential, resolves the session's user, refreshes the
  existing encrypted OAuth record, replaces client authorization, and streams the
  response.
  Claude uses a Worker plus its documented `ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` gateway interface. Codex uses a custom Responses provider;
  its Worker route delegates only the final ChatGPT hop to one shared, stateless
  native HTTP egress service. Both Node's normal `fetch` and reqwest are proven
  compatible; workerd is the rejected transport. A fresh Sprite completed `gpt-5.4`
  inference through the native transport after it stripped tunnel/proxy headers.
  Neither provider requires transparent MITM or a per-user provider connector. See
  `provider-proxying.md`.
- **Environment header credentials:** D1 metadata, one connector per environment and
  hostname, routing, and fixed `env:<environmentId>` scoping. Sprites custodies the
  values; we never store plaintext. Create, replacement, deletion, partial-failure
  reconciliation, and stale active-session routes have explicit fail-closed
  behavior.
- **Independent authorization lifecycles:** losing repository access continues to
  block turns, Git operations, and pull requests without deleting the Sprite or
  revoking the user's environment authority. Deleting an environment or one of its
  credentials revokes the corresponding class-B connectors independently.
- **Synchronous, fail-closed provisioning**, with teardown that deletes the
  per-session connector/secret and never edits shared class-B policies.

The concept is whole; the build is sequenced in `design.md` "Staging" (S1 webhook →
S2 post-clone git → S3 transparent proxy → S4 provider credential, if compatible →
S5 environment header credentials), each stage a real subset sharing one data
model, connector abstraction, and proxy — none redesigned later.

## Capabilities

### New Capabilities

- `sprites-custom-connector-provisioning`: Programmatically create, scope, and
  reconcile Sprites Custom API connectors and route Sprite egress through them so
  that caller identity is verified and protected credentials are injected outside
  the Sprite, with an explicit read-only initial-clone exception.

### Modified Capabilities

- None yet (webhook and git securing land as cutovers behind flags).

## Impact

- New Sprite-side data plane, installed only for environments with class-B
  credentials: nft/iptables toolchain (installed at provisioning), per-Sprite CA
  across trust stores, local resolver, transparent proxy + routing table +
  dummy-destination redirect rules. Class-A flows (webhook, git, provider CLIs)
  use direct gateway configuration and never depend on it.
- New REST-backed `mintConnector`, run synchronously during provisioning.
- Existing Worker `/internal/session/:sessionId/chunks`,
  `/internal/session/:sessionId/events`, and git-proxy routes receive the
  gateway-injected per-session token; the Durable Object remains webhook authority.
- New D1: `session_connectors` and `environment_connectors` (connector metadata
  only; existing provider credential records remain encrypted in D1).
- Session provisioning becomes synchronous and fail-closed; teardown deletes the
  per-session connector/secret and never mutates environment connector policies.
- Secrets policy: webhook, upstream GitHub, provider, and environment credentials
  become identity-bound and stay downstream of the Sprite. Sprites injects the
  session-control-plane and environment connector credentials; the Worker injects
  refreshable provider OAuth upstream. The interim ephemeral Git token is a narrow,
  five-minute exception while Fly rejects Git content types, with an explicit
  return-to-connector task once the gateway passes the Git `Accept` probe. Initial
  clone keeps its current short-lived, contents-read-only token as an explicit
  exception.
