## 0. Discovery (verified / to verify)

- [x] 0.1 Dashboard create flow, selectors, test-gates-create, two id spaces, deny-all default (spike 2026-07-06).
- [x] 0.2 REST `PATCH`/`PUT /v1/oauth/connections/{id}` sets `access_policy`; REST create only for preset providers.
- [x] 0.3 Gateway does NOT forward a verifiable Sprite identity upstream → per-session internal connector.
- [x] 0.4 Transparent egress proxy works (MITM, auth stripping, gateway rewrite/injection, REDIRECT captures curl/Node/Python).
- [x] 0.5 Sprite has passwordless sudo; `sudo apt-get install -y nftables iptables` works; NAT REDIRECT diverts live connections; `cap_net_admin`+`cap_sys_admin`.
- [x] 0.6 Network policy is enforced L3/L4 outside the VM (IP-direct to non-allowlisted hosts refused) — restricted modes have a hard boundary that in-VM root cannot lift; `open` intentionally does not.
- [x] 0.7 In-VM root cannot change its own Sprite's Fly labels; the Sprites API can set labels at creation or update them afterward → label scoping is safe.
- [x] 0.8 Access policy has NO Sprite-id field (`sprite_labels`/`name_prefix` only); policy update is whole-object replacement → scope by label, set once at mint, never edit per session (no concurrency race).
- [x] 0.9 Current webhook auth: VM posts to `/internal/session/:sessionId/chunks` and `/events` with `DO_WEBHOOK_TOKEN`; the Worker resolves the DO by route and the DO validates its SQLite `webhook_token`.
- [x] 0.10a Claude: user-owned refreshable OAuth remains in encrypted D1; live test proved Claude Code 2.1.207 interactive and non-interactive inference works with `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` while the Worker refreshes/injects OAuth downstream. A fake OAuth file does not bypass interactive login, and the Worker must add `oauth-2025-04-20` in gateway mode (`test:live:claude-oauth-control-plane-proxy`, 2026-07-23; see `provider-proxying.md`).
- [x] 0.10b Codex: Codex 0.144.3 completed `gpt-5.4` inference from a fresh Sprite through `webhooks.bze.llc` using a custom Responses provider and short-lived Cloude bearer. A native reqwest proxy validated the bearer, injected D1 OAuth + `ChatGPT-Account-ID`, stripped tunnel/proxy headers, and streamed the response. A manual follow-up launched the normal interactive TUI without `auth.json`. The same fresh request through local workerd received a ChatGPT-edge HTML `403`, while Node's ordinary native `fetch` succeeded. A same-machine transport probe isolated unavoidable `CF-Worker` metadata and a different TLS fingerprint as concrete differences, but the exact WAF rule is not observable (`test:live:codex-oauth-control-plane-proxy`, 2026-07-23).
- [x] 0.11 REST connection endpoints take the **gateway connection id**; delete is `DELETE /v1/oauth/connections/{id}` (proven by the passing disposable live test, 2026-07-24).
- [x] 0.12 End-to-end disposable mint on Browser Rendering: **6.9s total** (launch 1.5s, preflight 2.0s, connection test 0.6s, create 0.9s, REST scope+verify+cleanup ~1.2s) — comfortably inside VM-boot overlap; wire the actual overlap in section 6. Note: the dashboard form drifted between 2026-07-06 and 2026-07-24 (`auth_method` hidden input → `set_custom_api_auth_method` toggle buttons; events renamed `validate_custom_api`/`submit_custom_api`; submit button "Create Connection" → "Add connector"). The drift gate caught it before any secret entry; shape contract updated.

## 1. Connector provisioning (`mintConnector`) — cross-cutting

