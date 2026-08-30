# Provider inference proxying

## Decision

Use each provider CLI's supported custom API base, but do **not** route inference
bytes through the Sprites connector gateway. The gateway buffers provider responses.
A managed OpenRouter connector probe on 2026-08-27 made the boundary explicit:

- `stream:false` returned ordinary JSON;
- `stream:true` with `Accept: text/event-stream` returned `406`;
- `stream:true` with `Accept: application/json` returned a complete SSE transcript
  with 19 `data:` records and a fixed `Content-Length`, but time-to-first-byte
  (1.6137s) equaled total time (1.6143s).

The OpenRouter connector therefore supports inference and can transport an SSE
*payload*, but it does not provide live token streaming. The provider path uses the
connector only for a small JSON authorization exchange, then streams directly
through a shared Cloude Node service:

```text
provider CLI
  -> Sprite-local inference proxy (inside the vm-agent)
     -> per-session class-A connector
        -> POST /internal/session/:sessionId/inference-token
           (Fly authorizes the Sprite; the DO mints a five-minute admission ticket)
     -> direct Cloude Node provider proxy
        (ticket validation + current provider access material via Worker control RPC)
  -> provider API
```

There is no provider connector, provider-owner label, or `provider_connectors` table.
Provider authorization is derived from the authenticated session. Connecting,
disconnecting, or rotating a provider changes only the encrypted provider record; it
does not create or edit a Sprites connector.

Provider requests intentionally bypass both the Sprites streaming gateway and the
transparent class-B MITM proxy. Claude and Codex point at provider-specific paths on
the Sprite-local inference proxy:

```text
http://127.0.0.1:<port>/claude
http://127.0.0.1:<port>/codex
```

The CLIs append their normal protocol paths to those prefixes and send only fixed
placeholders. For each actual provider HTTP request, the local inference proxy obtains
a five-minute opaque inference admission ticket from the connector-authenticated JSON
mint, removes the placeholder, and calls the Node proxy directly. The ticket is scoped
to one session and provider, contains no provider credential, and is revoked with the
session. It is analogous to the ephemeral Git token only in topology: it authorizes
the Cloude proxy, not Anthropic, OpenAI, or OpenRouter.

The Node proxy is the provider inference service, not a Codex-only shim. Ordinary
Node egress is already proven to reach ChatGPT where workerd is rejected, and using
the same service for Claude gives both providers one unbuffered transport:

```text
Claude/Codex -> Sprite-local inference proxy -> direct Node provider proxy -> provider
                                                    |
                                                    +-> authenticated Worker control RPC
```

The Worker remains the sole owner of D1 lookup and OAuth refresh. On each new
provider request, Node presents the inference admission ticket and request metadata
over an authenticated control RPC. The Worker validates the ticket through the session
DO, resolves the session user, refreshes D1 OAuth when needed, and returns only the
current access material required for that provider request. Node never receives a
refresh token, never selects a user, and never stores credentials.

## Phase boundary and runtime placement

This document is the implementation plan for S4. Provider inference is deliberately
scheduled before the generic class-B connector work in S3/S5.

The **Sprite-local inference proxy** is a new localhost HTTP boundary, not a deployed
service or an already-existing component. For the first implementation it SHALL be
hosted by the existing Bun vm-agent process:

- listen only on `127.0.0.1` and start before Claude or Codex is launched;
- share the vm-agent lifecycle and stop when the vm-agent exits;
- fail provider startup closed if the listener or connector mint is unavailable; and
- keep request bodies streaming and avoid writing admission tickets or provider
  material to disk, process arguments, or logs.

This boundary is necessary because AI SDK middleware runs before a provider
`doStream()` call, while the Claude and Codex CLI processes can make multiple internal
HTTP requests that AI SDK cannot observe. The localhost proxy sees every real provider
request and can obtain admission immediately before forwarding it.

The admission ticket is not another harness credential lifecycle. The local proxy
SHALL mint one ticket for each incoming provider HTTP request and SHALL NOT cache it,
refresh it in the background, or synchronize it with Claude/Codex authentication.
Node checks that the ticket is valid when admitting the request; ticket expiry after
admission does not terminate an already-authorized stream. The only refresh cycle is
provider OAuth refresh in the Worker/D1 control plane.

