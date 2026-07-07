## Context

This is the design for the **Sprite secrets proxy**: a way for session Sprites to
reach outside services (the Cloude Worker webhook, the git proxy, GitHub, and
user-supplied third-party APIs) without any usable secret ever living inside the
Sprite runtime. Sprites Custom API connectors are one building block; they are not
the whole design.

### Current solution and why it is not enough

Today a Sprite is handed bearer tokens directly — a webhook callback token and a
git proxy token — as runtime material. Both are **extractable**: the agent (or
anything that compromises the Sprite) can read them and then:

- POST forged webhook callbacks to the Worker while impersonating the Sprite, or
- drive git operations with the proxy token from anywhere.

The git read path is also degraded today: the initial clone uses a short-lived
GitHub read token that is then revoked, and the proxy was too slow for chunked
pulls, so the agent effectively cannot pull itself up to date or push cleanly.

The goal: move every secret out of the Sprite and behind a proxy that (a) proves
the caller is the specific authorized Sprite and (b) injects the real credential
only after that check, so a leaked-from-the-Sprite value is worthless.

### What "secret never enters the Sprite" buys, precisely

A connector / egress gateway authorizes by Sprite identity and access policy
before forwarding, and injects the credential on the far side. So:

- Extracting from the Sprite yields nothing — there is nothing to extract.
- Only the scoped Sprite can produce an authorized call, so webhook/git
  impersonation stops.
- Later, user-supplied secrets (OpenAI, Slack, etc.) get the same treatment: the
  user's key is injected at the proxy and never handed to the Sprite.

## Two feasibility spikes, both proven

### Spike A — Sprite-side transparent egress proxy (proven)

Confirmed a Sprite can transparently route its own HTTPS egress through a gateway
that injects credentials, with no secret and no explicit proxy config in the
Sprite. Reference implementation:
`services/api-server/scripts/sprite-egress-proxy.mjs` +
`test-sprite-egress-proxy.ts`.

- Local Node proxy runs two intake paths: an explicit `CONNECT` proxy and a
  transparent TLS server; both MITM with a per-Sprite local CA (per-host leaf
  certs via SNI), read the plaintext HTTP request, and **rewrite it to the
  gateway URL** (`gatewayBase + originalPath + query`).
- It **strips the client `authorization` header** and lets the gateway inject the
  real one — the Sprite sends no credential.
- Trust: the local CA is installed into the system store
  (`update-ca-certificates`) and per-runtime stores (`NODE_EXTRA_CA_CERTS`,
  `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE`). Before trust install, curl correctly
  rejected the MITM (good — fail-closed).
- Transparent capture proven for curl, Node `fetch`, and Python `requests`,
  including calls with **no** proxy env vars (via iptables REDIRECT).
- Gateway header injection, query-string forwarding, and POST-body forwarding all
  work end to end.

Runtime constraints found (Fly Sprite):

- The Sprite has `CAP_NET_ADMIN`, so iptables/nft REDIRECT of outbound 443 is
  permitted.
- But `nft`/`iptables` are **not installed** by default and `apt-get` fails (the
  Sprite is not uid 0). Workaround proven: stage the `nftables` `.deb`s into
  `/tmp` and run the extracted `nft` with `LD_LIBRARY_PATH`. Production must
  **bundle or stage an nft/iptables toolchain artifact** (e.g. from R2) during
  Sprite provisioning.
- The proxy itself must reach `api.sprites.dev` (or our Worker) **without** being
  intercepted — the REDIRECT/NO_PROXY rules must exclude the gateway host.

### Spike B — dashboard connector automation (proven, 2026-07-06)

Drove the real Sprites dashboard with the browser tools (dummy `httpbin.org`
creds) and confirmed the whole create flow, because Sprites has **no REST create**
for Custom API connectors (confirmed by Fly support: `POST
/v1/oauth/connections/api_key` only takes `provider` + `api_key`, not the custom
base-URL / auth-method fields).

- Form at `/account/:org/connectors/new?type=custom_api`: id `custom-api-form`,
  `phx-change="validate_custom_api_form"`, `phx-submit="create_custom_api"`,
  auth-method values `header`/`url_path`/`query_param`/`custom_header`; fields
  `base_api_url`, `name` (auto from host), `description`, `access_token`,
  `auth_header_prefix` (default "Bearer"), `refresh_token`, `icon`, `test_url`.
