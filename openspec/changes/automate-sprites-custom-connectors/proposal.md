## Why

Session Sprites today receive extractable secrets — a webhook callback token and a
git proxy token — as runtime material. Anything that compromises a Sprite can read
them and impersonate the Sprite: forge webhook callbacks to the Worker or drive git
operations from anywhere. The git read path is also degraded (revoke-after-clone
because chunked pulls through the proxy were too slow). We need a **secrets proxy**:
every secret moves out of the Sprite and behind a gateway that proves the caller is
the authorized Sprite and injects the real credential only after that check, so a
value leaked from the Sprite is worthless. This also sets up user-supplied secrets
(OpenAI, Slack, etc.) that never enter the Sprite.

Sprites Custom API connectors are a key building block but not the whole design,
and Sprites exposes connector creation only through the dashboard, not the public
REST API — so part of this work is automating that dashboard flow.

## What Changes

- Add a Sprite-side transparent egress proxy: a local MITM proxy + per-Sprite CA +
  iptables/nft REDIRECT that captures the Sprite's HTTPS egress, strips client
  auth, and rewrites to a connector gateway. Feasibility proven by a live spike;
  requires staging an nft/iptables toolchain into the Sprite (it lacks one and
  cannot `apt-get`).
- Add a Worker internal egress route that custodies secrets, validates the
  gateway-injected shared secret, resolves the calling Sprite→session, matches the
  requested destination to a custodied secret, injects it, and forwards — with SSRF
  protection.
- Adopt a **multiplexed single internal connector** model: one Custom API connector
  → our Worker, created rarely and scoped by Sprite label, instead of minting a
  connector per session (rejected as too slow). The Worker custodies webhook, git,
  and user secrets in D1 and injects by destination.
- Expose connector creation as an on-demand `mintConnector` primitive (browser
  create + REST scope/verify/delete), driven from the api-server Worker via
  Cloudflare Browser Rendering (Fly.io Machine fallback). Findings verified by a
  live spike (2026-07-06); create defaults to deny-all.
- Secure the webhook and git paths through the egress proxy; keep git branch
  validation; solve git read latency without revoke-after-clone.
- Add user-defined secrets: D1 storage (encrypted value, allowed hosts, environment
  links) and proxy injection.
- Make connector/proxy setup a **synchronous, fail-closed** part of session
  provisioning.

## Capabilities

### New Capabilities

- `sprites-custom-connector-provisioning`: Programmatically create, scope, and
  reconcile Sprites Custom API connectors via dashboard automation + REST, and use
  them as the gateway for a Sprite secrets proxy that keeps webhook, git, and
  user-supplied secrets out of the Sprite runtime.

### Modified Capabilities

- None yet (webhook and git securing land as cutovers behind flags).

## Impact

- New Sprite-side components: bundled nft/iptables toolchain, local CA install
  across runtime trust stores, transparent proxy with a destination routing table.
- New Worker internal egress route (secret custody, sprite→session resolution,
  injection, SSRF guards) and connector-minting via Browser Rendering.
- New D1 tables: connector metadata (both id spaces), secrets (encrypted value,
  allowed hosts), environment links, provisioning attempts.
- Session provisioning becomes synchronous and fail-closed, attaching Sprite labels
  and installing the proxy before the Sprite does secret-bearing work.
- Secrets-handling policy: webhook/git tokens and user API keys become
  Worker-custodied and gateway-injected, never handed to the Sprite.
- Hard dependency to confirm first: whether the Sprites gateway forwards a
  verifiable Sprite identity to the upstream (decides multiplexed vs per-session).