## Implementation sequence

1. **S4.0:** make provider OAuth refresh safe across concurrent sessions.
2. **S4.1c:** deploy the shared Node provider proxy and prove ordinary Node egress to
   both Anthropic and ChatGPT.
3. **S4.2:** add the connector-authenticated `/inference-token` JSON mint and DO-held
   admission-ticket verification state.
4. **S4.3:** add the localhost listener to the Bun vm-agent, then configure Claude and
   Codex to use its provider-specific bases and fixed placeholders.
5. **S4.4:** implement the metadata-only Node/Worker control RPC and exact upstream
   header/path reconstruction.
6. **S4.5-S4.6:** prove isolation, revocation, unbuffered streaming, CLI/app-server
   behavior, cancellation, refresh, errors, and capacity before rollout.

## Session authentication contract

The class-A connector injects the session credential only on the JSON admission-ticket
mint. The route remains named `/inference-token`, but the returned value is a Cloude
proxy admission ticket, not a provider credential. The flow SHALL:

1. Resolve the session from `:sessionId` and validate the connector-injected
   credential using the same Durable Object authority as webhook and Git minting.
2. Mint a five-minute opaque admission ticket scoped to the session and requested
   provider. Store only its server-side verification state in the session DO.
3. Have the local inference proxy remove the CLI's fixed placeholder and present the
   ticket directly to the Node provider proxy.
4. Have Node validate the ticket through an authenticated Worker control RPC;
   the Worker resolves the provider credential from the authenticated session's
   user and rejects missing, disconnected, revoked, expired, or wrong-provider use.
5. Restrict the forwarded method and path to the protocol surface required by the
   selected provider CLI and stream the body entirely outside the connector and DO.

The CLI must carry a non-secret placeholder to satisfy its startup checks. Neither
the local inference proxy, Worker, nor Node accepts that placeholder as authority.
The short-lived ticket is replayable only during its TTL, so it is narrowly scoped,
held in local-proxy memory for the request, and revoked at teardown.

The implementation may initially reuse the current Durable Object `webhook_token`
storage field, but the credential's documented authority becomes the session's
allowlisted webhook, Git-token-mint, and inference-capability-mint routes. It should
be named a session control-plane token in new interfaces.

## Claude Code

### Sprite configuration

