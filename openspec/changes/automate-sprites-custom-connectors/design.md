## Context

This designs the **Sprite secrets proxy** as one coherent system. It is a large,
multi-pronged change; the architecture below is whole, and the "Staging" section
sequences the *build* without splitting the *concept*. Nothing here is meant to be
redesigned later — the abstractions (connector taxonomy, routing table, D1 schema,
data/control planes) are chosen so every prong composes.

### The three prongs (all in scope)

1. **Caller-identity binding.** Every protected credential is authorized by the
   *verified identity of the calling Sprite*, not by possession of a bearer secret.
   Fly checks the connector's access policy against the calling Sprite before
   injecting the credential, so an extracted URL/secret cannot be replayed from a
   laptop, another org's Sprite, or after the session ends.
2. **Secrets out of the sandbox.** No credential — webhook, git, provider API key,
   or user-supplied secret — ever exists inside the Sprite. Fly injects it
   downstream of the Sprite.
3. **Arbitrary secret values via connectors + a transparent MITM proxy.** Users
   (and the system) can define arbitrary secrets (OpenAI, Slack, any custom API).
   A Sprite-local transparent proxy routes the Sprite's *unmodified* egress to the
   right connector, which injects the real secret. The agent calls normal URLs and
   never holds a key.

### Threat model

The session agent runs untrusted code **with root** (passwordless `sudo`, verified).
It can read anything in the Sprite, flush iptables, kill the proxy, read the local
CA key. The design must therefore make security independent of anything the Sprite
controls:

- **Prevented:** off-Sprite replay of any credential (prong 1, via Fly identity
  checks); extraction of any real secret (prong 2, secrets never in the Sprite);
  exfiltration to arbitrary hosts (network egress policy, enforced outside the VM at
  L3/L4 — verified).
- **Not prevented (accepted, and true of any design):** a *live* compromised Sprite
  using the connectors it is legitimately authorized for (e.g. spending the user's
  own OpenAI budget during the session); and runtimes that bypass the local CA
  (contained by the network policy, which still blocks their real egress).

### What already exists (build on it, don't reinvent)

- `network-policy.ts` — `buildFinalNetworkPolicy` with a `locked` mode (Worker +
  provider + `deny-all`). The Sprites network policy is enforced outside the VM at
  **L3/L4** (verified: IP-direct `connect()` to non-allowlisted hosts is refused).
- `GitProxyService` — Sprite calls `WORKER_URL/git-proxy/:sessionId/...` with a
  per-session `gitProxySecret` written into git config as
  `Authorization: Bearer <secret>`; the Worker mints the GitHub installation token
  and injects it only when forwarding to GitHub. Push branch validation
  (`cloude/*` + session suffix + branch lock) and repo allowlist are enforced.
- `session-provision.service.ts` — `cloneRepo`, git remote setup, and a
  `plainEnvVars` path (the very name implies the missing *secret* env path this
  change provides).

The gap: everything is authenticated by **bearer secrets in the Sprite** (git today;
webhook and provider auth on the same footing), which are replayable and extractable.
No transparent proxy exists, and there is no path for arbitrary user secrets.

## The unified model

Classify every outbound flow, and route each class exactly one way:

| Class | Examples | Path |
|---|---|---|
| A. Credential → our Worker | webhook, git | Sprite → transparent proxy → **internal per-session connector** → our Worker (injects per-session secret) |
| B. Credential → external upstream | provider API key, user secrets (OpenAI, Slack, custom) | Sprite → transparent proxy → **per-secret connector** → upstream (injects the real secret, Sprites-custodied) |
| C. No credential | npm, pypi, github raw, apt, etc. | network-allowlisted, **direct** egress (no connector) |
| D. Everything else | arbitrary hosts | **denied** by the network policy |

A connector is the single primitive for A and B: **Fly verifies Sprite identity →
injects the secret → forwards.** That delivers prongs 1 and 2 uniformly. The
transparent proxy is the routing layer that makes classes A and B work for
*unmodified* agent code (prong 3), and the network policy makes C/D a hard boundary.

## Connector taxonomy

Two kinds of connector, differing in lifetime, what they inject, and who custodies
the secret:

### Internal connector (class A) — per session

- **Lifetime:** one per session, minted at provisioning, deleted at teardown.
- **Base URL:** our Worker (`WORKER_URL`), path-routed so one connector serves both
  `/webhook` and `/git/...` (the gateway forwards `base + <path after conn id>`).
- **Injected secret:** a **per-session secret** the Worker stores in D1 keyed to the
  session. This is how the *Worker identifies which session* (the gateway does not
  forward Sprite identity to the upstream — tested). Fly still does the identity
  *authorization*; the secret only does session *identification*.
