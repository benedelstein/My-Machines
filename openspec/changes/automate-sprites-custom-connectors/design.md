## Context

This is the design for the **Sprite secrets proxy**. The goal: no usable webhook or
git credential ever lives inside a Sprite, and the Sprite's egress is transparently
routed through Sprites connectors so that credentials are injected outside the
Sprite and a compromised Sprite cannot impersonate the session.

v1 builds two things together:

1. **Per-session Custom API connectors** for the webhook and git credentials.
2. **A transparent Sprite-side egress proxy** (local MITM + iptables/nft) that
   reroutes the Sprite's outbound HTTPS to those connectors — the general
   "arbitrary connector URL" proxy mechanism, with all its runtime complications.

Explicitly **out of scope for v1**: the user-facing part — letting users define
their own secrets (OpenAI, Slack, ...) and storing/managing them. The transparent
proxy is built generically so those slot in later as additional routing entries,
but we do not build the definition UI, storage, or Worker secret custody now.

### Current solution and why it is not enough

Today a Sprite is handed a webhook callback token and a git proxy token as runtime
material. Both are **extractable**: anything compromising the Sprite can read them
and forge webhook callbacks impersonating the Sprite, or drive git from anywhere.
The git read path is also degraded (revoke-after-clone, because chunked pulls
through the proxy were too slow). The fix is to remove the secrets from the Sprite
and inject them at the connector gateway after Fly authorizes the specific Sprite.

## Decision: one connector per session (no multiplexing)

A single connector reused across sessions **does not work** — settled, not open.
The Sprites gateway does **not** forward a trustworthy Sprite identity to the
upstream (tested), so with one shared connector the Worker could not tell which
session called. Therefore each session mints its own connector(s), and identity is
carried by a **per-session shared secret**:

- At provisioning, generate a per-session secret the Worker stores in D1 keyed to
  the session.
- The connector's injected credential **is** that secret; its `base_api_url` is our
  Worker endpoint; its access policy is scoped to that session's Sprite.
- When the Sprite calls the connector, Fly injects the secret; the Worker looks it
  up, which both **identifies the session** and **proves the call came through the
  sprite-scoped gateway**. The per-session secret replaces the missing sprite-id
  header.

One per-session connector can serve both webhook and git by path (the gateway
forwards `base_api_url + <path after the connection id>`). Use one where possible;
split into two if webhook and git need different upstreams.

## Decision: a transparent egress proxy is the routing mechanism

Rather than reconfigure every tool in the Sprite to call connector URLs, the Sprite
runs a **local transparent proxy** and iptables/nft **redirects** its outbound 443
into it. The proxy MITM-terminates TLS with a Sprite-trusted local CA, reads the
plaintext request, looks the destination up in a **routing table**, strips the
client's auth header, and **rewrites the request to the matching per-session
connector gateway URL**. Fly injects the real secret; the Worker verifies it.

Why transparent instead of direct URL config:

- Captures **all** egress; the agent cannot bypass the connector by calling a URL
  directly or by using a tool we didn't reconfigure.
- It is the general mechanism for **arbitrary connector URLs** (what the user wants
  now), so webhook and git are just the first two routing entries; future user
  secrets are more entries, no new mechanism.
- The agent sees normal URLs and no secret; the proxy and gateway do the rest.

This is proven: `services/api-server/scripts/sprite-egress-proxy.mjs` +
`test-sprite-egress-proxy.ts` demonstrated transparent interception, MITM, auth
stripping, gateway rewrite, and header injection end to end. Production generalizes
it from a single hardcoded target to a routing table and adds the provisioning and
toolchain plumbing below.

## The transparent proxy in detail (and every complication)

### 1. Egress redirection (iptables/nft)

- Redirect outbound `tcp dport 443` from the Sprite's processes to the local proxy
  port with an OUTPUT NAT REDIRECT rule. The Sprite has **`CAP_NET_ADMIN`**, so
  REDIRECT is permitted (verified).
