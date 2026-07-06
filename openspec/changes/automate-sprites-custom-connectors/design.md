## Context

Sprites Custom API connectors solve the important runtime boundary: the upstream
credential is stored outside the Sprite and the Sprites gateway authorizes calls
using Sprite identity before forwarding to the provider. Fly support confirmed
that Custom API connector creation is available in the dashboard but not the
public REST API. The public REST API can still list/fetch/update policy/delete
connections after they exist.

The dashboard automation approach was previously a proposal built on an
unverified DOM/LiveView trace. It has now been **proven end to end** with a live
browser-automation spike against the real `ben-edelstein` Sprites org
(2026-07-06), using dummy `httpbin.org` credentials. The findings below are
verified, not assumed.

### Verified dashboard automation (live spike, 2026-07-06)

Driven with the Claude-in-Chrome browser tools against an authenticated Sprites
web session. Every step the design depends on works.

**Form shape (preflight/drift anchors).** At
`/account/:org/connectors/new?type=custom_api`:

- Form id `custom-api-form`, `phx-change="validate_custom_api_form"`,
  `phx-submit="create_custom_api"`.
- `meta[name="csrf-token"]` present; root element carries `data-phx-session`.
- Auth-method buttons carry `phx-value-auth_method` values `header`,
  `url_path`, `query_param`, `custom_header`.
- Fields (name / dom id): `base_api_url` (`custom-api-base-url`, required),
  `name` (`custom-api-name`, optional — auto-generates from the URL host, e.g.
  `httpbin.org` -> "Httpbin"), `description` (`custom-api-description`),
  `access_token` (`custom-api-token`, password, required),
  `auth_method` (hidden), `auth_header_prefix` (`custom-api-auth-prefix`,
  defaults to "Bearer", rendered as `Authorization: Bearer <token>`),
  `refresh_token` (`custom-api-refresh-token`, optional),
  `icon` (file, optional), `test_url` (`custom-api-test-url`, required).
- Buttons: "Test Connection" (`phx-click="test_custom_api"`, enabled),
  "Create Connection" (`type=submit`, **disabled until a test succeeds**),
  "Cancel" (`phx-click="cancel_custom_api_form"`).

**Test → success state (was missing from the prior trace).** With base URL
`https://httpbin.org`, a token, and test URL `https://httpbin.org/bearer`,
clicking Test produced an inline success block:

- Container `div.rounded-lg.p-3.border.bg-violet-50.border-navy-200`.
- Icon `span.hero-check-circle-mini.text-violet-700`.
- Text `span.text-violet-700.font-medium` = `HTTP 200 — Connection OK`, plus a
  latency span (`280ms`).
- After success the Create submit flips to `disabled=false`. This confirms the
  product path: **test gates create**.

A drift/success detector should key on the `bg-violet-50` container plus the
`hero-check-circle-mini` icon plus "Connection OK", and independently confirm
`createButton.disabled === false`.

**Create → detail transition (was missing from the prior trace).** Submitting
`create_custom_api` fired a toast "Custom API connection created" and redirected
to `/account/:org/connectors/:id`.

- **Two distinct id spaces.** The post-create redirect id is the **gateway
  connection id** (the value used at
  `${SPRITES_API_URL}/v1/gateway/custom_api/<connectionId>`, e.g.
  `n1waAy-3qkZiXgKiE-JeTw`). The dashboard **detail page** for the same
  connector uses a *different* opaque id (e.g. `fSgD8029s1ipjaY_s4-aNQ`). Both
  are 22-char base64url (128-bit). The provisioner must capture and store both:
  the gateway connection id is what a Sprite calls; the detail id is what the
  dashboard/REST address for policy edits and deletion.

**Access policy is post-creation only.** The create form exposes **no**
Sprite-id/tag scoping. Scoping happens on the connector detail page via a
separate LiveView form:

- `phx-submit="save_access_policy"`, `phx-change="validate_access_policy"`.
- Fields: `connection_id` (hidden), `name_prefix` (text, e.g. `prod-` — "only
  sprites with this name prefix"), `policy_label` (text input, e.g.
  `env:production`, feeding a hidden `sprite_labels` accumulator via
  `policy_label_input`; "sprite must have all labels"), and an `allow_all`
  checkbox.
- The label mechanism is exactly the "Sprite tag" scoping this design assumed.
  Labels are `key:value` and are ANDed (a Sprite must carry every listed label).

