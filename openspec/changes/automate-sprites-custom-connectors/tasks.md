## 1. Discovery (mostly done)

- [x] 1.1 Capture the dashboard test success state and connector-detail transition (spike 2026-07-06: `bg-violet-50` + `hero-check-circle-mini` + "HTTP 200 — Connection OK"; two id spaces).
- [x] 1.2 Document dashboard selectors, `phx-*` events, field names, success states.
- [x] 1.3 Confirm access scoping is post-creation only; default is deny-all.
- [x] 1.4 Confirm REST: `PATCH`/`PUT /v1/oauth/connections/{id}` sets `access_policy`; REST create only covers preset providers.
- [x] 1.5 Confirm the Sprites gateway does NOT forward a verifiable Sprite identity → per-session connectors required.
- [x] 1.6 Confirm the transparent egress proxy works (MITM, auth stripping, gateway rewrite/injection, iptables REDIRECT captures curl/Node/Python; `CAP_NET_ADMIN` present).
- [x] 1.12 Re-test toolchain install (2026-07-08): Sprite user has passwordless `sudo`; `sudo apt-get install -y nftables iptables` works on Ubuntu 26.04; NAT REDIRECT diverts live connections; `cap_net_admin`+`cap_sys_admin` present. No R2 staging needed. Also revealed the agent has root → bypass concern (see 6.4).
- [ ] 1.7 Live-check which id the REST connection endpoints take (gateway connection id vs detail id) and the delete verb/path.
- [ ] 1.8 Confirm whether Sprite labels can be set at Sprite creation, or scoping must be by Sprite id after the Sprite exists.
- [ ] 1.9 Measure gateway streaming of large/chunked bodies for git pack data.
- [ ] 1.10 Enumerate Sprite runtimes that ignore the system trust store (static/pinned/Go roots) and decide handling.
- [ ] 1.11 Measure real per-session mint latency via Browser Rendering and overlap with VM boot.

## 2. Sprite-Side Transparent Proxy

- [ ] 2.1 Provide the nft/iptables toolchain: bake it into the Sprite image (preferred, avoids a per-boot apt round-trip) or `sudo apt-get install -y nftables iptables` at provisioning (verified to work via passwordless sudo); fail closed if rules can't be established.
- [ ] 2.2 Generate a per-Sprite CA and install into the system store + per-runtime stores (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, ...); per-host leaf certs via SNI.
- [ ] 2.3 Generalize `sprite-egress-proxy.mjs` from a single hardcoded target to a destination routing table (host → connector URL | pass-through | block) with a fail-closed default; strip client auth; forward query + stream bodies.
- [ ] 2.4 Install iptables/nft OUTPUT REDIRECT of tcp/443 to the proxy, EXCLUDING the gateway host/IPs (and localhost) so the proxy's own upstream calls aren't intercepted; pin gateway IPs at provisioning.
- [ ] 2.5 Proxy lifecycle: start at provisioning; rotate/expire CA + rules with the session; tear down (proxy, rules, CA) on session end.
- [ ] 2.6 Resolve the bypass problem: determine whether the session agent can run without sudo (separate privileged init owns the proxy/rules) or whether Fly can enforce egress at the VM boundary — otherwise the proxy is defense-in-depth only against an adversarial root agent.

## 3. Data Model (D1)

- [ ] 3.1 `session_connectors`: `session_id`, gateway connection id, dashboard detail id, provisioning status, access-policy summary, timestamps.
- [ ] 3.2 Per-session shared secret keyed to the session; encrypted at rest; deleted on teardown.
- [ ] 3.3 Zod schemas / internal types for connector metadata, auth method, access-policy scope, provisioning states.

## 4. Connector Provisioning (`mintConnector`)

- [ ] 4.1 Implement `mintConnector({...}) -> {gatewayConnectionId, detailId}`: browser create → REST `PATCH` scope (Sprite id/label, optionally `allowed_endpoints`) → REST GET verify (`allow_all == false`) → delete-on-failure.
- [ ] 4.2 Run from the api-server Worker via Cloudflare Browser Rendering (`@cloudflare/playwright`), injecting the dashboard `storageState`; Fly.io Machine fallback.
- [ ] 4.3 Preflight dashboard shape/drift check before entering any secret; provisioner-only auth with reauth-required status.
- [ ] 4.4 Redact tokens/cookies/CSRF/storageState from all logs; REST delete on teardown; reconcile orphans; re-assert `allow_all == false`.

## 5. Worker Endpoints

- [ ] 5.1 Health `test_url` that returns 200 only when the injected per-session secret validates (passes the dashboard connection test).
- [ ] 5.2 Internal `/webhook`: verify the injected per-session secret → session; accept the callback only then.
- [ ] 5.3 Internal `/git/...`: verify the secret → session; apply branch validation; inject the real git credential upstream.

## 6. Synchronous Provisioning

- [ ] 6.1 Generate the per-session secret, store it, mint+scope the connector, and install the proxy/CA/rules/routing — synchronously during session creation; fail the session closed on any failure.
- [ ] 6.2 Hand the Sprite only its connector gateway URLs and non-secret proxy config; overlap the mint with VM boot; measure.
- [ ] 6.3 Session teardown deletes the connector (REST) and the stored secret.

## 7. Webhook Cutover

- [ ] 7.1 Add a routing entry so the webhook host rewrites to this session's connector; Worker verifies the injected secret instead of a per-Sprite token.
- [ ] 7.2 Retire the extractable webhook token behind a flag once proven.

## 8. Git Cutover

- [ ] 8.1 Route git fetch (`info/refs`, `git-upload-pack`) and push (`git-receive-pack`) through the proxy → connector; inject the credential at the Worker.
- [ ] 8.2 Keep branch validation at the Worker git-proxy layer.
- [ ] 8.3 Solve read latency without revoke-after-clone (keep the injected credential for the session, and/or optimize proxy streaming); enable pull + push.

## 9. Tests And Validation

- [ ] 9.1 Egress-proxy tests: routing table, auth stripping, CA trust across runtimes, gateway exclusion, fail-closed default for unrouted destinations.
- [ ] 9.2 D1 tests: `session_connectors` lifecycle, per-session secret storage/teardown, status transitions.
- [ ] 9.3 Provisioner tests: shape/success detection, scope-verify, redaction, fail-closed on allow-all/verify failure.
- [ ] 9.4 Worker endpoint tests: injected-secret verification, webhook impersonation blocked, git pull + push, branch validation.
- [ ] 9.5 Provisioning tests: synchronous fail-closed behavior; teardown deletes connector + secret.
- [ ] 9.6 Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, and relevant package tests.

## 10. Future (not in v1)

- [ ] 10.1 User-defined secrets: definition UI/API, encrypted D1 storage (allowed hosts, environment links), Worker custody + injection, SSRF protection — added as more routing entries on the same proxy mechanism.