- **Scope:** the session's Sprite (id). Only that Sprite can invoke it.

### Credential connectors (class B) — per secret

- **Lifetime:** one per secret value, long-lived, minted when the secret is defined
  (provider key at setup; a user secret when the user adds it), reused across all
  the owner's sessions. **Not** per session — that would mean a browser mint per
  secret per session.
- **Base URL:** the real upstream host (e.g. `api.openai.com`).
- **Injected secret:** the **real credential**, custodied by **Sprites** (we pass it
  once at connector creation and never store plaintext).
- **Scope:** only the Sprites entitled to that secret. See "Scoping class-B
  connectors" — this is the crux of keeping them identity-bound while long-lived.

## Scoping class-B connectors to the right Sprites

A credential connector is long-lived but must be usable only by Sprites entitled to
that secret (the owning user's / environment's session Sprites). Two mechanisms;
**decide by the label-immutability test below.**

- **Primary — per-session REST policy update (robust, no browser).** At session
  start, `PATCH /v1/oauth/connections/{id}` to add this session's **Sprite id** to
  the connector's access policy; remove it at teardown. Exact per-Sprite scoping,
  fast (REST, not browser), independent of label behavior. Cost: a PATCH per session
  per entitled secret, and **concurrency care** — concurrent sessions editing the
  same connector's allowed-Sprite list race on read-modify-write; need atomic
  add/remove or per-connector serialization (open question: does the REST policy API
  support atomic list add/remove, or only whole-policy replace?).
- **Alternative — label scoping (simpler, if labels are in-VM-immutable).** Give
  the connector a policy `sprite_labels: [entitlement]` once; set that label on
  entitled Sprites at creation. No per-session PATCH. **Only safe if an in-VM root
  process cannot change its own Sprite's Fly labels** — otherwise a compromised
  Sprite adds another secret's label and steals it. **Must verify** (a live test,
  like the network-policy test); if in-VM labels are immutable, prefer this.

Either way, entitlement (which secrets a session may use) is decided server-side
from the session's environment; the Sprite never asserts its own entitlement.

## Data plane: the transparent proxy (with every complication)

Provisioned into each Sprite; all non-secret. Generalizes the proven
`sprite-egress-proxy.mjs` from a single hardcoded target to a routing table.

1. **Redirect (iptables/nft).** OUTPUT NAT REDIRECT of outbound `tcp dport 443` to
   the local proxy. Install at provisioning via `sudo apt-get install -y nftables
   iptables` (verified: passwordless sudo, `cap_net_admin`+`cap_sys_admin`, rules
   divert live connections). The base image is fixed upstream — cannot be baked; the
   network policy must allow the apt mirror during install (or install before
   locking down). Fail closed if rules can't be applied.
2. **Local CA + trust.** Per-Sprite CA; per-host SNI leaf certs. Install into the
   system store (`update-ca-certificates`) and per-runtime stores
   (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, ...). Rotate/expire
   with the session. **Complication — trust-store gaps:** statically linked / Go-root
   / cert-pinned runtimes reject the MITM; enumerate and handle, document unsupported
   cases. The network policy backstops (their real egress is denied). Pre-trust the
   MITM is correctly rejected (fail-closed).
3. **Local resolver.** Under a gateway-only policy the platform **refuses DNS** for
   non-allowlisted hosts (verified), so an unmodified client can't resolve
   `api.openai.com` to open the connection the redirect would catch. Run a local
   resolver (`127.0.0.1`) that answers **proxied** hosts with a dummy IP; the
   redirect catches the connection regardless of address, and the L3/L4 policy still
   blocks any real egress if the proxy is bypassed. Class-C hosts resolve normally
   (or are allowlisted) and egress directly.
4. **Rewrite + route.** The proxy reads the request (SNI = intended host), strips the
   client `authorization`, and consults the **routing table**: host → { class-A/B
   connector gateway URL | class-C pass-through | block }. It rewrites class-A/B to
   `<gateway>/<connId>/<path>?<query>`. Fly injects the real secret and forwards.
   **Fail-closed default:** unrouted → block, never forward with a secret.
5. **Gateway exclusion.** The proxy's own calls to the gateway (`api.sprites.dev`)
   must not be redirected (loop) or DNS-blocked. Pin gateway IPs at provisioning;
   `NO_PROXY` for the explicit-proxy path.
6. **Lifecycle.** Start before the agent runs; tear down proxy, rules, CA, resolver,
   and the internal connector + per-session secret at session end.