- [x] 1.1 `mintConnector({...}) -> {gatewayConnectionId, detailId?}`: browser create → REST list + lookup-by-unique-name for the authoritative gateway id → REST scope → REST verify (`allow_all==false`) → delete-on-failure. (List-before diffing removed 2026-07-25; the per-attempt unique name is the attribution key.)
- [ ] 1.2 Run in a dedicated private Cloudflare Worker via Browser Rendering (`@cloudflare/playwright`, dashboard `storageState`); call it from the api-server through a service binding when integrated; Fly.io Machine fallback; instrument latency.
- [x] 1.3 Preflight dashboard shape/drift check before entering any secret; provisioner-only auth with reauth-required status; redact tokens/cookies/CSRF/storageState.
- [ ] 1.4 REST scope-update + delete + reconciliation; re-assert `allow_all==false` on tracked connectors. Reconciliation must also re-verify the external deny-all-on-create invariant the orphan-leak safety argument depends on (2026-07-25 review). Verify whether `GET /v1/oauth/connections` paginates; with unique per-attempt names, replace list-diff attribution with definitive lookup-by-name that pages until found.
- [x] 1.5 Verify label immutability from a root shell inside a Sprite (2026-07-26, disposable `hostile-root-test-7f3a9c`): no injected control-plane credential; root CLI label mutation failed with no organization configured; direct management `PUT`/`PATCH` and child-Sprite creation returned 401; the internal API exposed no label mutation path; external read-back preserved `security-test:baseline-7f3a9c`; Sprite deleted.
- [ ] 1.5a Land Sprite labeling and connector label enforcement in the same integration change, not sequentially.
- [ ] 1.6 Endpoint pinning: the provisioner accepts `allowedEndpoints`, verifies it on read-back, and requires it for class-A `session:` connectors only (2026-07-26). Class-B environment connectors may intentionally authorize their full upstream origin. Wire format verified against the live Sprites API the same day: `allowed_endpoints: ["/headers"]` accepted on PATCH and returned verbatim on GET (disposable live test, 14.2s total). Remaining: verify the gateway actually blocks an off-pin Worker path from a labelled Sprite once labeling lands (needs an in-VM test; pairs with 1.5a).
- [ ] 1.7 Before session integration: front the provisioner with the api-server service binding (removes the bearer from the network path) and add rate limiting on `/mint` (remote-browser spend + real credential creation must not be unbounded under a leaked bearer).

## 2. Data model (D1) — cross-cutting

- [ ] 2.1 `session_connectors` (internal): session_id, gateway conn id, detail id, policy summary, status, timestamps. Keep the webhook token in DO SQLite, not D1.
- [ ] 2.2 `environment_connectors` (class B, metadata only — Sprites custodies value): id, environment_id, name, upstream origin, header name/prefix, conn id + detail id, label `env:<environmentId>`, lifecycle status, timestamps; unique per environment + hostname. Statuses cover provisioning, active, replacement-pending, pending-revocation, and error so the deletion id is never lost.
- [ ] 2.3 Query environment connector metadata before Sprite creation to build labels and the routing table; never store plaintext or session membership.
- [ ] 2.4 Zod schemas/types for session connectors, environment connectors, access-policy scopes, and provisioning states.

## 3. Network egress policy — cross-cutting

- [ ] 3.1 Preserve `buildFinalNetworkPolicy` semantics for `open`, `default`, `custom`, and `locked`; add connector-gateway reachability to restricted modes. Apply only the temporary provisioning exceptions needed for toolchain install, then the user's selected final policy before the agent runs.
- [ ] 3.2 In restricted modes, do not add class-A/B credential hosts merely because a connector exists; preserve any host already allowed by the selected default/custom policy. Provider CLIs use their session connector gateway path directly. Test that direct access never receives a connector credential, including under `open`.

## S1. Connector spine + webhook

- [ ] S1.1 Create the Sprite with `session:<sessionId>` and `env:<environmentId>` labels, then mint the internal connector (base = Worker, token = existing DO webhook token, policy = session label); store connector metadata in D1 and fail closed. The provisioner enforces per-attempt name uniqueness (appends a random suffix), making name attribution definitive across concurrent duplicate mints; store the returned `name` alongside the ids (2026-07-25).
- [ ] S1.2 Preserve `/internal/session/:sessionId/chunks` and `/events`; the route resolves the DO and the DO validates the gateway-injected token from SQLite. Add a connector health `test_url` without introducing a generic `/webhook` or D1 secret mapping.
- [ ] S1.3 Give the VM the connector gateway base instead of `DO_WEBHOOK_TOKEN`; cut over behind a flag and retire Sprite-held webhook-token delivery once proven.
- [ ] S1.4 Teardown deletes the internal connector and DO webhook token. It does not edit class-B policies.

