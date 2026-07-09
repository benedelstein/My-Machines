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

### What already exists (important — the plan is not greenfield)

Much of the "secrets proxy" is already built and working:

- `network-policy.ts` already builds Sprite egress policies with a `locked` mode
  (`buildFinalNetworkPolicy`) that allows only the Worker + provider and appends a
  terminal `deny-all`. This is the same DNS+L3/L4 lockdown discussed elsewhere in
  this doc — it exists.
- `GitProxyService` already proxies git: the Sprite calls
  `WORKER_URL/git-proxy/:sessionId/github.com/owner/repo.git/...` with a per-session
  `gitProxySecret` bearer; the Worker mints an installation token and injects
  `Authorization: Basic x-access-token:<token>` only when forwarding to GitHub. The
  **real GitHub credential never enters the Sprite.** Push branch validation
  (`cloude/*` + session suffix + branch lock) and repo allowlisting are enforced.
- In `locked` mode, `cloneRepo` points `origin` at the Worker git proxy so fetch and
  push both work with direct GitHub denied.

So the existing **Worker-proxy + per-session-bearer + network-lockdown** pattern
already keeps the real credentials out of the Sprite and works under lockdown. The
only residual gap it leaves is that the per-session bearer secret is itself
extractable from the Sprite.

### The actual remaining gap

For a bearer like `gitProxySecret`, extraction has a **tightly bounded** blast
radius: it authorizes only that one repo, only `cloude/*` branches suffixed with the
session id, only while the session installation token is valid, only at the Worker
endpoint. So the incremental value of making it non-extractable is modest.

The connector + transparent-proxy work in this change is therefore justified by two
things the existing pattern does **not** do, not by a git/webhook emergency:

1. **Non-extractable secrets** — moving a per-session bearer into a Sprites connector
   so Fly injects it and the Sprite never holds it.
2. **Transparent interception of unmodified code** — so a tool that hardcodes a real
   upstream URL (e.g. `api.openai.com`) is routed to a connector without
   reconfiguring its base URL. This is the "arbitrary connector URL" capability.

Where the existing pattern already suffices (git today), prefer leaving it; apply
connectors where one of the two properties above is actually needed.

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

## Decision: the Sprites network egress policy is the hard boundary

Security does not rest on the in-Sprite proxy (which in-Sprite root can tamper
with). It rests on the **Sprites network egress policy**, enforced outside the VM.
At provisioning, lock the Sprite so it can reach essentially only the connector
gateway:

- `POST /v1/sprites/{name}/policy/network` with `rules: [{domain, action}]`
  (exact domains, `*.wildcard` subdomains, or preset bundles via `include`;
  `action` is `allow`/`deny`). `GET` reads the current policy.
- Enforced at the DNS/network layer, **not inside the VM** — changes apply
  immediately and existing connections to newly-blocked domains are terminated, so
  in-Sprite root **cannot** lift it.
- Target policy: allow the connector gateway (`api.sprites.dev`) and deny the rest.
  A root agent that flushes the local redirect and dials an upstream directly is
  refused at the network layer and still holds no credential.

