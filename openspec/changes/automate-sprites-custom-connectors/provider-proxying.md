# Provider inference proxying

## Decision

Use each provider CLI's supported custom API base and route provider inference
through the session's existing class-A connector:

```text
provider CLI
  -> per-session class-A Sprites connector
     (Fly authorizes session:<sessionId> and injects the session credential)
  -> /internal/session/:sessionId/inference/:provider/...
  -> Worker
     (validate the session credential, resolve the session user, refresh D1 OAuth)
  -> provider API
```

There is no provider connector, provider-owner label, or `provider_connectors` table.
Provider authorization is derived from the authenticated session. Connecting,
disconnecting, or rotating a provider changes only the encrypted provider record; it
does not create or edit a Sprites connector.

Provider requests intentionally bypass the transparent MITM proxy. Claude and Codex
already support custom bases, so their bases point directly to path prefixes under
the session connector gateway:

```text
<session-connector-base>/internal/session/<sessionId>/inference/claude
<session-connector-base>/internal/session/<sessionId>/inference/codex
```

The CLIs append their normal protocol paths to those prefixes. The same connector
also carries webhook and post-clone git traffic. Its policy remains immutable and
scoped only to `session:<sessionId>`.

Claude's final Anthropic request can leave directly from the Worker. Codex's final
ChatGPT request is delegated to one shared native egress shim because the spike
observed ChatGPT's edge reject the corresponding workerd request. That shim is
stateless and multi-tenant, not per user or per session:

```text
Codex -> class-A connector -> Worker -> native HTTP egress shim -> ChatGPT
```

The Worker remains the sole owner of D1 lookup and OAuth refresh. It sends the native
shim only the current access token, ChatGPT account ID, allowlisted request data, and
an internal service authorization over TLS. The shim never receives a refresh token,
never selects a user, and never stores credentials.

## Session authentication contract

The class-A connector injects the session credential after the Sprite boundary. The
provider route SHALL:

1. Resolve the session from `:sessionId`.
2. Validate the connector-injected credential using the same Durable Object authority
   as webhook and git.
3. Resolve the provider credential from the authenticated session's user.
4. Reject a missing, disconnected, revoked, or wrong-user provider record.
5. Restrict the forwarded path to the protocol surface required by the selected
   provider CLI.

The CLI must carry a non-secret placeholder to satisfy its own startup checks. The
Worker never accepts that placeholder as authority. Prefer having the connector
overwrite `Authorization`; if the connector preserves the placeholder, inject a
separate header such as `X-Cloude-Session-Token` and authenticate only that header.
This header-replacement behavior is the remaining final connector spike.

The implementation may initially reuse the current Durable Object `webhook_token`
storage field, but the credential's documented authority becomes the session's
allowlisted webhook, git, and inference routes. It should be named a session
control-plane token in new interfaces.

## Claude Code

### Sprite configuration

Claude Code has a documented LLM-gateway interface:

```sh
export ANTHROPIC_BASE_URL="<session-connector-base>/internal/session/<sessionId>/inference/claude"
export ANTHROPIC_AUTH_TOKEN="cloude-placeholder"
```

- `ANTHROPIC_BASE_URL` points to the Claude path under the session connector.
- `ANTHROPIC_AUTH_TOKEN` is a literal, non-secret placeholder. Claude requires a
  credential source to skip first-run login and sends the value as
  `Authorization: Bearer cloude-placeholder`.
- Fly authorizes the calling Sprite from the connector's session-label policy and
  injects the real session credential after the Sprite boundary.
- The Worker validates that credential, resolves the session user, reads/refreshes
  the encrypted `ClaudeOAuthService` record, and overwrites downstream authorization
  with the current Anthropic OAuth access token.

This uses Claude's documented [`ANTHROPIC_BASE_URL` and
`ANTHROPIC_AUTH_TOKEN`](https://code.claude.com/docs/en/env-vars) behavior.
Anthropic's [authentication precedence
documentation](https://code.claude.com/docs/en/authentication#authentication-precedence)
specifically recommends `ANTHROPIC_AUTH_TOKEN` for a bearer-authenticated gateway or
proxy. The [LLM gateway documentation](https://code.claude.com/docs/en/llm-gateway)
describes the same configuration shape.

### Worker contract

The Claude inference route SHALL:

1. Accept only the connector-injected session credential; never treat
   `cloude-placeholder` as authority.
2. Resolve exactly one authenticated session user and that user's `claude`
   credential.
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

`test:live:claude-oauth-control-plane-proxy` exercised Claude Code 2.1.207 in a fresh
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
server-side. It does not yet prove the final Sprites connector hop: the spike put a
short-lived internal Worker JWT in the Sprite because no connector was present. The
final connector test must use the class-A session connector and prove the Worker
receives an unambiguous connector-injected authority while ignoring the placeholder.

### Claude acceptance tests

Before enabling Claude provider proxying:

- Run bare interactive `claude` and `claude -p` without a login prompt.
- Prove `echo "$ANTHROPIC_AUTH_TOKEN"` reveals only the fixed placeholder.
- Prove another Sprite and an off-Sprite caller cannot use the session connector.
- Exercise streamed text, tool calls, long responses, interruption/resume, errors,
  and context compaction without buffering or protocol corruption.
- Capture the required request-path set and deny every other Worker proxy path.
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
base_url = "<session-connector-base>/internal/session/<sessionId>/inference/codex"
wire_api = "responses"
env_key = "CLOUDE_CODEX_AUTH_TOKEN"
http_headers = { version = "<installed-codex-version>" }
```

`CLOUDE_CODEX_AUTH_TOKEN` contains only a fixed placeholder. Codex 0.144.3 accepted
this custom-provider shape without `auth.json` and sent the value as
`Authorization: Bearer ...` to `POST <base_url>/responses`. This follows Codex's
documented [custom model-provider
configuration](https://developers.openai.com/codex/config-advanced#custom-model-providers).

### Live spike evidence — 2026-07-23

`test:live:codex-oauth-control-plane-proxy` exercised Codex 0.144.3 in a fresh
Sprite through `webhooks.bze.llc`:

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

### Shared native egress shim contract

The production Codex flow SHALL keep the Worker as the authenticated control plane
and use a single shared native service only for the final ChatGPT hop:

1. The Worker validates the class-A session credential and resolves the session user.
2. The Worker reads/refreshes the encrypted Codex OAuth record.
3. The Worker sends the allowlisted method, path, headers, streamed body, current
   access token, and `ChatGPT-Account-ID` to the native shim over an authenticated
   internal request.
4. The shim verifies Worker service authorization; it never accepts a Sprite
   credential directly.
5. The shim rebuilds the upstream request, removes inbound `cf-*`, forwarding,
   proxy-loop, cookie, `x-api-key`, and competing authorization headers, then adds
   only the current OAuth authorization and account ID.
6. The shim streams status, headers, and body without buffering or logging secrets.

The service is horizontally scalable and stateless. It does not access D1, refresh
OAuth, map users, or participate in connector provisioning. It can be a small Node
service using the now-proven ordinary `fetch`; Rust/reqwest is not required.

### Remaining Codex acceptance work

- Deploy the native shim on ordinary VM/container egress and prove the complete
  `Sprite -> class-A connector -> Worker -> native shim -> ChatGPT` flow.
- Prove the Worker-to-shim service credential cannot be replayed by a Sprite and
  rotate it independently of provider credentials.
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