**Critical finding — create defaults to `allow_all = true`.** The connector
created in the spike came out with `allow_all` checked, so **every Sprite in the
org (34 at the time) was authorized immediately**, even though the access panel's
own copy claims "by default, no sprites have access" and even though the create
flow was never given any scoping input. Because the create form has no scoping
control, there is an unavoidable window in which a freshly created connector is
open org-wide until a second `save_access_policy` write locks it down. See
Decisions and Risks below — this changes the provisioning contract from
"create, then scope later" to "create → scope → verify" as one atomic,
fail-closed unit.

### Raw LiveView protocol notes (for a future protocol driver)

Retained from the earlier socket capture; only relevant if we later replace the
browser with a raw `/live` frame driver. Not needed for the browser-automation
implementation.

- Validation is an `"event"` frame, `type: "form"`,
  `event: "validate_custom_api_form"`, URL-encoded `value`, `meta._target`
  naming the changed field, `uploads: {}`. The encoded value includes Phoenix
  `_unused_*` sentinels (`_unused_name`, `_unused_description`,
  `_unused_auth_header_prefix`, `_unused_refresh_token`, etc.).
- Test is an `"event"` frame, `type: "click"`, `event: "test_custom_api"`,
  `value: { "value": "" }`, and relies on server-side form state established by
  prior validation events.
- Create is an `"event"` frame, `type: "form"`, `event: "create_custom_api"`,
  URL-encoded `value`, `meta: {}`, and (unlike validation) omits the
  `_unused_*` sentinels.

## Goals / Non-Goals

**Goals:**

- Create Sprites Custom API connectors programmatically despite missing public
  REST create support.
- Let users define arbitrary Custom API credentials in Cloude and have those
  credentials end up in Sprites connector custody.
- **Mint a per-session Sprite→Worker "proxy URL" at session creation** so a
  Sprite can call back to the Cloude Worker control plane through a
  connector-gated gateway URL, without the callback/webhook secret ever entering
  the Sprite runtime. (New — see Decisions.)
- Limit each connector by Sprite id or Sprite tag/label so only intended session
  Sprites can call it.
- Store only connector metadata, state, and audit data in Cloude D1 after
  provisioning succeeds.
- Detect dashboard drift before it silently creates broken or over-broad
  connectors, and never leave a connector at the `allow_all` default.
- Keep fallback behavior explicit when dashboard automation fails.

**Non-Goals:**

- Do not bypass Sprites authentication or access checks.
- Do not scrape or expose dashboard cookies in logs, traces, or client-visible
  state.
- Do not rely on arbitrary user-provided URL proxying as the primary secret
  model.
- Do not put raw user API secrets (or the per-session webhook secret) into
  Sprite env vars, files, git config, or process args.
- Do not change the Worker→Sprite direction. Worker-initiated calls continue to
  use the Sprites exec/API path. The connector gateway only carries the
  Sprite→upstream (including Sprite→Worker) direction.
- Do not build a permanent dependency on undocumented LiveView frames beyond the
  now-proven browser flow until drift checks and the protocol driver are in
  place.

## Decisions

### Use A Dedicated Dashboard Provisioner

Run connector creation in a separate provisioner process that can drive a real
browser session against `sprites.dev`. Cloudflare Workers cannot run Playwright
or a full browser, and connector provisioning is a long-running external UI
workflow with brittle dependencies.

The provisioner should be invoked from the API server through a queue/job
boundary:

```text
Cloude API request
  -> D1 pending connector row
  -> queue/job for dashboard provisioner
  -> dashboard creates Sprites connector
  -> provisioner scopes access policy (save_access_policy) and verifies
  -> provisioner writes connection id/detail id/state back to API/D1
```

The live spike used the Claude-in-Chrome tools; the production provisioner should
use headless Playwright with the same selectors and success states captured
above. The flow is proven; the remaining work is packaging it as a reliable,
headless, drift-guarded service.

Alternatives considered:

- Raw Phoenix LiveView client from the Worker: lower overhead, but depends on
  undocumented socket protocol details and still needs dashboard web-session
  auth. Keep as a later optimization; the raw frames are captured but the
  browser path is now the proven baseline.
- Shared internal connector plus Cloude D1-custodied secrets: works as a backup,
  but loses the desired Sprites-custodied per-connector secret boundary.

### Prefer Browser Automation Before Raw LiveView Replays

The first implementation should use Playwright with a persisted dashboard
session, the stable selectors captured above, and drift checks around visible
field labels, `phx-*` attributes, and the success-state markup. It should not
initially replay raw `/live` WebSocket frames.

Rationale:

- Phoenix LiveView message payloads include ephemeral root ids, static/session
  tokens, upload refs, event refs, joins, diffs, and CSRF values.