- **Test gates create**: "Test Connection" (`test_custom_api`) must return the
  `HTTP 200 — Connection OK` state (`div.bg-violet-50` + `hero-check-circle-mini`)
  before the `Create Connection` submit enables.
- Create redirects to the **gateway connection id** (used at
  `/v1/gateway/custom_api/<id>`); the dashboard **detail page** uses a *separate*
  detail id. Store both.
- **Access defaults to deny-all** (no sprites) — corroborated by the panel copy,
  the REST docs ("empty or missing policies deny sprite use until updated"), and
  direct dashboard testing. A new connector is inert until scoped; scoping is a
  grant, not a lockdown. (An earlier spike reading of `allow_all=true` was a
  mis-attributed pre-existing connector.)
- **Policy is settable over REST**: `PATCH`/`PUT /v1/oauth/connections/{id}` with
  an `access_policy` object (`allow_all`, `sprite_labels`, `name_prefix`, and the
  UI-absent `allowed_endpoints` / `blocked_endpoints`), auth `Bearer
  $SPRITES_TOKEN`. So create is browser-only; scope/verify/delete are REST.

## Architecture

Two planes.

**Data plane (inside each Sprite), all non-secret:**

```text
agent process
  -> (plain HTTPS to webhook / git / api.openai.com / ...)
  -> iptables/nft REDIRECT 443 -> local transparent proxy (127.0.0.1)
  -> proxy MITMs with local CA, strips auth, looks up destination in a
     routing table, rewrites to the internal connector gateway URL:
        <gateway>/<connectionId>/egress/<scheme>/<host>/<path>?<query>
  -> Sprites gateway authorizes by Sprite identity + access policy,
     injects the internal shared secret, forwards to our Worker
```

**Control plane (Cloude Worker), holds all secrets:**

```text
Worker internal egress route
  -> validate the injected shared secret (proves "legit Sprite via gateway")
  -> identify the Sprite/session (gateway-forwarded sprite id; see open question)
  -> parse the requested destination from the /egress/ path
  -> match it against custodied secrets for this session/environment in D1
  -> decrypt the matching secret, inject the real header, apply SSRF guards
  -> forward to the real upstream (webhook handler, git proxy, OpenAI, ...)
  -> stream the response back through the gateway to the proxy to the agent
```

Webhook example (impersonation fix):

```text
agent POSTs https://api.cloude.dev/webhook/<session>  (no secret)
  -> local proxy -> internal connector gateway (scoped to THIS sprite)
  -> gateway injects internal shared secret -> Worker egress route
  -> Worker verifies secret + sprite→session, then treats it as an authorized
     webhook for that session. A stolen-from-sprite value cannot reproduce this
     because there is no value in the sprite and the gateway is sprite-scoped.
```

## Decision: multiplex one internal connector; custody secrets in the Worker

The tempting model — one Sprites Custom API connector per upstream (webhook, git,
each user key), minted per session via browser automation — is **rejected as the
primary path**: it puts a multi-second browser flow on the session hot path
(~20s is too slow), one per session, and creates connector sprawl.

**Primary model: a single generic internal egress connector, multiplexed.**

- One Custom API connector whose `base_api_url` is our Worker's internal egress
  route and whose `access_token` is an internal shared secret. It is created rarely
  (setup / rotation), not per session, and scoped by a **Sprite label** that all
  session Sprites carry.
- The Sprite-side proxy routes *all* secret-bearing egress to this one connector,
  encoding the real destination in the path (`/egress/<host>/<path>`).
- The **Worker** custodies every secret (internal webhook/git tokens and
  user-supplied keys), decrypts the one that matches the requested destination for
  that session, injects it, and forwards. The connector's only job is to prove
  "this call came from an authorized Sprite via the gateway."

Why this is the right call:

- **No browser automation on the session hot path.** Per-session provisioning is
  just: generate this session's secrets, store them in D1, install the proxy + CA
  + iptables + routing table on the Sprite. All fast, all local. This directly
  answers the "20s per session is too slow" objection — the slow browser step is
  amortized across all sessions, not paid per session.
- **Multiplex.** One connector serves webhook, git, and every user secret, keyed
  by destination. No per-path or per-secret connectors.
- **User secrets never touch the Sprite.** They sit encrypted in D1 and are
  injected in the Worker.