## Control plane: network egress policy (the hard boundary)

`POST /v1/sprites/{name}/policy/network`, enforced outside the VM at L3/L4 (verified;
in-VM root cannot lift it). Policy = **allow the connector gateway + the class-C
non-secret allowlist (package managers, distro mirrors, etc.) + `deny-all`.**

- Class-A/B credential hosts are **not** network-allowlisted — they are forced
  through the proxy → connector. (If they were allowlisted, a root agent could reach
  them directly after flushing the redirect.)
- The existing `network-policy.ts` allowlist is the class-C set; extend/trim it, and
  add the gateway. Provisioning needs the apt mirror allowed during toolchain
  install, then tighten.

## Connector provisioning (`mintConnector`)

Sprites has **no REST create** for Custom API connectors (Fly confirmed;
`/api_key` only takes preset `provider`+`api_key`), so creation is browser-driven.
One primitive:

```text
mintConnector({ baseApiUrl, token, authMethod='header', headerPrefix='Bearer',
                testUrl, scope }) -> { gatewayConnectionId, detailId }
```

- **Create (browser)** — proven by the 2026-07-06 spike: form `custom-api-form`,
  test (`test_custom_api`) gates create (`HTTP 200 — Connection OK` state), create
  redirects to the **gateway connection id**; the dashboard detail page uses a
  separate **detail id** (store both).
- **Scope + verify (REST)** — create defaults to **deny-all** (verified), so a new
  connector is inert until scoped. `PATCH /v1/oauth/connections/{id}` access policy;
  GET to confirm; optionally `allowed_endpoints` to pin the path.
- **Fail closed** — on any failure, REST-delete the partial connector and throw.
- **Host:** Cloudflare **Browser Rendering** from the api-server Worker
  (`@cloudflare/playwright`, dashboard `storageState` injected per run; verified paid
  limits 120 concurrent / 1-create-per-sec / 60s idle→10min keep_alive). **Switch to
  a Fly.io Machine if measured mint latency is too high** — instrument from day one.

Who mints what: the **internal connector** is minted per session (its secret is
per-session). **Class-B connectors** are minted per secret at definition time
(provider key at setup; user secret when added), then their access policy is updated
per session per "Scoping class-B connectors."

## Session provisioning (synchronous, fail-closed)

The connector URLs *are* the Sprite's egress paths, so provisioning is synchronous;
any failure fails the session closed (no Sprite ever runs with a secret in the
clear, an un-redirected egress, or an unusable callback path). Ordered:

1. Create the Sprite; apply a **bootstrap** network policy that allows the gateway
   + apt mirror (for toolchain install) + class-C allowlist.
2. Generate the per-session secret; **mint the internal connector** (base = Worker,
   token = per-session secret, scope = this Sprite); store both ids + secret in D1.
3. Determine the session's entitled class-B secrets from its environment; **scope
   their connectors to this Sprite** (REST policy update, or set entitlement labels
   at Sprite create).
4. Install the data plane: toolchain, local CA + trust, local resolver, transparent
   proxy + **routing table** (webhook/git → internal connector; each entitled secret
   host → its class-B connector; class-C → direct; else block), redirect rules,
   gateway exclusion.
5. Tighten to the **final** network policy (gateway + class-C + deny-all).
6. Hand the Sprite only non-secret config (its connector gateway base + routing);
   start the agent.
7. Teardown: delete the internal connector + per-session secret; remove this Sprite
   from class-B connector policies; tear down the data plane.

## Cutovers (close the replayable paths)

For each of webhook and git, the Worker endpoint must **stop accepting a
Sprite-held bearer** and require the **gateway-injected** credential (which the
Sprite never possesses). Leaving the raw `WORKER_URL/...` endpoint accepting a
Sprite-carried token keeps the replay hole open. Do each behind a flag; keep the old
path until the connector path is proven, then remove it.

- **Webhook (priority):** today a bearer lets anyone POST fake agent responses into
  the user's chat log from any host. Route through the internal connector; accept
  only the gateway-injected per-session secret mapped to the session.
- **Git:** preserve Worker-custodied installation token, `cloude/*` branch
  validation + lock, repo allowlist, `locked` policy; change only how the
  Sprite→Worker call is authenticated (identity-bound, not bearer).

## Data model (D1)

- `session_connectors` — internal connectors: `session_id`, gateway connection id,
  dashboard detail id, per-session secret (encrypted), status, timestamps.
- `secrets` — class-B secret metadata (NOT plaintext; Sprites custodies the value):
  `id`, `name`, owner (user/system), upstream host(s), connector gateway id + detail
  id, scoping mode (label vs sprite-id list), status.