## S2. Git cutover

- [ ] S2.1 Route post-clone fetch/push through the internal connector; Worker git-proxy accepts ONLY the gateway-injected credential, not a Sprite-held bearer. Preserve the existing per-request repository-access check: connector/session identity authenticates the caller but does not authorize repository access.
- [ ] S2.2 Preserve Worker-custodied installation token, `cloude/*` branch validation + lock, repo allowlist, `locked` policy.
- [ ] S2.3 Keep initial clone on the existing direct GitHub path with its short-lived contents-read-only token; retire `gitProxySecret` for later fetch/push behind a flag and measure post-clone read latency.

## S3. Transparent proxy data plane

- [ ] S3.1 Install nft/iptables at provisioning (`sudo apt-get`); OUTPUT REDIRECT only dummy-destination tcp/443 to the proxy; class-C and gateway real destinations bypass it; fail closed.
- [ ] S3.2 Per-Sprite CA + per-host SNI leaf certs; install into system + per-runtime trust stores; enumerate/handle trust-store-bypassing runtimes.
- [ ] S3.3 Local resolver returns a reserved dummy IPv4 address and suppresses AAAA for class-B hosts; class-C and gateway hosts resolve normally.
- [ ] S3.4 Generalize `sprite-egress-proxy.mjs` to one connector per protected hostname with fail-closed default; strip the configured client credential header and stream bodies. Class-C never enters the proxy.
- [ ] S3.5 Webhook/git/provider stay on direct gateway-URL config permanently (class A never enters the proxy). Install the data plane only for environments with class-B credentials; lifecycle (start at provision, tear down all of it at end).
- [ ] S3.6 V1 protocol contract: advertise HTTP/1.1, support streaming and required HTTP/1.1 WebSocket upgrades; reject/document HTTP/2-only, gRPC, HTTP/3, alternate ports, non-header auth, and multiple credentials per hostname.

## S4. Provider inference through the control plane

- [ ] S4.0 Production prerequisite tracked in a separate AI-auth change: serialize or optimistic-version provider refresh per user/provider, and test concurrent sessions plus refresh-token rotation. The race already exists when multiple sessions start fresh processes; S4 must not amplify it in production.
- [x] S4.1a Claude compatibility spike: local Worker reads/refreshes OAuth from D1, overwrites the Sprite's non-provider bearer, adds `oauth-2025-04-20`, streams Anthropic inference, and rejects an invalid gateway token.
- [x] S4.1b Codex base compatibility spike: custom Responses provider + short-lived non-provider bearer in a fresh Sprite, authenticated native reqwest egress, D1 OAuth + account-ID injection, tunnel-header stripping, streamed `gpt-5.4` inference, invalid-bearer rejection, and normal interactive TUI startup without `auth.json`.
- [ ] S4.1c Deploy one shared stateless native egress shim and prove `Worker -> authenticated native shim -> ChatGPT` on ordinary VM/container egress. The Worker retains D1 lookup and live OAuth refresh/revocation; test `/models` if required, text/tools/long responses, interruption/retry, compaction, errors, concurrency/capacity, and feature degradation.
- [ ] S4.2 Extend class-A routing with `/internal/session/:sessionId/inference/{claude|codex}/...`; validate the existing connector-injected session credential through the DO, resolve the authenticated session user, and use the existing encrypted provider record. Add no provider connector, owner label, or connector table.
- [ ] S4.3 Final class-A connector spike: configure Claude and Codex base URLs with the session connector's provider path and use literal placeholders; prove Fly rejects other Sprites/off-Sprite callers and the Worker receives only unambiguous connector-injected session authority. If `Authorization` is not overwritten cleanly, validate a separate injected header such as `X-Cloude-Session-Token`.
- [ ] S4.4 Provider inference routes: refresh the session user's D1 OAuth record, replace client authorization, inject required provider headers (Claude `oauth-2025-04-20`; Codex `ChatGPT-Account-ID`), preserve streaming, restrict provider paths, strip tunnel/proxy metadata, and redact request credentials/bodies. Claude egresses from the Worker; Codex delegates only its rebuilt final request to the authenticated native shim.
- [ ] S4.5 Claude acceptance: interactive + `-p`, placeholder-only Sprite inspection, streamed text/tools/long responses, interruption/resume, errors, compaction, path allowlist, OAuth refresh/revocation, and documented custom-base feature limitations.