- A real browser lets Phoenix's client code handle joins, validation events,
  file-upload plumbing, reconnect behavior, and CSRF handling.
- The spike confirmed the visible dashboard shape and success/redirect states
  are sufficient to drive create, test, scope, and read-back deterministically.

### Mint Per-Session Sprite→Worker Proxy Connectors (New)

**Goal.** At session creation, the Worker should hand the session Sprite a single
opaque gateway URL that is the *only* way the Sprite can reach the Cloude control
plane, with the callback secret held in Sprites custody, not in the Sprite.

**Why a connector fits.** A Custom API connector is exactly a credential-injecting
egress gateway: the Sprite calls
`${SPRITES_API_URL}/v1/gateway/custom_api/<connectionId>/<path>`, the Sprites
gateway attaches `Authorization: Bearer <secret>`, and forwards to the connector's
`base_api_url`. The spike confirmed header injection, query-string forwarding, and
POST-body forwarding all work (this matches the separate egress-proxy live test).
The Sprite holds only the connection-id URL — itself a 128-bit unguessable
capability — and the access policy binds that URL to the specific session Sprite.

**Per-session connector shape.**

- `base_api_url` = the Worker callback base for this session, e.g.
  `https://<api-host>/v1/sessions/<sessionId>/sprite-callback`.
- `access_token` = a freshly generated, high-entropy per-session webhook secret.
- `auth_method` = `header`, prefix `Bearer` (gateway sends
  `Authorization: Bearer <secret>`). The Worker validates this on every callback.
- `test_url` = a Worker health/echo endpoint that returns HTTP 200 only when the
  Bearer token is valid for this session (required — create is gated on a
  successful test).
- Access policy = scoped to the session's Sprite id (preferred), or a single
  unguessable per-session label. Never left at `allow_all`.

**Ordering constraint from the test gate.** Create requires a passing connection
test, and the test calls the Worker. So the session secret must exist server-side
*before* the connector test runs:

```text
1. Worker mints sessionId + per-session secret; stores secret hash in D1.
2. Worker exposes /v1/sessions/<sessionId>/sprite-callback/health that returns
   200 iff Authorization: Bearer <secret> validates for that session.
3. Provisioner opens the create form, fills base_api_url + token + test_url
   (= the health endpoint), runs test_custom_api, waits for "Connection OK".
4. Provisioner submits create_custom_api, reads the gateway connection id from
   the redirect and the detail id from the detail page.
5. Provisioner immediately opens the detail page and runs save_access_policy to
   scope the connector to the session Sprite (id or label), then re-reads the
   policy to verify allow_all is off and only the intended scope remains.
6. On any failure in 3-5, the provisioner deletes the connector (REST delete)
   and marks the attempt failed. Fail closed: the session does not start with an
   unscoped or unverified connector.
7. Worker stores {gatewayConnectionId, detailId, policy summary} in D1, deletes
   the plaintext secret material, and hands the Sprite ONLY the gateway
   connection-id URL.
```

**What the Sprite receives.** One env value — the gateway connection-id URL. No
secret, no raw Worker URL. Callback auth lives in Sprites custody; a Sprite
compromise cannot exfiltrate the callback secret, and revocation is a connector
delete.

**Direction scope.** This covers Sprite→Worker only. Worker→Sprite stays on the
existing Sprites exec/API path.

### The Provisioner Is The Missing "Create Connector" API

Sprites never shipped a REST create endpoint for Custom API connectors. The
browser provisioner exists to *be* that endpoint. Everything else in this design
should treat it as a single primitive, callable on demand, one connector per
call — exactly as if Sprites had shipped `POST /v1/connectors`.

```text
mintConnector({
  baseApiUrl, token, authMethod, headerPrefix, testUrl, scope
}) -> { gatewayConnectionId, detailId, policySummary }
```

Under the hood the primitive runs the proven flow: preflight shape check → fill
→ `test_custom_api` → wait for "Connection OK" → `create_custom_api` → read both
ids → `save_access_policy` to apply `scope` → re-read to verify `allow_all` is
off. It either returns a fully created, correctly scoped connector, or it deletes
whatever partial connector it made and throws. No pool, no pre-provisioning, no
slot bookkeeping — you call it when you need a connector and you get one back.

The only structural constraint is *where* it runs: a Cloudflare Worker cannot
drive a browser, so the primitive is implemented by a separate provisioner
service and the Worker reaches it over an internal RPC/job call. That is just
"the API route lives in another service," not a caching layer. Session creation
calls `mintConnector` on demand and blocks on the result the same way it would
block on any dependency.

