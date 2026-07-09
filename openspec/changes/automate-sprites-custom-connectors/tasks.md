## 0. Discovery (verified / to verify)

- [x] 0.1 Dashboard create flow, selectors, test-gates-create, two id spaces, deny-all default (spike 2026-07-06).
- [x] 0.2 REST `PATCH`/`PUT /v1/oauth/connections/{id}` sets `access_policy`; REST create only for preset providers.
- [x] 0.3 Gateway does NOT forward a verifiable Sprite identity upstream → per-session internal connector.
- [x] 0.4 Transparent egress proxy works (MITM, auth stripping, gateway rewrite/injection, REDIRECT captures curl/Node/Python).
- [x] 0.5 Sprite has passwordless sudo; `sudo apt-get install -y nftables iptables` works; NAT REDIRECT diverts live connections; `cap_net_admin`+`cap_sys_admin`.
- [x] 0.6 Network policy is enforced L3/L4 outside the VM (IP-direct to non-allowlisted hosts refused) — gateway-only is a hard boundary.
- [ ] 0.7 **Verify (live test):** can an in-VM root process change its own Sprite's Fly labels? Decides class-B scoping (labels vs per-session REST policy update).
- [ ] 0.8 Determine REST policy-update semantics (atomic Sprite-id add/remove vs whole-policy replace) → concurrency handling for shared connectors.
- [ ] 0.9 Read the current VM→Worker webhook callback auth precisely (git uses `gitProxySecret`; confirm webhook).
- [ ] 0.10 Confirm the provider-credential shape (API key vs OAuth, system vs user owned) before S4.
- [ ] 0.11 Which id do REST connection endpoints take (gateway conn id vs detail id); delete verb/path.
- [ ] 0.12 Measure per-session internal mint latency (Browser Rendering) and overlap with VM boot.

## 1. Connector provisioning (`mintConnector`) — cross-cutting

- [ ] 1.1 `mintConnector({...}) -> {gatewayConnectionId, detailId}`: browser create → REST scope → REST verify (`allow_all==false`) → delete-on-failure.
- [ ] 1.2 Run from the api-server Worker via Cloudflare Browser Rendering (`@cloudflare/playwright`, dashboard `storageState`); Fly.io Machine fallback; instrument latency.
- [ ] 1.3 Preflight dashboard shape/drift check before entering any secret; provisioner-only auth with reauth-required status; redact tokens/cookies/CSRF/storageState.
- [ ] 1.4 REST scope-update + delete + reconciliation; re-assert `allow_all==false` on tracked connectors.

## 2. Data model (D1) — cross-cutting

- [ ] 2.1 `session_connectors` (internal): session_id, gateway conn id, detail id, per-session secret (encrypted), status, timestamps.
- [ ] 2.2 `secrets` (class B, metadata only — Sprites custodies value): id, name, owner, upstream host(s), conn id + detail id, scoping mode, status.
- [ ] 2.3 `environment_secrets`: which environments/sessions are entitled to which secrets.
- [ ] 2.4 Zod schemas/types for connectors, secrets, entitlements, access-policy scopes, provisioning states.

## 3. Network egress policy — cross-cutting

- [ ] 3.1 Bootstrap policy (gateway + apt mirror + class-C allowlist) for provisioning; final policy (gateway + class-C + deny-all) before the agent runs.
- [ ] 3.2 Keep class-A/B credential hosts OUT of the network allowlist (forced through the proxy); reuse `network-policy.ts` allowlist as the class-C set + gateway.

## S1. Connector spine + webhook

- [ ] S1.1 Mint the internal per-session connector (base = Worker, token = per-session secret, scope = this Sprite) synchronously at provisioning; store in D1; fail closed.
- [ ] S1.2 Worker `/webhook` accepts only the gateway-injected per-session secret mapped to the session; Worker health `test_url` for the connector test.
- [ ] S1.3 Webhook cutover behind a flag; Worker stops accepting the Sprite-held webhook bearer; retire it once proven.
- [ ] S1.4 Teardown deletes the internal connector + per-session secret.

## S2. Git cutover

- [ ] S2.1 Route git through the internal connector; Worker git-proxy accepts ONLY the gateway-injected credential, not a Sprite-held bearer.
- [ ] S2.2 Preserve Worker-custodied installation token, `cloude/*` branch validation + lock, repo allowlist, `locked` policy.
- [ ] S2.3 Retire `gitProxySecret` bearer path behind a flag; measure read latency (no revoke-after-clone regression).

## S3. Transparent proxy data plane

- [ ] S3.1 Install nft/iptables at provisioning (`sudo apt-get`); OUTPUT REDIRECT of tcp/443 to the proxy; exclude gateway host/IPs; pin gateway IPs; fail closed.
- [ ] S3.2 Per-Sprite CA + per-host SNI leaf certs; install into system + per-runtime trust stores; enumerate/handle trust-store-bypassing runtimes.
- [ ] S3.3 Local resolver returning dummy IPs for proxied hosts (so redirect fires under gateway-only DNS refusal); class-C resolves normally.
- [ ] S3.4 Generalize `sprite-egress-proxy.mjs` to a routing table (host → connector | direct | block) with fail-closed default; strip client auth; stream bodies.
- [ ] S3.5 Route webhook/git through the proxy (replace direct connector-URL config); lifecycle (start at provision, tear down all of it at end).

## S4. Provider key as a class-B connector

- [ ] S4.1 Mint a class-B connector for the agent's provider credential (base = provider host, injects the real key); route the provider host through the proxy; remove the provider key from the Sprite.
- [ ] S4.2 Scope it per "Scoping class-B connectors" (labels or per-session REST policy update per §0.7/0.8).

## S5. User-defined secrets

- [ ] S5.1 Definition UI/API: users declare secrets (name, value, upstream host(s), environments).
- [ ] S5.2 Mint a per-secret class-B connector on definition (value → Sprites custody; store metadata only in D1).
- [ ] S5.3 At provisioning, add entitled secrets' hosts to the routing table and scope their connectors to the session Sprite; de-scope at teardown; handle concurrent-session churn.

## 6. Session provisioning (synchronous, fail-closed) — cross-cutting

- [ ] 6.1 Ordered flow: create Sprite + bootstrap policy → mint internal connector → scope entitled class-B connectors → install data plane → tighten to final policy → hand Sprite non-secret config → start agent. Fail closed on any step.
- [ ] 6.2 Teardown: delete internal connector + secret; de-scope shared connectors; tear down data plane.

## 7. Tests And Validation

- [ ] 7.1 Provisioner tests: shape/success detection, scope-verify, redaction, fail-closed on allow-all/verify failure.
- [ ] 7.2 D1 tests: connectors/secrets/entitlements lifecycle, teardown de-scoping, status transitions.
- [ ] 7.3 Data-plane tests: routing table, auth stripping, CA trust, resolver, gateway exclusion, fail-closed default.
- [ ] 7.4 Identity tests: off-Sprite replay rejected (webhook/git/user-secret); another Sprite denied.
- [ ] 7.5 Provisioning tests: synchronous fail-closed; teardown completeness.
- [ ] 7.6 `pnpm build`, `pnpm lint`, `pnpm typecheck`, relevant package tests.