- **Complication — the toolchain is missing.** `nft`/`iptables` are **not installed**
  by default and `apt-get` fails because the Sprite is **not uid 0**. Proven
  workaround: download/extract the `nftables` `.deb`s into `/tmp` and run the
  extracted `nft` with `LD_LIBRARY_PATH`. Production must **bundle the nft/iptables
  toolchain in the Sprite image**, or stage it from R2 during provisioning, and
  **fail closed** if it is absent (no redirect ⇒ do not start the Sprite).
- **Complication — don't intercept the gateway.** The proxy's own upstream calls to
  the Sprites gateway (`api.sprites.dev`) must **not** be redirected, or it loops.
  Exclude the gateway host/IPs from the REDIRECT rule (and set `NO_PROXY` for the
  explicit-proxy path). Resolve and pin the gateway IPs at provisioning.

### 2. TLS interception + local CA trust

- The proxy runs a transparent TLS server (and an explicit `CONNECT` proxy for
  tools that honor proxy env). It mints **per-host leaf certificates via SNI**,
  signed by a **per-Sprite local CA**.
- Install the CA into the **system trust store** (`update-ca-certificates`) **and**
  the per-runtime stores that don't use it: `NODE_EXTRA_CA_CERTS` (Node),
  `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` (Python/OpenSSL), and equivalents.
- **Complication — runtimes that ignore the system store.** Statically linked
  binaries, Go's built-in roots, and cert-pinned clients will reject the MITM.
  Enumerate the runtimes the agent actually uses; set env overrides where they
  exist; document the unsupported cases. Before trust install the MITM is correctly
  **rejected** (verified) — good, it fails closed rather than leaking plaintext.
- Rotate/expire the CA with the session; never persist it beyond teardown.

### 3. Rewrite + inject

- Read the plaintext HTTP request, **strip the client `authorization` header**
  (and hop-by-hop headers), and rewrite to
  `<gatewayBase>/<sessionConnId>/<original-path>?<query>`. The gateway injects
  `Authorization: Bearer <per-session-secret>` and forwards to the connector's
  `base_api_url`.
- **Routing table:** destination host → { connector gateway URL | pass-through
  unmodified | block }. For v1 the entries are the webhook host and the git host,
  each mapping to this session's connector(s). **Fail-closed default:** an unrouted
  destination is **blocked**, never forwarded with a secret.
- Forward query strings and stream request/response bodies (proven for GET/POST;
  git pack streaming still to be load-tested — see Open Questions).

### 4. Lifecycle

- Start the proxy at provisioning as a long-lived process; install CA, rules, and
  routing table before the agent runs; tear all of it down (proxy, rules, CA,
  secret) on session end.

## Connector provisioning (`mintConnector`)

Sprites has **no REST create** for Custom API connectors (Fly confirmed: `POST
/v1/oauth/connections/api_key` only takes `provider` + `api_key`), so creation is
driven through the dashboard. One primitive, called during provisioning:

```text
mintConnector({ baseApiUrl, token, authMethod='header', headerPrefix='Bearer',
                testUrl, scope }) -> { gatewayConnectionId, detailId }
```

- **Create (browser).** Proven by the 2026-07-06 spike. Form
  `/account/:org/connectors/new?type=custom_api` (`custom-api-form`,
  `phx-submit="create_custom_api"`; fields `base_api_url`, `access_token`,
  `auth_method`, `auth_header_prefix`, `test_url`). **Test gates create**:
  `test_custom_api` must reach `HTTP 200 — Connection OK`
  (`div.bg-violet-50` + `hero-check-circle-mini`) before Create enables. The
  redirect carries the **gateway connection id**; the detail page uses a separate
  **detail id** — store both.
- **Scope + verify (REST).** Create defaults to **deny-all** (verified), so a new
  connector is inert until scoped. `PATCH /v1/oauth/connections/{id}` with an
  `access_policy` (Sprite id/label; optionally `allowed_endpoints`), then GET to
  confirm `allow_all == false`. Auth `Bearer $SPRITES_TOKEN`.
