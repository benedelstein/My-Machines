## Why

Session Sprites today receive extractable secrets — a webhook callback token and a
git proxy token — as runtime material. Anything that compromises a Sprite can read
them and impersonate the Sprite: forge webhook callbacks to the Worker, or drive git
operations from anywhere. The git read path is also degraded (revoke-after-clone
because chunked pulls through the proxy were too slow). v1 of the **Sprite secrets
proxy** removes these credentials from the Sprite and transparently routes the
Sprite's egress through per-session Sprites Custom API connectors, so credentials are
injected outside the Sprite and a leaked-from-the-Sprite value is worthless.

Sprites exposes connector creation only through the dashboard, not the public REST
API, so part of this work is automating that dashboard flow.

## What Changes

- **Transparent Sprite-side egress proxy (v1).** A local MITM proxy + per-Sprite CA
  + iptables/nft REDIRECT captures the Sprite's outbound HTTPS, strips client auth,
  and rewrites requests to per-session connector gateway URLs via a routing table
  (fail-closed for unrouted destinations). This is the general "arbitrary connector
  URL" mechanism; webhook and git are its first two routing entries. Requires
  staging an nft/iptables toolchain into the Sprite (it lacks one and cannot
  `apt-get`) and installing the local CA across runtime trust stores.
- **Per-session connectors.** Mint one Custom API connector per session, scoped to
  that session's Sprite, whose injected credential is a per-session shared secret
  the Worker knows. A single connector multiplexed across sessions does not work
  (the gateway does not forward a verifiable Sprite identity — tested), so the
  per-session secret identifies the session.
- **`mintConnector` primitive** (browser create + REST scope/verify/delete), driven
  from the api-server Worker via Cloudflare Browser Rendering (Fly.io Machine
  fallback). Verified by the 2026-07-06 spike; create defaults to deny-all.
- **Worker endpoints** that verify the gateway-injected per-session secret and map
  it to the session, replacing the extractable webhook and git tokens; keep git
  branch validation; enable pull + push; fix read latency without revoke-after-clone.
- **Synchronous, fail-closed provisioning:** mint+scope the connector and install the
  proxy/CA/rules/routing before the Sprite runs; delete on teardown.

Out of scope for v1 (mechanism ready, not built): user-facing secret definition,
storage, and Worker custody for arbitrary user APIs (OpenAI, Slack, ...).

## Capabilities

### New Capabilities

- `sprites-custom-connector-provisioning`: Programmatically create, scope, and
  reconcile per-session Sprites Custom API connectors via dashboard automation +
  REST, and transparently route Sprite egress through them so the webhook and git
  credentials never enter the Sprite runtime.

### Modified Capabilities

- None yet (webhook and git securing land as cutovers behind flags).

## Impact

- New Sprite-side components: bundled nft/iptables toolchain, local CA installed
  across trust stores, transparent proxy with a destination routing table and
  gateway-exclusion rules.
- New `mintConnector` provisioning via Cloudflare Browser Rendering, run
  synchronously during session creation.
- New Worker internal `/webhook` and `/git` endpoints that verify the injected
  per-session secret; a health endpoint used as the connector `test_url`.
- New D1: `session_connectors` (both id spaces, status) and per-session secret
  storage (encrypted, deleted on teardown).
- Session provisioning becomes synchronous and fail-closed; teardown deletes the
  connector (REST) and the secret.