The trade-off to accept explicitly: secrets are **Worker-custodied**, not
Sprites-custodied. A Worker compromise could expose them, whereas a per-connector
Sprites secret would keep custody with Fly. This is judged acceptable because the
connector guarantees only the scoped Sprite can invoke the egress route and the
shared secret proves it — the same property a per-connector secret would give —
while avoiding per-session/per-secret browser minting. High-sensitivity secrets
that must stay out of our custody can still use a dedicated Sprites Custom API
connector (Model 1) as an exception.

**Critical open dependency (blocks the multiplexed model):** with one shared
connector, the Worker must know *which* Sprite/session is calling — the injected
shared secret is identical for all. This requires the Sprites gateway to forward a
**verifiable Sprite identity** header to the upstream (our Worker). If the gateway
does not forward a trustworthy sprite id, the multiplexed model collapses back to
either per-session connectors (Model 1, slow) or per-session shared secrets baked
into per-session connectors. Verifying the gateway's forwarded-identity behavior
is the first thing to confirm — it decides the whole architecture. (The thread
noted a "sprite id header" as a backup; it is actually load-bearing here.)

## Sprite-side transparent proxy

Provision the following into every session Sprite (all non-secret):

1. **Toolchain staging.** Stage an `nft`/`iptables` toolchain artifact (bundled in
   the Sprite image if possible, else fetched from R2) since the Sprite lacks it
   and cannot `apt-get`. Proven workaround: extracted `nft` + `LD_LIBRARY_PATH`.
2. **Local CA.** Generate a per-Sprite CA, install into the system store and the
   per-runtime stores (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
   `SSL_CERT_FILE`, etc.). Rotate/expire with the session.