Claude Code has a documented LLM-gateway interface:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:<port>/claude"
export ANTHROPIC_AUTH_TOKEN="cloude-placeholder"
```

- `ANTHROPIC_BASE_URL` points to the Claude path on the local inference proxy.
- `ANTHROPIC_AUTH_TOKEN` is a literal, non-secret placeholder. Claude requires a
  credential source to skip first-run login and sends the value as
  `Authorization: Bearer cloude-placeholder`.
- The local inference proxy ignores the placeholder, mints an admission ticket through
  the session connector, and sends the request directly to the Node provider proxy.
- Node validates the ticket through the Worker control RPC, receives only the
  current Anthropic access material, and overwrites downstream authorization.

This uses Claude's documented [`ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`](https://code.claude.com/docs/en/env-vars) behavior.
Anthropic's [authentication precedence
documentation](https://code.claude.com/docs/en/authentication#authentication-precedence)
specifically recommends `ANTHROPIC_AUTH_TOKEN` for a bearer-authenticated gateway or
proxy. The [LLM gateway documentation](https://code.claude.com/docs/en/llm-gateway)
describes the same configuration shape.

The required authorization/header transformation is exact:

| Hop | Required authority and headers |
| --- | --- |
| Claude Code -> local inference proxy | `ANTHROPIC_AUTH_TOKEN` produces `Authorization: Bearer cloude-placeholder`; the placeholder has no authority. Preserve Claude protocol headers. |
| Local inference proxy -> Node | Remove the placeholder authorization and present the newly minted inference admission ticket as Cloude proxy authority. |
| Node -> Anthropic | Remove `x-api-key` and competing authorization; set `Authorization: Bearer <current OAuth access token>`; ensure `anthropic-beta` includes `oauth-2025-04-20`; preserve the remaining allowlisted Claude protocol headers. |

### Node/Worker contract

The Claude inference path SHALL:

1. Accept only the short-lived inference admission ticket; never treat
   `cloude-placeholder` as authority.
2. Resolve exactly one authenticated session user and that user's `claude`
   credential through the Node-to-Worker control RPC.
3. Restrict forwarding to the Claude API paths required by the supported CLI version.
4. Remove `x-api-key`, replace `Authorization` with the refreshed D1-custodied OAuth
   access token, and ensure `anthropic-beta` includes `oauth-2025-04-20`.
5. Preserve other Claude protocol headers, query parameters, status, and streaming
   request/response behavior.
6. Never log authorization, request/response bodies, refresh tokens, or decrypted
   credential records.
7. Return a stable authentication failure when the provider connection is absent or
   refresh fails; never fall back to a Sprite-held provider credential.

The proxy, not Claude Code, owns the OAuth beta header. In gateway bearer mode Claude
Code 2.1.207 did not send `oauth-2025-04-20`; the live spike failed until the Worker
added it.

### Live spike evidence — 2026-07-23

The spike harness (`test:live:claude-oauth-control-plane-proxy` and its Worker) was
removed from the tree after this evidence was captured; recover it from the history
of this branch if it needs to be re-run. It exercised Claude Code 2.1.207 in a fresh
Sprite against a local Worker exposed through `webhooks.bze.llc`:

- The Worker read/refreshed the actual user-owned Claude OAuth credential from local
  D1 and injected it only on the Anthropic hop.
- Invalid control-plane bearer authentication returned `401`.
- Non-interactive Claude completed streamed inference through the Worker.
- Writing a fake OAuth-shaped `~/.claude/.credentials.json` was not a valid
  interactive plan: bare `claude` entered the login chooser even though `claude -p`
  had accepted the file.
- Setting `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` bypassed interactive login
  through Claude's supported gateway path.
- Gateway mode omitted the OAuth beta header; after the Worker injected it, both the
  automated probe (`gateway-auth-ok`) and a manual interactive Claude session
  completed successfully.

This proves Claude CLI/control-plane compatibility and that provider OAuth can remain
server-side. It does not yet prove the production local-proxy/ticket/Node path: the
spike put a short-lived internal Worker JWT in the Sprite and streamed through the
Worker before the Sprites buffering limitation was confirmed.

### Claude acceptance tests

Before enabling Claude provider proxying:

- Run bare interactive `claude` and `claude -p` without a login prompt.
- Prove `echo "$ANTHROPIC_AUTH_TOKEN"` reveals only the fixed placeholder.
- Prove another Sprite and an off-Sprite caller cannot mint an inference admission ticket.
- Prove an extracted ticket is provider/session scoped, expires within five
  minutes, and is rejected after teardown.
- Exercise streamed text, tool calls, long responses, interruption/resume, errors,
  and context compaction without buffering or protocol corruption.
- Capture the required request-path set and deny every other Node proxy path.
- Verify refresh during an active session and a clean failure for revoked OAuth.
- Verify access/refresh tokens and the session connector credential are absent from
  Sprite files, environment, process arguments, and logs.

Anthropic documents two custom-base limitations that must be reflected in product
behavior and tests: Remote Control is disabled for non-first-party
`ANTHROPIC_BASE_URL` values, and MCP tool search is disabled by default unless
`ENABLE_TOOL_SEARCH=true` is set and the gateway supports the corresponding
`tool_reference` traffic.

## Codex

### Supported custom-provider shape

Codex accepts a custom Responses provider with an arbitrary environment variable as
its bearer source:

```toml
model_provider = "cloude_proxy"

