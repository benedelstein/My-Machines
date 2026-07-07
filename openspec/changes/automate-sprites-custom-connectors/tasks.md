## 0. Blocking Architecture Check

- [ ] 0.1 Confirm whether the Sprites gateway forwards a verifiable Sprite identity to the upstream (our Worker). This decides multiplexed-single-connector vs per-session connectors and gates the rest of the design.

## 1. Discovery (mostly done)

- [x] 1.1 Capture the dashboard test success state and connector-detail transition (spike 2026-07-06: `bg-violet-50` + `hero-check-circle-mini` + "HTTP 200 — Connection OK"; two id spaces).
- [x] 1.2 Document dashboard selectors, `phx-*` events, field names, success states.
- [x] 1.3 Confirm access scoping is post-creation only; default is deny-all.
- [x] 1.4 Confirm REST endpoints: `PATCH`/`PUT /v1/oauth/connections/{id}` sets `access_policy`; REST create only covers preset providers.
- [x] 1.5 Confirm the transparent egress proxy works (header injection, query + POST body forwarding; iptables REDIRECT captures curl/Node/Python).
- [ ] 1.6 Confirm Sprite labels can be set at Sprite creation via the Sprites API and are live before first egress.
- [ ] 1.7 Live-check which id the REST connection endpoints take (gateway connection id vs detail id) and the delete verb/path.
- [ ] 1.8 Measure whether the gateway path streams large/chunked bodies well enough for git pack data (historical read-latency blocker).
- [ ] 1.9 Enumerate Sprite runtimes that ignore the system trust store (static-linked, pinned certs) and decide handling.

## 2. Data Model (D1)

- [ ] 2.1 `secrets`/connectors table: `id`, `name`, encrypted value, allowed hosts (multi-host), provider/auth shape.
- [ ] 2.2 Environment ↔ secret link (FK / join) so only linked environments can inject a secret.
- [ ] 2.3 Connector metadata: gateway connection id AND dashboard detail id, org, base URL, auth method, access-policy summary, provisioning status/attempts.
- [ ] 2.4 Encryption at rest + minimal-plaintext-lifetime handling; Zod schemas for secrets, auth methods, access-policy scopes, provisioning states.

## 3. Sprite-Side Transparent Proxy

- [ ] 3.1 Bundle/stage an nft/iptables toolchain into the Sprite image (it lacks one and cannot `apt-get`); fail closed if absent.
- [ ] 3.2 Generate a per-Sprite CA and install into the system store + per-runtime stores (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, ...).
- [ ] 3.3 Generalize `sprite-egress-proxy.mjs` from a single target to a destination routing table (host → gateway URL | pass-through | block) with a fail-closed default; strip client auth.
- [ ] 3.4 Install iptables/nft OUTPUT REDIRECT of tcp/443 to the proxy, excluding the gateway host and localhost so the proxy's own upstream calls aren't intercepted.
- [ ] 3.5 Lifecycle: start on provision, rotate/expire CA and rules with the session, tear down on session end.

## 4. Worker Internal Egress Route

- [ ] 4.1 Route behind the gateway-injected shared-secret check; reject anything without it; rotate the shared secret.
- [ ] 4.2 Resolve calling Sprite → session/environment from the gateway-forwarded sprite id.
- [ ] 4.3 Parse the requested destination from `/egress/…`, match a custodied secret for the session/environment, decrypt, inject the real header/rewrite, forward.
- [ ] 4.4 SSRF protection: host allowlist, block private/link-local/metadata ranges, no internal redirects, no internal error reflection.

## 5. Connector Provisioning (`mintConnector`)

- [ ] 5.1 Implement `mintConnector({...}) -> {gatewayConnectionId, detailId, policySummary}`: browser create → REST `PATCH` scope (label + `allowed_endpoints`) → REST GET verify (`allow_all == false`) → delete-on-failure.
- [ ] 5.2 Run it from the api-server Worker via Cloudflare Browser Rendering (`@cloudflare/playwright`), injecting the Sprites dashboard `storageState`; Fly.io Machine fallback.
- [ ] 5.3 Preflight dashboard shape/drift check (form id, `phx-*` events, field names, success markup) before entering any secret; provisioner-only auth with reauth-required status.
- [ ] 5.4 Create the internal egress connector (rare, off the session hot path); redact tokens/cookies/CSRF/storageState from logs.
- [ ] 5.5 REST delete + reconciliation, including re-asserting `allow_all == false` on tracked connectors.

## 6. Webhook Cutover

- [ ] 6.1 Route webhook callbacks through the egress path; Worker validates shared secret + sprite→session instead of a per-Sprite token.
- [ ] 6.2 Retire the extractable webhook token behind a flag once proven.

## 7. Git

- [ ] 7.1 Route git HTTPS (info/refs, git-upload-pack fetch, git-receive-pack push) through the egress path; inject credential at the Worker.
- [ ] 7.2 Keep branch validation at the Worker git-proxy layer.
- [ ] 7.3 Solve read latency without revoke-after-clone (keep injected credential for the session now that it's non-extractable, and/or optimize proxy streaming); enable pull + push.
- [ ] 7.4 GitHub access (gh CLI / MCP / skill) over the same path.

## 8. User-Defined Secrets

- [ ] 8.1 Definition UI/API for users to declare secrets (name, value, allowed hosts, environments).
- [ ] 8.2 Store encrypted in D1; inject at the Worker egress handler by destination host; never expose to the Sprite.

## 9. Synchronous Provisioning

- [ ] 9.1 Make proxy/CA/iptables/routing install + per-session secret setup a synchronous, fail-closed provisioning step; no async connector-pending.
- [ ] 9.2 Attach required Sprite labels before egress; block session start if any step fails.

## 10. Tests And Validation

- [ ] 10.1 Repo/D1 tests: secrets custody, environment linking, connector metadata (both ids), status transitions.
- [ ] 10.2 Provisioner tests: shape/success detection, scope-verify, redaction, fail-closed on allow-all/verify failure.
- [ ] 10.3 Egress-proxy tests: routing table, auth stripping, CA trust, fail-closed default, SSRF guards.
- [ ] 10.4 Webhook + git cutover tests (impersonation blocked, pull + push, branch validation, read latency).
- [ ] 10.5 Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, and relevant package tests.