3. **Local proxy.** Start the transparent MITM proxy (the spike's
   `sprite-egress-proxy.mjs`, generalized from a single target to a **routing
   table**: destination host → connector gateway URL, or "pass through
   unmodified", or "block"). It strips client auth and rewrites to the gateway.
4. **REDIRECT rules.** iptables/nft OUTPUT NAT REDIRECT of outbound tcp/443 to the
   proxy, **excluding** the gateway host (and localhost) so the proxy's own
   upstream calls are not intercepted.
5. **Fail-closed default.** Destinations with no routing entry should be blocked
   (or explicitly pass-through per policy), never silently sent with a secret.

Open items: runtimes that ignore the system trust store (statically linked, Go's
own roots, pinned certs) won't honor the local CA — enumerate and handle
(env overrides where possible, documented unsupported cases otherwise).

## Worker-side internal egress route handler

A new internal Worker route behind the shared-secret check. Responsibilities:

- **Authn:** validate the gateway-injected internal shared secret; reject anything
  without it. Rotate the shared secret on a schedule.
- **Identify:** resolve the calling Sprite → session/environment from the
  gateway-forwarded sprite id (see the critical open dependency).
- **Route + custody:** parse the requested destination from `/egress/…`, look up a
  matching custodied secret for that session/environment in D1, decrypt it, inject
  the real auth header (or rewrite host/path per the secret's shape).
- **SSRF protection:** the egress handler forwards to a destination named by the
  Sprite, so it is an SSRF surface. Guard with a host **allowlist** (only
  destinations that have a custodied secret or are explicitly permitted), block
  private/link-local/metadata ranges, disallow redirects to internal hosts, and
  never reflect internal error detail.
- **Internal targets:** for webhook and git, the "secret" is our own token and the
  "upstream" is our own webhook handler / git proxy — the handler injects and
  forwards internally.

## Webhook

Replace the extractable per-Sprite webhook token with the egress path: the Sprite
POSTs the normal webhook URL (no secret), the proxy routes it through the internal
connector, and the Worker validates the shared secret + sprite→session mapping
before accepting the callback. Result: a value stolen from the Sprite cannot forge
a webhook, because there is no value and the gateway is sprite-scoped.

## Git (read and write)

Requirements from the thread: the agent must **pull up to date and push**;
branch validation stays; the git proxy token is insecure because it is
extractable; read-path latency (chunked pulls through the proxy) was the blocker
that led to the current revoke-after-clone degradation.

Design directions to work through (currently the least-settled area):

- Route git HTTPS (`info/refs`, `git-upload-pack` for fetch, `git-receive-pack`
  for push) through the egress path so the credential is injected at the Worker,
  not held in the Sprite.
- Keep branch validation at the Worker git-proxy layer.
- Solve the read-latency problem rather than reintroducing the revoke-after-clone
  hack: options include letting the injected credential ride the connector for the
  whole session (no revoke) now that it is not extractable, and/or optimizing the
  proxy's streaming of pack data. Needs measurement.

## GitHub access (gh CLI / MCP / skill)

The agent needs GitHub operations beyond raw git. Options to evaluate: a
`gh`-CLI-through-the-egress-proxy path, a GitHub MCP server fronted by the
connector, or a dedicated skill. Left as a stub pending the git decision — whatever
carries git credentials should carry GitHub API credentials the same way.

## User-defined secrets and D1 model

Users declare secrets (e.g. "my app calls OpenAI / Slack") that must be injectable
at the proxy without entering the Sprite. Proposed D1 shape (from the thread):

- `secrets` (a.k.a. connectors) table: `id`, `name`, **encrypted value**, and the
  set of **allowed hosts** it may be injected for (a secret may map to several
  hosts, e.g. `api.openai.com` + `api.chatgpt.com`).
- Link to **environments** (which environment/session class may use the secret)
  via a foreign key / join table.
- The Worker egress handler decrypts a secret only when the requested destination
  host is in that secret's allowed-hosts and the calling session's environment is
  linked. Plaintext exists only transiently in the Worker during injection.

This is the same custody path as the internal webhook/git secrets — user secrets
are just additional rows keyed by host.

## Connector provisioning (dashboard automation)

Still required — for creating the internal egress connector(s) and any exception
Model-1 per-secret connectors — because Sprites has no REST create for Custom API
connectors. Exposed as one primitive:

```text
mintConnector({ baseApiUrl, token, authMethod, headerPrefix, testUrl, scope })
  -> { gatewayConnectionId, detailId, policySummary }
```

- **Create (browser):** preflight shape check → fill → `test_custom_api` → wait
  for "Connection OK" → `create_custom_api` → read both ids.
- **Scope + verify (REST):** `PATCH /v1/oauth/connections/{id}` with an
  `access_policy` (scope to the session Sprite label; for the internal connector,
  also `allowed_endpoints` to just the egress route), then GET to verify.
- **Fail closed:** on any failure, REST-delete the partial connector and throw.

Because the internal connector is created rarely, this browser step is **not** on
the session hot path.

### Where the browser automation runs

A Cloudflare Worker cannot run a browser in its own isolate, but Cloudflare
**Browser Rendering** exposes Puppeteer/Playwright forks via a Worker binding, so
the api-server Worker can drive the create flow directly — no separate service.

- **Option A — Browser Rendering (recommended).** `@cloudflare/playwright` from the
  Worker; inject the Sprites dashboard `storageState` per run; ephemeral browser.
  Verified paid limits: 120 concurrent browsers, 1 create/sec, 60s idle
  (extendable to 10 min via `keep_alive`) — ample for rare internal-connector
  mints. Pros: no new service, ephemeral logged-in session. Cons: CF Chromium
  fork, caps.
- **Option B — Fly.io Machine + upstream Playwright (fallback).** Matches the
  Sprites-on-Fly infra; the Worker calls it over RPC. Use if CF caps/fidelity bite
  or a warm authenticated context is wanted. Cons: a service to run and a box
  logged into the dashboard.

Decision: Browser Rendering first, Fly Machine as documented fallback.

## Synchronous provisioning

Connector/proxy setup is part of session provisioning and must be **synchronous**:
the connector URL is used as the webhook and git URL, so the Sprite cannot start
useful work until the proxy, CA, iptables, and routing are in place. There is no
async `connector-pending` state. Because the multiplexed model keeps the browser
step off the session path, the synchronous per-session work is fast (local setup +
D1 writes). If any provisioning step fails, session creation **fails closed** — a
Sprite never starts with secrets in the clear or with an unsecured egress path.

## Request flowcharts

Outbound user-API call:

```text
agent: GET https://api.openai.com/v1/... (Bearer left blank / dummy)
 -> iptables REDIRECT -> local proxy (MITM, strip auth)
 -> rewrite -> <gateway>/<intConnId>/egress/https/api.openai.com/v1/...
 -> Sprites gateway (sprite-scoped) injects internal shared secret
 -> Worker egress: verify secret + sprite->session; match api.openai.com to a
    custodied user secret for this env; decrypt; inject real OpenAI key; SSRF check
 -> forward to api.openai.com; stream response back down the same path
```

Git fetch:

```text
agent: git fetch (HTTPS)
 -> proxy -> <gateway>/<intConnId>/egress/https/github.com/<repo>.git/git-upload-pack
 -> gateway injects shared secret -> Worker egress -> git proxy layer
 -> branch validation + inject git credential -> GitHub; stream pack back
```

## Risks / Trade-offs

- **Gateway does not forward a verifiable sprite id** -> the multiplexed model
  fails; fall back to per-session connectors or per-session shared secrets. Confirm
  first (see Open Questions) — it gates the architecture.
- **Worker-custodied secrets** -> a Worker compromise exposes user + internal
  secrets. Mitigation: encryption at rest, minimal plaintext lifetime, rotation,
  and a Sprites-custodied per-connector option for high-sensitivity secrets.
- **SSRF via the egress route** -> allowlist destinations, block internal ranges,
  no internal redirects. Do not ship the arbitrary-URL egress without these.
- **Trust-store gaps** -> statically linked / pinned runtimes bypass the local CA.
  Enumerate and document; provide env overrides where possible.
- **nft/iptables staging fails** -> no transparent redirect, so egress isn't
  captured. Bundle the toolchain in the Sprite image; fail closed if absent.
- **Git read latency** -> the original blocker; measure the connector path before
  committing, and do not silently reintroduce revoke-after-clone.
- **Dashboard drift / allow-all default / dashboard-session expiry** -> preflight
  shape checks, verify `allow_all==false` after scope, provisioner-only auth with
  a clear reauth-required status. (Applies to the rare mint step.)
- **`allow_all` at create** is deny-all by default (verified), so the window risk
  is minimal; the scope step is a grant, still mandatory for function.

## Migration Plan

1. Confirm gateway-forwarded sprite identity (decides multiplexed vs per-session).
2. D1: `secrets`/connectors table (encrypted value, allowed hosts), environment
   links, connector metadata (both id spaces), provisioning attempts.
3. Sprite image: bundle/stage the nft/iptables toolchain; generalize the local
   proxy to a routing table with fail-closed default; CA install across runtimes.
4. Worker internal egress route: shared-secret authn, sprite->session resolution,
   D1 secret matching + injection, SSRF guards.
5. `mintConnector` (Browser Rendering) to create the internal egress connector;
   REST scope/verify/delete.
6. Cut webhook onto the egress path; retire the extractable webhook token.
7. Cut git (fetch + push) onto the egress path; keep branch validation; solve read
   latency without revoke-after-clone.
8. GitHub access (gh/MCP/skill) over the same path.
9. User-defined secrets: definition UI/API, D1 storage, environment linking,
   injection.
10. Make all of the above a synchronous, fail-closed provisioning step.

Rollback: keep the current token-based webhook/git path behind a flag until each
cutover is proven; disable the rare mint job without affecting running sessions.

## Open Questions

Blocking / architectural:

- **Does the Sprites gateway forward a verifiable Sprite identity to the upstream
  (our Worker)?** Decides multiplexed-single-connector vs per-session connectors.
- Is Worker-custody of user secrets acceptable for all secret classes, or do some
  require Sprites-custodied per-connector isolation?

Mechanics (several answerable with a quick live check using the Sprites token):

- Which id does `PATCH`/`GET`/delete `/v1/oauth/connections/{id}` take — the
  gateway connection id or the dashboard detail id? Confirm the delete verb/path.
- Does the connector gateway stream large/chunked bodies well enough for git pack
  data (the historical read-latency blocker)? Measure.
- Which Sprite runtimes ignore the system trust store, and how do we handle them?
- Git: keep the injected credential for the whole session (no revoke) now that it
  is non-extractable, or optimize proxy streaming — which meets read+write needs?
- GitHub: gh CLI vs MCP vs skill?
- Idempotency marker for connector create/D1 reconciliation.

Resolved:

- ~~REST update access policy?~~ Yes, `PATCH`/`PUT /v1/oauth/connections/{id}`.
- ~~REST create for Custom API?~~ No (preset providers only) — create stays on the
  browser path.
- ~~Create default access?~~ Deny-all (verified) — scope is a grant.
- ~~Can a Worker drive a browser?~~ Yes, via Cloudflare Browser Rendering.
- ~~Async connector-pending?~~ No — provisioning is synchronous and fail-closed.