[model_providers.cloude_proxy]
name = "OpenAI"
base_url = "http://127.0.0.1:<port>/codex"
wire_api = "responses"
env_key = "CLOUDE_CODEX_AUTH_TOKEN"
http_headers = { version = "<installed-codex-version>" }
```

In production, `base_url` is the Codex path on the local inference proxy.
`CLOUDE_CODEX_AUTH_TOKEN` contains only a fixed placeholder. Codex 0.144.3 accepted
the custom-provider shape without `auth.json` and sent the value as
`Authorization: Bearer ...` to `POST <base_url>/responses`. This follows Codex's
documented [custom model-provider
configuration](https://developers.openai.com/codex/config-advanced#custom-model-providers).

The Codex authorization/header transformation follows the same boundary:

| Hop | Required authority and headers |
| --- | --- |
| Codex -> local inference proxy | `CLOUDE_CODEX_AUTH_TOKEN` produces placeholder bearer authorization; preserve the configured Codex `version` header. |
| Local inference proxy -> Node | Remove placeholder authorization and present the newly minted inference admission ticket as Cloude proxy authority. |
| Node -> ChatGPT | Remove competing authorization, cookies, forwarding, tunnel, and proxy-loop headers; set `Authorization: Bearer <current OAuth access token>` and the credential record's `ChatGPT-Account-ID`; preserve only the allowlisted Responses protocol headers. |

### Live spike evidence — 2026-07-23

The spike harness (`test:live:codex-oauth-control-plane-proxy`, its Worker, and the
patched native Responses proxy) was likewise removed after capture; recover it from
this branch's history to re-run. It exercised Codex 0.144.3 in a fresh Sprite through
`webhooks.bze.llc`:

- An invalid control-plane token returned `401`.
- Codex ran without `auth.json`, accepted the custom provider URL plus short-lived
  Cloude bearer, and sent `POST /responses`.
- Reconnecting Codex produced a fresh record expiring 2026-08-02, ruling out the
  original stale-token hypothesis.
- The same fresh D1 OAuth credential completed `gpt-5.4` inference through the
  official Codex CLI locally (`direct-codex-control-ok`).
- A Worker/workerd request using the same fresh credential consistently received a
  generic HTML `403` from the ChatGPT Cloudflare edge.
- A direct request using Node's ordinary native `fetch`, the same current OAuth
  token, the same account ID, and the same `/models` route succeeded. The failure is
  therefore not a JavaScript limitation or a Rust requirement; it is specific to
  the workerd transport.
- A native proxy based on Codex's official `responses-api-proxy`/reqwest transport
  completed local inference with the client still using a dummy bearer
  (`native-codex-proxy-ok`).
- The final Sprite run used the native proxy as the authenticated control-plane
  boundary. It validated the short-lived Cloude bearer, injected the D1-custodied
  OAuth access token and `ChatGPT-Account-ID`, stripped proxy/tunnel headers, and
  streamed `gpt-5.4` inference to completion (`codex-proxy-ok`).
- A follow-up manual run launched the normal interactive Codex TUI in the same
  prepared Sprite. It operated normally through the proxy with no `auth.json` or
  provider token in the Sprite.

### Why workerd and an ordinary native request differ

This is not a claim that Rust can express an HTTP request JavaScript cannot. Node's
ordinary `fetch()` succeeds. A Worker `fetch()` is different because workerd does
not act like an ordinary process opening a socket:

- Cloudflare documents that a Worker sends outbound HTTP through a platform proxy,
  which applies security checks and adds Worker identification.
- Cloudflare adds `CF-Worker` to Worker subrequests and exposes the non-forgeable
  `cf.worker.upstream_zone` field to destination WAF rules.
- A Worker cannot bypass that path with a raw TLS socket to a Cloudflare address:
  Workers TCP sockets block Cloudflare IP ranges.

A same-machine transport probe compared local workerd with the native reqwest stack
used by the successful proxy. Both requests used the same public IP, HTTP/1.1, and
user agent. They still differed in two observable ways:

- workerd added `CF-Worker`; reqwest did not;
- their TLS client fingerprints differed (the observed workerd request negotiated
  TLS 1.3 with JA3 `26dce03819b8a8afa560b31ed0b5edc2`; reqwest negotiated TLS 1.2
  with JA3 `e4d448cdfe06dc1243c1eb026c74ac9a`).

A follow-up local reproduction sharpened the attribution. Running the same request
from `wrangler dev --local` (local workerd) reproduced the identical Cloudflare HTML
`403`, with the same workerd fingerprint (JA3 `26dce03819b8a8afa560b31ed0b5edc2`) the
earlier spike observed. Crucially, local workerd egresses from the host's own public
IP — verified identical to native Node on the same machine — and never traverses
Cloudflare's edge as a zone subrequest. `cf.worker.upstream_zone` therefore cannot be
populated for it, yet it is still blocked. Edge Worker-origin classification is thus
not *necessary* to produce the rejection; an intrinsic property of the workerd request
is sufficient on its own.

Two such intrinsic properties are present even off-edge, and neither is controllable
from application code:

1. **workerd's TLS/HTTP client fingerprint.** workerd negotiates a small, modern-only
   BoringSSL cipher list (JA3 `26dce…`) that no browser or ordinary process presents.
   Native Node (`d67b…`) and reqwest (`e4d448…`) present very different fingerprints
   and are admitted to application auth on the same endpoint.
2. **The self-stamped `CF-Worker` header.** workerd attaches `CF-Worker: <name>` to
   every outbound `fetch`, even locally, and it is immutable: `delete` and setting an
   empty value are silently ignored, and overriding the value aborts the request. It
   cannot be stripped or forged from the Worker.

`cf.worker.upstream_zone` remains a plausible *additional* layer for a deployed Worker
on Cloudflare's edge, but it cannot explain the local reproduction and is not required
to explain the rejection. The practical consequence is unchanged and firmer: no Worker
configuration, header manipulation, or edge-versus-local distinction reaches the
ChatGPT backend, because the blocking signals are properties of the workerd runtime
itself. Only changing the runtime — a non-workerd egress hop — resolves it.

The exact rejecting rule is still not observable from the client (a generic Cloudflare
HTML `403`, not a ChatGPT JSON authentication error), so we document this as an
observed deployment constraint, not a proven protocol law. Pinning the specific rule
would require OpenAI/Cloudflare edge logs; the reproduction, however, definitively
rules out `cf.worker.upstream_zone` as a necessary cause and shows the constraint is
intrinsic to workerd.

Cloudflare's [Workers security
model](https://developers.cloudflare.com/workers/reference/security-model/),
[HTTP header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-worker),
and [TCP socket restrictions](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
describe the platform-mediated transport differences.

### Shared Node provider-proxy contract

The production flow SHALL keep the Worker as the authenticated credential control
plane and use one shared Node service as the streaming data plane for both providers:

1. The local inference proxy obtains a provider/session-scoped admission ticket
   through the class-A connector and sends the provider request directly to Node.
2. Node presents the ticket and allowlisted request metadata to the Worker over
   an authenticated control request; no inference body crosses this RPC.
3. The Worker validates the ticket through the DO, resolves the session user,
   reads/refreshes the encrypted provider record, and returns only the current access
   token plus required provider metadata. It never returns a refresh token.
4. Node rebuilds the upstream request, removes inbound `cf-*`, forwarding,
   proxy-loop, cookie, `x-api-key`, and competing authorization headers, then adds
   only the current OAuth authorization and provider-required headers.
5. Node streams status, headers, and body without buffering or logging secrets.

The service is horizontally scalable and stateless. It does not access D1, refresh
OAuth, map users, or participate in connector provisioning. Ordinary Node `fetch`
is already proven compatible with ChatGPT; Rust/reqwest is not required.

### Remaining provider acceptance work

- Deploy the Node proxy on ordinary VM/container egress and prove both complete
  `Sprite CLI -> local inference proxy -> Node -> Anthropic/ChatGPT` flows.
- Prove the Node-to-Worker service credential cannot be replayed by a Sprite and
  rotate it independently of provider credentials.
- Prove the connector-authenticated admission-ticket mint, five-minute expiry, provider
  scope, session revocation, and direct unbuffered stream.
- Exercise `/responses`, `/models` if requested by the installed client, streamed
  text, tools, long responses, interruption/retry, compaction, and upstream errors.
- Verify OAuth refresh and revocation during an active session.
- Load-test concurrent streams, connection limits, cancellation, backpressure, and
  capacity.
- Confirm feature parity and record any custom-provider degradation.

The official proxy needed two spike-only input changes because it was written for API
keys rather than OAuth JWTs: a larger stdin buffer and support for `.` in the
bearer-token alphabet. Production code should accept OAuth-sized bearer values
without logging or placing them in process arguments.