Latency is the honest cost: the browser flow takes on the order of seconds, not
the milliseconds a native REST call would. If that is too slow to sit inline in
session start, the mitigation is to move it behind a `connector-pending` session
state (session starts, Sprite is blocked from callbacks until `mintConnector`
returns), NOT to pre-mint connectors speculatively. Start with the simplest
correct version — call it inline — and only add the pending state if measured
session-start latency demands it.

### Store A Dashboard Session As Provisioner-Only Secret Material

The provisioner needs an authenticated Sprites dashboard session for the Cloude
Sprites organization. Store that browser storage state or equivalent session
material in a provisioner-only secret store, not in D1 and not in the API server
runtime if avoidable.

Operational rules:

- Use a dedicated Sprites dashboard account with the minimum org role that can
  manage connectors.
- Keep the session out of logs and screenshots.
- Rotate/recreate the session manually when expired or revoked.
- Make authentication failure a terminal provisioning error that asks for
  reauthentication instead of falling back to raw env vars.

### Keep Cloude D1 As Metadata, Not Secret Custody

After connector creation, D1 should store:

- Cloude connector id.
- Sprites **gateway connection id** and the distinct **dashboard detail id**
  (both are needed — see the two-id-spaces finding).
- Org slug and provider type.
- User-facing name/description.
- Base API URL and auth method metadata.
- Access-policy scope requested and observed (including a verified `allow_all ==
  false` assertion).
- Linked repo environments / session ids.
- Provisioning status, attempt id, errors, and dashboard shape hash/version.

The plaintext user token (or per-session webhook secret) should be held only long
enough to complete connector creation and the scope-verify step. If a queued job
requires persistence before the provisioner can run, store it encrypted in an
expiring pending-secret table and delete it after success or terminal failure.

### Scope Each Minted Connector To Its Session Sprite

Because `mintConnector` creates one connector per session on demand, scope it to
that session's Sprite id — the tightest possible policy — via `save_access_policy`
inside the mint primitive, before it returns. Verified policy inputs: `name_prefix`
(prefix match), `policy_label` (`key:value` labels, ANDed), and `allow_all`.

Prefer Sprite-id scoping when the create-time Sprite id is known. If the Sprite is
created after the connector (or the id is otherwise not yet available), fall back
to a single unguessable per-session label (e.g. `session:<sessionId>`) set on the
Sprite at creation and matched by the connector policy. Either way, `allow_all`
must be verified off before the connector is marked ready.

### Treat Test Connection As Required Before Create

The dashboard disables Create until the connection test succeeds (verified). The
provisioner follows that product path:

1. Fill base URL, name, auth fields, token, optional description, and test URL.
2. Trigger `test_custom_api`.
3. Wait for the `bg-violet-50` + `hero-check-circle-mini` + "Connection OK"
   success state and confirm the Create submit is enabled.
4. Submit `create_custom_api`.
5. Read the gateway connection id from the redirect and the detail id from the
   detail page.
6. Immediately scope via `save_access_policy` and re-read to verify.

For Sprite→Worker connectors, the test URL is the Worker health endpoint, so the
test doubles as a real proof that the gateway can reach the Worker with the
injected Bearer token. For user connectors, require a provider-specific or
user-supplied test URL under the base URL rather than bypassing the test.

### Reconcile With Supported REST APIs

After creation, use official REST endpoints where supported to:

- Fetch the created connection (by detail id / connection id).
- Update access policy if REST supports it reliably (this would let the mint
  primitive scope via REST instead of a second browser step — verify).
- Delete failed/abandoned/ended-session connectors.
- Periodically reconcile D1 state with Sprites connection state and re-assert
  that no tracked connector has drifted to `allow_all`.

Dashboard automation should be limited to create and any other fields REST cannot
set. Use documented REST for everything it can do — especially delete (cleanup)
and, if supported, policy update.

## Risks / Trade-offs

- **`allow_all` default (new, verified).** A freshly created connector is open to
  every Sprite in the org until scoped. Mitigation: treat create+scope+verify as
  one atomic, fail-closed unit; delete the connector if scoping or verification
  fails; reconciliation re-asserts `allow_all == false` on every tracked
  connector.
- **`mintConnector` latency (new).** The browser flow takes seconds, not the
  milliseconds of a native REST call. Mitigation: call it inline first; if
  measured session-start latency is too high, move it behind a
  `connector-pending` session state (Sprite blocked from callbacks until the
  connector is ready). Do not pre-mint speculatively to hide the latency.