**Enforcement is L3/L4, not DNS-only — verified 2026-07-08.** On a test Sprite with
policy `{rules:[{domain:"api.sprites.dev",action:"allow"}]}`, all of these were
**refused**: `curl https://example.com` (DNS refused), a raw TCP `connect()` to
`1.1.1.1:443` with **no DNS**, and a raw `connect()` to `93.184.216.34:443`
(example.com's IP, no DNS) — while `api.sprites.dev` stayed reachable. So a
root agent **cannot** exfil by dialing a hard-coded IP; the gateway-only lockdown is
a genuine hard boundary at the connection layer. The earlier "DNS-only ⇒ IP-direct
bypass" worry is closed.

Two composition details this creates:

- **apt during provisioning.** Installing the nft toolchain needs the apt mirror.
  Either install **before** applying the lockdown, or temporarily allow the mirror
  domain, then tighten to gateway-only before the agent runs.
- **DNS for proxied hosts (the resolver requirement).** The transparent proxy
  redirects `:443`, but the agent's client still has to *resolve* a host to emit the
  connection that gets redirected. Under a gateway-only policy the platform also
  **refuses DNS** for non-allowlisted hosts (verified: the configured resolver
  returned connection-refused for `example.com`), so the client can't resolve
  `api.openai.com` and the redirect never fires. Fix: run a **local resolver**
  (`127.0.0.1`) that answers proxied hosts with a **dummy IP** — the redirect
  catches the connection regardless of the address, and the platform's L3/L4 block
  still prevents any real egress if the proxy is bypassed. Do **not** allowlist the
  proxied hosts in the policy (that would let a root agent reach them directly after
  flushing the redirect); keep the policy gateway-only and resolve locally. The
  simpler alternative, for cooperative tools, is to skip transparent interception for
  a given client and configure its `base_url` to the connector URL directly — no
  resolver needed, but it only covers tools you can reconfigure.

## The transparent proxy in detail (and every complication)

### 1. Egress redirection (iptables/nft)

- Redirect outbound `tcp dport 443` from the Sprite's processes to the local proxy
  port with an OUTPUT NAT REDIRECT rule.
- **Toolchain install is trivial — earlier "can't apt-get" finding was wrong**
  (re-tested 2026-07-08 on a fresh Sprite, Ubuntu 26.04). The Sprite runs as uid
  1001 but has **passwordless `sudo`**, so `sudo apt-get install -y nftables
  iptables` succeeds; `sudo nft`/`sudo iptables` then add NAT REDIRECT rules that
  **actually divert live connections** (verified: a connect to `1.1.1.1:12345` was
  redirected to a local listener). `CapEff` includes `cap_net_admin` **and**
  `cap_sys_admin`. So: no R2 `.deb` staging, no `LD_LIBRARY_PATH` hack. The Sprite
  base image is a fixed upstream image we **cannot** modify, so the toolchain is
  installed **at provisioning** via `sudo apt-get install` (it cannot be baked in).
  This adds a per-boot apt round-trip to provisioning — an argument for keeping the
  install fast (minimal package set, apt cache/mirror if available). Fail closed if
  the toolchain or rules can't be established. NOTE the network egress policy (below)
  must allow the apt mirror during this step, or move the install before the lockdown
  is applied.
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

### 5. The transparent proxy is a convenience layer, not the boundary

The 2026-07-08 test showed the Sprite user has **passwordless `sudo`**, so a
root-capable agent can `sudo nft flush ruleset`, kill the proxy, or read the local
CA key. That is **fine**, because the transparent proxy is not what enforces
security. Three separate things do, and none of them depend on the in-Sprite proxy:

1. **No credential is ever in the Sprite.** Bypassing the proxy yields nothing to
   steal — the key lives only in the connector and is injected at the gateway.
2. **Connectors are Sprite-scoped.** Only this session's Sprite may call its
   connectors (gateway access policy), so a stolen connector URL is useless
   elsewhere.
3. **The network egress policy is the hard boundary** (see below). The Sprite is
   locked so it can only reach the connector gateway; enforcement is outside the VM,
   so in-Sprite root cannot lift it. A root agent that flushes the redirect and dials
   an upstream directly is blocked at the network layer and still has no key.

So "the agent has root and can bypass the proxy" is a **non-issue**: it gains no
credential and cannot egress anywhere except through the gateway. The transparent
proxy exists purely so that **unmodified agent code calling real URLs
(`api.openai.com`, `github.com`) is transparently routed to the right connector**,
instead of every tool needing its base URL reconfigured. It is UX/routing, not a
security control.

The one honest caveat is data exfiltration (not credential theft): see the network
policy's DNS-vs-IP enforcement question below.

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

Decision: **start on Browser Rendering; switch to a Fly Machine if measured
per-session mint latency is too high.** Instrument the mint end-to-end from day one
so the switch trigger is a number, not a guess.

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

## Git (v1) — keep the current path as-is

Decision: **do not connector-ize git in v1.** The existing `GitProxyService` +
`locked` network policy already keeps the real GitHub credential out of the Sprite,
handles fetch + push, enforces branch validation, and works under lockdown (see
"What already exists"). The only thing left is making the per-session
`gitProxySecret` non-extractable, and its blast radius is already tightly bounded, so
it is not worth a per-session connector mint for v1.

Leave git on its current path. Treat "route git through a connector so the secret is
non-extractable" as optional later hardening. The transparent proxy needs no git
routing entry in v1.

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
- **Agent has root (`sudo`) ⇒ can bypass the proxy — but this is a non-issue.** No
  credential is in the Sprite to steal, connectors are Sprite-scoped, and the
  network egress policy (enforced outside the VM) confines egress to the gateway. The
  proxy is UX/routing, not a boundary.
- **Toolchain install at provisioning** — the base image can't be modified, so the
  nft toolchain is `sudo apt-get install`ed per boot; the lockdown must allow the
  apt mirror during that step (or install before locking down). Fail closed if rules
  can't be established.
- **DNS/interception composition** — under a gateway-only policy the platform also
  refuses DNS for non-allowlisted hosts, so transparent interception needs a local
  resolver returning dummy IPs for proxied hosts (keep the policy gateway-only; do
  not allowlist proxied hosts). Verified that IP-direct egress is blocked, so the
  local-resolver approach is contained.
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
- ~~Can the Sprite install nft/iptables?~~ **Yes (verified 2026-07-08):** passwordless
  `sudo apt-get install -y nftables iptables` works; NAT REDIRECT diverts live
  connections. No R2 staging hack, but the fixed base image means install is at
  provisioning, not baked in.
- ~~Is the agent having root a problem?~~ No — no credential is in the Sprite,
  connectors are Sprite-scoped, and the network egress policy (enforced outside the
  VM) is the boundary. The proxy is UX/routing, not security.
- ~~Is there a network egress lockdown?~~ Yes — `POST /v1/sprites/{name}/policy/network`
  (allow/deny domain rules, outside-VM). Lock to gateway-only.
- ~~Does the policy enforce at L3/L4 or DNS-only?~~ **L3/L4 (verified 2026-07-08):**
  IP-direct `connect()` to non-allowlisted hosts is refused even with no DNS. So the
  gateway-only lockdown is a hard boundary; no IP-direct exfil.
- ~~How do DNS filtering and transparent interception compose?~~ Under a gateway-only
  policy the platform refuses DNS for non-allowlisted hosts, so use a local resolver
  returning dummy IPs for proxied hosts (redirect catches the connection; L3/L4 block
  contains any bypass). Do not allowlist proxied hosts.
- ~~Browser automation host?~~ Cloudflare Browser Rendering first; switch to Fly if
  latency is too high.