- `environment_secrets` — which environments/sessions are entitled to which secrets
  (drives routing-table + scoping at provisioning).

## Data flows

```text
Webhook (class A):
  agent POST https://<webhook-host>/... (no secret)
   -> resolver(dummy IP) -> iptables REDIRECT -> local proxy (MITM, strip auth)
   -> <gateway>/<internalConnId>/webhook/... ; Fly verifies THIS sprite; injects
      per-session secret -> Worker: secret->session; accept callback

Git (class A): same path -> /git/... -> Worker git-proxy: verify->session;
   branch validation; inject installation token -> GitHub; stream pack back

User secret, e.g. OpenAI (class B):
  agent GET https://api.openai.com/v1/... (no/dummy key)
   -> resolver(dummy IP) -> REDIRECT -> proxy (MITM, strip auth)
   -> <gateway>/<openaiConnId>/v1/... ; Fly verifies this sprite is entitled;
      injects the user's real OpenAI key -> api.openai.com; stream back

Package manager (class C): agent -> npm/pypi/... resolves + egresses directly
   (network-allowlisted; no connector)

Anything else (class D): proxy has no route AND policy denies -> blocked
```

## Staging (build order; each stage is a real subset, none undone later)

The whole concept ships across stages that share one data model, one connector
abstraction, and one proxy — so no stage requires redesigning another.

- **S1 — connector spine + webhook.** `mintConnector` (Browser Rendering) + internal
  per-session connector + `session_connectors` D1 + webhook cutover. Proves
  identity-bound class-A end to end.
- **S2 — git cutover.** Move git onto the internal connector; Worker rejects the
  bearer. No new mechanism.
- **S3 — transparent proxy data plane.** Toolchain, CA/trust, resolver, routing
  table, redirect, gateway exclusion. Route webhook/git through it (replacing direct
  connector-URL config). Enables class B.
- **S4 — provider key as a class-B connector.** Move the agent's provider
  credential (Anthropic/OpenAI) off the Sprite onto a class-B connector via the
  proxy. Exercises class-B scoping with one system-owned secret.
- **S5 — user-defined secrets.** `secrets` + `environment_secrets` D1, definition
  UI/API, per-secret connector mint, routing-table + scoping wiring. General class B.

## Risks / Open questions

- **Class-B scoping mechanism** — is an in-VM root process able to change its own
  Sprite's Fly labels? (Decides label-scoping vs per-session REST policy update.)
  **Verify with a live test.**
- **REST policy update semantics** — atomic add/remove of a Sprite id, or whole
  policy replace? Drives the concurrency handling for class-B scoping under
  concurrent sessions.
- **Per-session internal mint latency** — browser mint on the session critical path;
  minimize + overlap with VM boot; measure; Browser Rendering vs Fly by the number.
- **Trust-store gaps** — enumerate the runtimes the agent uses that bypass the system
  CA; document handling; rely on the network policy as backstop.
- **Provider-credential shape** — is the agent's provider auth an API key or OAuth,
  system- or user-owned, and does it survive being injected at a connector (vs
  needing an interactive OAuth flow)? Confirm before S4.
- **Current webhook callback auth** — confirm exactly how the VM authenticates
  callbacks today (git uses `gitProxySecret`; webhook path to be read) so the cutover
  is precise.
- **git read latency** — the connector/proxy path for chunked pulls; measure; don't
  reintroduce revoke-after-clone.
- **Concurrent-session label/policy churn on shared class-B connectors** — teardown
  ordering so one session ending doesn't revoke another's access.

## Resolved (verified)

- Gateway forwards a verifiable Sprite identity to the upstream? **No (tested)** →
  per-session internal connector; per-session secret does session identification,
  Fly does authorization.
- Network policy enforcement: **L3/L4, not DNS-only (tested)** → gateway-only is a
  hard boundary; in-VM root can't exfil by IP.
- Sprite can install nft/iptables? **Yes** — passwordless sudo; install at
  provisioning (base image fixed).
- Custom API connector REST create? **No** — dashboard-only; REST does
  scope/verify/delete (`PATCH/GET/DELETE /v1/oauth/connections/{id}`).
- Create default access? **Deny-all** — scope is a grant.
- Can a Worker drive a browser? **Yes** — Cloudflare Browser Rendering (Fly fallback).
- Async provisioning? **No** — synchronous, fail-closed.
- User secrets / transparent proxy in scope? **Yes, both** — part of the coherent
  whole; sequenced in Staging, not deferred in concept.
