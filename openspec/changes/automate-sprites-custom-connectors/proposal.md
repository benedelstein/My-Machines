## Why

Session Sprites authenticate their egress with **bearer secrets** handed to the
Sprite (git today; webhook and provider auth on the same footing). A bearer
authorizes by possession, not identity, so the untrusted, root-capable agent can
extract it and replay its authority from anywhere — read/push the private repo from
a laptop, POST fake agent responses into the user's chat log, or reuse a key
off-Sprite. And there is no path at all for arbitrary user-supplied secrets (OpenAI,
Slack, custom APIs) to be used without entering the Sprite.

The **Sprite secrets proxy** fixes all of this coherently, on three prongs that
share one mechanism:

1. **Caller-identity binding** — Fly verifies the calling Sprite against a
   connector's access policy before injecting the credential, so an extracted
   URL/secret is useless to anyone who is not that Sprite.
2. **Secrets out of the sandbox** — no webhook, git, provider, or user credential
   ever exists in the Sprite; Fly injects it downstream.
3. **Arbitrary secret values** — a Sprite-local transparent MITM proxy routes the
   Sprite's unmodified egress to per-secret connectors that inject the real secret,
   so user-defined secrets work without the agent ever holding a key.

Sprites exposes connector creation only through the dashboard, not the public REST
API, so automating that dashboard flow is part of the work.

## What Changes

- **Connector abstraction (identity-bound):** every credential-bearing egress goes
  through a Sprites Custom API connector — Fly verifies Sprite identity, injects the
  secret, forwards. Two kinds: an **internal per-session connector** (webhook + git
  → our Worker, injects a per-session secret) and **per-secret connectors** (provider
  key + each user secret → external upstream, injects the real Sprites-custodied
  secret, scoped to entitled Sprites).
- **Transparent Sprite-side egress proxy:** local MITM + per-Sprite CA + local
  resolver + iptables/nft REDIRECT, with a routing table (host → connector | direct |
  block) and fail-closed default. Toolchain installed at provisioning via `sudo
  apt-get` (base image is fixed).
- **Network egress policy as the hard boundary:** gateway + non-secret allowlist +
  deny-all, enforced outside the VM at L3/L4 (verified). Credential hosts are forced
  through the proxy, not allowlisted.
- **`mintConnector` primitive** (browser create + REST scope/verify/delete) via
  Cloudflare Browser Rendering (Fly.io Machine fallback if latency demands).
- **Worker cutovers:** webhook and git endpoints stop accepting Sprite-held bearers
  and require the gateway-injected credential; retire the old bearers behind flags.
- **User-defined secrets:** D1 metadata + entitlement, per-secret connector mint,
  routing + scoping. Sprites custodies the values; we never store plaintext.
- **Synchronous, fail-closed provisioning**, with teardown that deletes the
  per-session connector/secret and de-scopes shared connectors.

The concept is whole; the build is sequenced in `design.md` "Staging" (S1 webhook →
S2 git → S3 transparent proxy → S4 provider key → S5 user secrets), each stage a real
subset sharing one data model, connector abstraction, and proxy — none redesigned
later.

## Capabilities

### New Capabilities

- `sprites-custom-connector-provisioning`: Programmatically create, scope, and
  reconcile Sprites Custom API connectors and route Sprite egress through them so
  that caller identity is verified, no credential enters the Sprite, and arbitrary
  user-defined secrets are injected outside the Sprite.

### Modified Capabilities

- None yet (webhook and git securing land as cutovers behind flags).

## Impact

- New Sprite-side data plane: nft/iptables toolchain (installed at provisioning),
  per-Sprite CA across trust stores, local resolver, transparent proxy + routing
  table + gateway-exclusion rules.
- New `mintConnector` via Cloudflare Browser Rendering, run synchronously during
  provisioning.
- New Worker internal `/webhook` and `/git` endpoints (verify gateway-injected
  per-session secret) and a health `test_url`; webhook/git bearer paths retired.
- New D1: `session_connectors`, `secrets` (metadata only), `environment_secrets`.
- Session provisioning becomes synchronous and fail-closed; teardown deletes the
  per-session connector/secret and de-scopes shared per-secret connectors.
- Secrets policy: webhook/git/provider/user credentials become connector-injected
  and identity-bound; the Sprite holds none of them.
