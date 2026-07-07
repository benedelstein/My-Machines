## 1. Discovery And Trace Capture

- [x] 1.1 Capture the successful test diff and connector-detail URL transition using only dummy credentials. (Live spike 2026-07-06: `bg-violet-50` + `hero-check-circle-mini` + "HTTP 200 — Connection OK"; create redirects to the gateway connection id; detail page uses a separate detail id.)
- [x] 1.2 Document the required dashboard selectors, `phx-*` attributes, field names, validated form frame shape, success states, and resulting connector-detail URL shape. (See design.md "Verified dashboard automation".)
- [x] 1.3 Verify whether access policy by Sprite id and Sprite tag is configurable during creation or only after creation. (Post-creation only, via `save_access_policy`: `name_prefix`, `policy_label` labels, `allow_all`. Create has no scoping input and defaults to `allow_all = true`.)
- [x] 1.4 Verify which supported Sprites REST endpoints can list, fetch, update access policy, and delete Custom API connections. (Docs confirm `PATCH`/`PUT /v1/oauth/connections/{id}` with `access_policy`; REST create only for preset providers. Delete verb and the `{id}` scheme still to confirm live — see 1.7.)
- [ ] 1.7 Live-check with the Sprites token which id `PATCH`/`GET`/delete `/v1/oauth/connections/{id}` accepts — gateway connection id vs dashboard detail id — and confirm the delete verb/path.
- [x] 1.5 Verify whether the gateway path forwards query strings and streams request/response bodies well enough for git-sized payloads. (Egress-proxy live test: header injection, query strings, and POST bodies forward correctly; large/streaming git payloads still to be load-tested.)
- [ ] 1.6 Verify whether Sprite labels can be set at Sprite creation via the Sprites API and are live before the first callback (needed for the label-scoping fallback when the Sprite id is unknown at mint time).

## 2. Data Model

- [ ] 2.1 Add D1 migrations for connector metadata (including BOTH the gateway connection id and the dashboard detail id), environment links, provisioning attempts, and expiring pending secret material.
- [ ] 2.2 Add repository methods for creating pending connectors, recording provisioning attempts, completing connector provisioning, recording the verified access-policy summary, and marking terminal failures.
- [ ] 2.3 Add a cleanup path that deletes pending secret material after success, terminal failure, or expiry.
- [ ] 2.4 Add Zod schemas and internal types for connector definitions, auth methods, access-policy scopes (name-prefix, labels, allow-all), and provisioning states.

## 3. Provisioner Boundary

- [ ] 3.1 Define the job payload and callback contract between the API server and dashboard provisioner.
- [ ] 3.2 Implement a headless Playwright provisioner from the proven spike flow (launch with a provisioner-only Sprites dashboard session).
- [ ] 3.3 Add dashboard shape preflight checks for the Custom API form (form id, `phx-*` events, field names, success-state markup) before any secret is entered.
- [ ] 3.4 Implement form fill, connection test, wait-for-success (`bg-violet-50` + `hero-check-circle-mini` + "Connection OK" + Create enabled), create submission, and extraction of BOTH ids.
- [ ] 3.5 Implement atomic create (browser) → scope via REST `PATCH /v1/oauth/connections/{id}` `access_policy` → GET verify (`allow_all == false`, only intended scope). Fail closed and delete the connector if scoping or verification fails.
- [ ] 3.6 Redact tokens, cookies, CSRF values, LiveView session payloads, and dashboard storage state from all logs and traces.

## 4. API Integration

- [ ] 4.1 Add authenticated API routes for creating/listing/updating/deleting Cloude connector metadata.
- [ ] 4.2 Enqueue dashboard provisioning jobs after creating pending connector rows.
- [ ] 4.3 Return pending/ready/failed connector status to clients without returning plaintext secrets.
- [ ] 4.4 Add idempotency handling (marker in name/description) so retries do not create duplicate user-facing connectors when a previous dashboard create succeeded.

## 5. `mintConnector` Primitive (New)

- [ ] 5.1 Implement `mintConnector({baseApiUrl, token, authMethod, headerPrefix, testUrl, scope}) -> {gatewayConnectionId, detailId, policySummary}` on the provisioner: run the full test→create→scope→verify flow, delete-on-failure, and throw on any failure. One connector per call, on demand.
- [ ] 5.2 Expose the Worker→provisioner RPC/job call so the Worker can invoke `mintConnector` as if it were a REST route (the provisioner IS the missing create API).
- [ ] 5.3 Add REST delete for teardown; reconcile orphans from crashed sessions.

## 6. Sprite→Worker Per-Session Proxy (New)

- [ ] 6.1 Add a Worker session-callback health endpoint that returns 200 iff `Authorization: Bearer <secret>` validates for the session; use it as the connector `test_url`.
- [ ] 6.2 Mint per-session secret and store its hash in D1 before provisioning; call `mintConnector` scoped to the session Sprite; hand the Sprite ONLY the gateway connection-id URL, never the secret or the raw Worker URL.
- [ ] 6.3 Call `mintConnector` inline on session create; add the `connector-pending` session state only if measured session-start latency requires it (block Sprite callbacks until verified-scoped ready).
- [ ] 6.4 Delete the per-session connector on session end.

## 7. Access Policy And Session Attachment

- [ ] 7.1 Scope each minted connector to its session Sprite id (preferred) or a single unguessable per-session label, via REST `PATCH /v1/oauth/connections/{id}` `access_policy`; optionally tighten with `allowed_endpoints`.
- [ ] 7.2 Ensure session provisioning applies required Sprite labels/ids before a connector is used.
- [ ] 7.3 Store connector ids in repo environment/session snapshots only after provisioning reaches verified-scoped ready state.
- [ ] 7.4 Prevent sessions from starting with required connectors that are pending, failed, paused, drifted, or still at `allow_all`.

## 8. Reconciliation And Drift Handling

- [ ] 8.1 Reconcile D1 connector rows against Sprites connection state using supported REST APIs, including re-asserting `allow_all == false` on every tracked connector.
- [ ] 8.2 Mark missing or inaccessible Sprites connectors unavailable and block new dependent sessions.
- [ ] 8.3 Add dashboard drift detection that pauses provisioning when selectors/events/success states change.
- [ ] 8.4 Add operational status for dashboard reauthentication required.

## 9. Tests And Validation

- [ ] 9.1 Add repository tests for connector metadata (both id spaces), pending secret cleanup, and provisioning status transitions.
- [ ] 9.2 Add provisioner unit tests around selector detection, success-state detection, scope-verify, and redaction helpers.
- [ ] 9.3 Add integration tests with a mocked dashboard driver for create success, test failure, auth expiry, drift failure, and allow-all-not-scoped fail-closed.
- [ ] 9.4 Add tests for the Sprite→Worker mint (health-endpoint gating, inline + pending paths, teardown).
- [ ] 9.5 Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, and relevant package tests.