- **Fail closed.** On any failure, REST-delete the partial connector and throw.
- **Test URL.** Our Worker health route that returns 200 only when the injected
  per-session secret validates, so the required test doubles as a gateway-reaches-
  Worker proof.

### Where the browser automation runs

A Worker can't run a browser in its isolate, but Cloudflare **Browser Rendering**
exposes Puppeteer/Playwright forks via a Worker binding, so the api-server Worker
drives create directly.

- **Option A — Browser Rendering (recommended):** `@cloudflare/playwright`; inject
  the dashboard `storageState` per run; ephemeral browser. Verified paid limits:
  120 concurrent browsers, 1 create/sec, 60s idle (10 min via `keep_alive`).
- **Option B — Fly.io Machine + upstream Playwright (fallback):** matches the
  Sprites-on-Fly infra; called over RPC. Use if CF caps/fidelity bite.

Decision: Browser Rendering first, Fly Machine fallback.

## Synchronous, fail-closed provisioning — and its latency

The connector is the Sprite's egress path, so provisioning is **synchronous**: mint
+ scope the connector(s), then install the proxy, CA, redirect rules, and routing
table, all as blocking steps of session creation. Any failure **fails the session
closed** — no Sprite starts with a token in the clear, an un-redirected egress, or
an unusable callback path. No async `connector-pending` state.