- Dashboard DOM or LiveView event drift -> run preflight shape checks (the
  captured form id, `phx-*` events, field names, and success-state markup) before
  provisioning and fail closed if expected fields/events/success states are
  missing.
- Dashboard session expiry -> store provisioner auth state separately, expose a
  clear "reauth required" operational status, and pause queued jobs.
- Connector created but D1 write fails -> reconcile by listing/fetching
  connectors and matching an idempotency marker in name/description where
  possible. Record both id spaces to make matching reliable.
- D1 row created but dashboard create fails -> mark terminal or retryable failure
  with a sanitized reason; delete expiring pending secret material.
- Test endpoint leaks token to the wrong place -> require the test URL to be under
  the configured base URL (for Sprite→Worker, the Worker health endpoint) or
  explicitly marked as an external test target.
- Sprite label grants too broad access -> when falling back to label scoping,
  generate a single unguessable per-session label and keep policy observations in
  D1; labels are ANDed, so avoid broad shared labels.
- Headless provisioner becomes an availability bottleneck -> treat `mintConnector`
  as a session dependency, expose pending state, and keep sessions blocked from
  using unready connectors. If throughput becomes a real limit, scale provisioner
  workers rather than pre-minting.
- Terms/product risk from dashboard automation -> keep the implementation
  isolated, visible, reversible, and ready to replace with official REST support.

## Migration Plan

1. Add D1 metadata tables and status enums (including both id spaces and policy
   summary) without changing session behavior.
2. Implement the `mintConnector` primitive as a headless Playwright provisioner
   from the proven spike flow: preflight shape check, fill, test,
   wait-for-success, create, read both ids, `save_access_policy`,
   re-read/verify `allow_all == false`, delete-on-failure. Redact all secrets.
3. Add dashboard shape/drift detection and redacted trace capture for
   create/test/scope flows.
4. Add the provisioner service boundary and the Worker→provisioner RPC/job call.
5. Add the Worker session-callback health endpoint and per-session secret
   validation, then wire session creation to call `mintConnector` for the
   Sprite→Worker connector (inline first; add `connector-pending` only if
   session-start latency demands it).
6. Add connector creation API routes that create pending rows and invoke the
   provisioner.
7. Add reconciliation using supported Sprites REST APIs, including delete-based
   cleanup (including on session end) and periodic `allow_all` re-assertion.
8. Attach ready connectors to repo environments and session snapshots only after
   provisioning reaches verified-scoped ready state.
9. Update session provisioning to ensure required Sprite labels/ids before
   connector use.
10. Migrate webhook/git/internal authority onto connectors after the Sprite→Worker
    path is proven.

Rollback:

- Disable dashboard provisioning jobs.
- Leave existing Sprites connectors intact.
- Mark pending connector rows as paused; stop calling `mintConnector`.
- Continue existing webhook/git auth until the connector-backed path is ready.

## Open Questions

Resolved by the 2026-07-06 spike:

- ~~Exact selector and success state for Test/Create after a successful test.~~
  Captured: `bg-violet-50` + `hero-check-circle-mini` + "Connection OK";
  Create submit flips `disabled=false`.
- ~~Connector-detail URL transition and connection id after creation.~~ Captured:
  redirect exposes the gateway connection id; the detail page uses a separate
  detail id (two id spaces).
- ~~Does the create flow expose tag policy editing, or only after creation?~~
  Only after creation, via `save_access_policy` (`name_prefix`, `policy_label`
  labels, `allow_all`). The create flow has no scoping input, and defaults to
  `allow_all = true`.

Still open:

- Can official REST update access policy for Custom API connectors by id? (Would
  let the mint primitive scope via REST instead of a second browser step, cutting
  its latency.)
- Can REST delete Custom API connectors by id for session-end cleanup? (Design
  assumes yes; confirm.)
- Can Sprite labels be set at Sprite creation via the Sprites API, and are they
  live before the first callback? (Needed only for the label-scoping fallback
  when the Sprite id is not known at mint time.)
- What is the right shape and auth for the Worker session-callback health
  endpoint used as the connector `test_url`?
- Is inline `mintConnector` latency at session start acceptable, or is the
  `connector-pending` state needed from day one?
- Can Custom API connectors be created with an idempotency marker in name or
  description without hurting user-facing quality (for create/D1 reconciliation)?
- What is the right service host for the headless Playwright provisioner jobs?
- Should internal Cloude webhook/git connectors use the same provisioner or be
  manually provisioned once?
