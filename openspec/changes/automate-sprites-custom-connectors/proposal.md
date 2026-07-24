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
   URL/secret is useless to anyone who is not that Sprite.
2. **Protected secrets out of the sandbox** — webhook, post-clone git, provider,
   and environment credentials are injected downstream. Provider OAuth stays in
   our encrypted credential store so the control plane can refresh it; the same
   per-session connector used by webhook and git authenticates provider requests to
   that control-plane proxy.
   Initial clone explicitly retains the existing short-lived, contents-read-only
   GitHub token to avoid adding proxy latency to the bulk transfer.
3. **Environment header credentials** — a Sprite-local transparent MITM proxy
   routes unmodified egress to one connector per environment and hostname, which
   injects a configured header secret without the agent holding it.

Sprites exposes connector creation only through the dashboard, not the public REST
API, so automating that dashboard flow is part of the work.

## What Changes

- **Connector abstraction (identity-bound):** every credential-bearing egress goes
  through a Sprites Custom API connector — Fly verifies Sprite identity, injects the
  connector credential, and forwards. Two kinds: an **internal per-session
  connector** (webhook + git + provider inference → our Worker, injects the
  Durable Object's per-session control-plane token) and **environment connectors**
  (environment header credential → external upstream, injects the real
  Sprites-custodied secret, scoped by an immutable environment label). Provider
  OAuth remains in D1 and is selected from the authenticated session's user, not
  from a second connector.
- **Transparent Sprite-side egress proxy:** local MITM + per-Sprite CA + local
  resolver + destination-targeted iptables/nft REDIRECT, with one connector route
  per class-A/B protected hostname and fail-closed default. Configurable provider
  CLIs use the class-A connector gateway directly with a session/provider path
  prefix. Class-C and gateway traffic never enter the proxy. Toolchain installed at
  provisioning via `sudo apt-get` (base image is fixed).
- **Network egress policy as the hard boundary:** gateway + non-secret allowlist +
  deny-all, enforced outside the VM at L3/L4 (verified). Class-A/B credential hosts
  are forced through the proxy, not allowlisted.
- **`mintConnector` primitive** (browser create + REST scope/verify/delete) via
  Cloudflare Browser Rendering (Fly.io Machine fallback if latency demands).
- **Worker cutovers:** webhook and git endpoints stop accepting Sprite-held bearers
  and require the gateway-injected credential; retire the old bearers behind flags.
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
  values; we never store plaintext.
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

- New Sprite-side data plane: nft/iptables toolchain (installed at provisioning),
  per-Sprite CA across trust stores, local resolver, transparent proxy + routing
  table + dummy-destination redirect rules.
- New `mintConnector` via Cloudflare Browser Rendering, run synchronously during
  provisioning.
- Existing Worker `/internal/session/:sessionId/chunks`,
  `/internal/session/:sessionId/events`, and git-proxy routes receive the
  gateway-injected per-session token; the Durable Object remains webhook authority.
- New D1: `session_connectors` and `environment_connectors` (connector metadata
  only; existing provider credential records remain encrypted in D1).
- Session provisioning becomes synchronous and fail-closed; teardown deletes the
  per-session connector/secret and never mutates environment connector policies.
- Secrets policy: webhook, post-clone git, provider, and environment credentials
  become identity-bound and stay downstream of the Sprite. Sprites injects the
  session-control-plane and environment connector credentials; the Worker injects
  refreshable provider OAuth upstream. Initial clone keeps its current short-lived,
  contents-read-only token as an explicit exception.