Latency cost: per-session, browser-driven mint on the critical path (the "~20s is
too slow" concern). Per-session is unavoidable given the missing sprite-id header.
Mitigate (measure first): minimize the browser flow, use warm Browser Rendering
sessions and a fast Worker health `test_url`, and **overlap the mint with VM boot**
(already seconds) so it hides under existing startup rather than adding to it. No
speculative pre-mint pool.

## Webhook (v1)

Add a routing-table entry: the webhook host → this session's connector. The agent
POSTs the normal webhook URL with no secret; the proxy reroutes to the connector;
Fly injects the per-session secret; the Worker accepts the callback only when the
injected secret maps to the session. Retire the extractable webhook token behind a
flag once proven.

## Git (v1)

Requirements: the agent must **pull up to date and push**; branch validation stays;
the extractable git proxy token goes away; read-path latency (chunked pulls) was the
blocker behind revoke-after-clone.

- Route git HTTPS (`info/refs`, `git-upload-pack` fetch, `git-receive-pack` push)
  through the proxy → connector; inject the git credential at the Worker.
- Keep branch validation at the Worker git-proxy layer.
- Solve read latency without revoke-after-clone: the credential can now ride the
  connector for the whole session (non-extractable), and/or optimize proxy pack
  streaming. Measure (open).

## Data model (D1) — v1

- `session_connectors`: `session_id`, gateway connection id, dashboard detail id,
  provisioning status, access-policy summary, timestamps.
- Per-session shared secret keyed to the session; encrypted at rest; deleted on
  teardown.
- (No user-defined-secret tables in v1.)

## Request flowcharts

Webhook:

```text
agent POSTs https://<webhook-host>/... (no secret)
  -> iptables REDIRECT 443 -> local proxy (MITM w/ local CA, strip auth)
  -> rewrite -> <gateway>/<sessionConnId>/webhook/...
  -> Fly gateway (sprite-scoped) injects Bearer <per-session-secret>
  -> Worker: secret -> session; accept callback as that session
```

Git fetch:

```text
agent: git fetch (HTTPS to <git-host>)
  -> proxy -> <gateway>/<sessionConnId>/git/<repo>/git-upload-pack
  -> gateway injects secret -> Worker git proxy: verify -> session;
     branch validation; inject real git credential -> GitHub; stream pack back
```

Unrouted destination:

```text
agent -> some other https host -> proxy: no routing entry -> BLOCK (fail closed)
```

## Out of scope for v1 (mechanism ready, not built)

- **User-defined secrets.** Definition UI/API, encrypted D1 storage with allowed
  hosts + environment links, and Worker-side custody/injection for arbitrary user
  APIs. When added, they are additional routing-table entries → per-session
  connectors (or a Worker egress route), needing SSRF protection (host allowlist,
  block private/metadata ranges, no internal redirects). Not built now.

## Risks / Trade-offs

- **Per-session mint latency** on the critical path. Minimize + overlap with VM
  boot; measure. Not removable without a shared connector (ruled out).
- **nft/iptables staging fails** ⇒ no redirect ⇒ egress uncaptured. Bundle the
  toolchain in the Sprite image; fail closed if absent.
- **Trust-store gaps** — static/pinned/Go-root runtimes bypass the local CA.
  Enumerate and handle; document unsupported cases; the MITM fails closed
  pre-trust.
- **Gateway self-interception** — the proxy's calls to the gateway must be excluded
  from REDIRECT/NO_PROXY or it loops. Pin gateway IPs at provisioning.
- **Dashboard automation fragility / deny-all default / dashboard-session expiry** —
  preflight shape checks, verify `allow_all == false` after scope, provisioner-only
  auth with reauth-required status, fail closed.
- **Browser Rendering caps** (120 concurrent, 1 create/sec) bound peak session
  creation; size against concurrency; Fly fallback.
- **Git read latency** — the original blocker; measure the connector path; don't
  silently reintroduce revoke-after-clone.
- **Per-session secret storage** — encrypt at rest, scope to session, delete on
  teardown.

## Migration Plan

1. Sprite image: bundle/stage the nft/iptables toolchain; generalize
   `sprite-egress-proxy.mjs` to a routing table with fail-closed default; CA install
   across runtime trust stores; gateway-exclusion rules.
2. D1: `session_connectors` + per-session secret storage.
3. `mintConnector` via Browser Rendering: browser create → REST scope → REST verify
   → delete-on-failure; preflight shape/drift checks; redact secrets.
4. Worker endpoints: health `test_url`; `/webhook` and `/git` verifying the injected
   per-session secret → session.
5. Synchronous fail-closed provisioning: mint+scope, install proxy/CA/rules/routing,
   hand the Sprite its connector URLs; teardown deletes connector + secret.
6. Webhook cutover behind a flag; retire the extractable webhook token.
7. Git cutover (fetch + push) behind a flag; keep branch validation; fix read
   latency without revoke-after-clone.
8. (Later) user-defined secrets on the same proxy mechanism.

Rollback: keep the current token path behind a flag until each cutover is proven;
the proxy blocks unrouted egress, so partial rollout stays fail-closed.

## Open Questions

- Which id do the REST connection endpoints take — gateway connection id vs detail
  id — and the delete verb/path? (Quick live check.)
- Can Sprite labels be set at Sprite creation, or must scoping be by Sprite id after
  the Sprite exists? (Affects mint ordering.)
- Does the connector gateway stream large/chunked bodies well enough for git pack
  data? (The historical read-latency blocker — measure.)
- Which Sprite runtimes ignore the system trust store, and how are they handled?
- Real per-session mint latency via Browser Rendering, and how much overlaps VM
  boot?
- One per-session connector path-routing webhook+git, or two connectors?
- Git: keep the injected credential for the session vs optimize streaming?

Resolved:

- ~~Gateway forwards a verifiable Sprite identity?~~ **No (tested)** → per-session
  connectors; per-session secret carries identity.
- ~~Multiplex one connector across sessions?~~ No.
- ~~REST update access policy?~~ Yes, `PATCH`/`PUT /v1/oauth/connections/{id}`.
- ~~REST create for Custom API?~~ No (preset providers only) — browser create.
- ~~Create default access?~~ Deny-all (verified) — scope is a grant.
- ~~Can a Worker drive a browser?~~ Yes, via Cloudflare Browser Rendering.
- ~~Async connector-pending?~~ No — synchronous, fail-closed.
- ~~Transparent proxy + iptables in scope?~~ **Yes, v1.** User-facing secret
  definition/storage is the only deferred piece.