## S5. Environment header credentials

- [ ] S5.0 Live-test the dashboard's `Custom header` mode and record selectors/wire shape before accepting arbitrary header names. Until it passes, the implemented provisioner contract remains `Authorization` only.
- [ ] S5.0a Verify Sprites rejects connector targets that resolve/rebind to loopback, link-local, private, metadata, or reserved ranges and never forwards an injected credential across an origin-changing redirect. If not, implement resolved-address and redirect enforcement before exposing user-defined origins; dashboard test success alone is not the safety check.
- [ ] S5.1 Definition UI/API: an environment declares one header credential (name, value, public HTTPS upstream origin, header name/prefix) per hostname, with optional endpoint restrictions.
- [ ] S5.2 Mint a class-B connector for the environment + hostname (value → Sprites custody; store metadata only in D1) with immutable `sprite_labels: [env:<environmentId>]`.
- [ ] S5.3 At provisioning, put `env:<environmentId>` on the Sprite and add the environment's connector hosts to the routing table. Never edit or de-scope the connector policy per session.
- [ ] S5.4 Environment/credential deletion revokes the affected class-B connector independently: stop resolving it for new sessions, confirm connector deletion or verified deny-all before removing metadata, and retain a pending-revocation record for reconciliation on partial failure. Repository-access blocking does not remove `env:` labels, revoke the session token, or delete the Sprite.
- [ ] S5.5 Edit/rotation uses replacement, not in-place secret mutation: mint/scope/verify a new connector, atomically swap the active D1 id, refresh active sessions' non-secret routes where possible, and revoke the old id. A stale active-session route fails closed until refreshed/restarted; never retain the old credential solely for continuity.

## 6. Session provisioning (synchronous, fail-closed) — cross-cutting

- [ ] 6.1 Ordered flow: resolve environment connectors → create labelled Sprite + temporary bootstrap policy → mint/verify session connector → install data plane → apply the user's selected final network mode + gateway reachability → hand Sprite non-secret config → start agent. Fail closed on protected-route setup without changing `open`/`default`/`custom`/`locked` semantics.
- [ ] 6.2 Teardown: delete internal connector + DO token, data plane, and Sprite. Never edit shared class-B connector policies.

## 7. Tests And Validation

- [x] 7.1 Provisioner tests: shape/success detection, scope-verify, redaction, fail-closed on allow-all/verify failure.
- [ ] 7.2 D1 tests: session/environment connector metadata lifecycle, environment+hostname uniqueness, immutable class-B policy, create cleanup, replacement ordering, active-session stale-route behavior, environment/credential revocation with partial-failure reconciliation, status transitions, and no provider-specific connector lifecycle.
- [ ] 7.3 Data-plane tests: routing table, configured-header stripping, CA trust, dummy resolver, targeted redirect, class-C/gateway bypass, fail-closed default.
- [ ] 7.4 Identity tests: off-Sprite replay rejected (webhook/post-clone git/environment credential); another Sprite denied.
- [ ] 7.5 Provisioning tests: create/update label wrapper, class-A session-label authorization, class-B environment-label authorization, synchronous fail-closed, teardown without class-B policy mutation.
- [ ] 7.5a Authorization-lifecycle tests: repository blocking still rejects new turns and every Git/PR request while preserving the Sprite/session/environment authorities; environment or credential deletion makes its class-B connector unusable without deleting unrelated sessions.
- [ ] 7.5b Network-mode tests: connectors work in `open`, `default`, `custom`, and `locked`; each mode preserves its prior direct-egress semantics; direct upstream access never gains the connector credential.
- [x] 7.6 `pnpm build`, `pnpm lint`, `pnpm typecheck`, relevant package tests.
