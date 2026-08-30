# Sprite Connectors

The API server creates Sprites Custom API connectors through the Sprites REST
API. A connector keeps an upstream credential outside the Sprite and injects it
at the Sprites gateway after evaluating its access policy.

For the overall Sprite security and authentication model — credential classes,
the architecture diagram, and what is implemented vs planned — see
`docs/sprite-security.md`.

## Ownership

- `@repo/sprites-client` owns the REST request and response shapes.
- `services/api-server/src/shared/integrations/sprite-connectors/` owns request
  validation and shared deletion verification. `SessionConnectorService` owns
  the stateless per-session create, verify, reconcile, and cleanup sequence.
- The API server uses its existing `SPRITES_API_KEY`. There is no separate
  connector-provisioner service, public mint route, bearer, or service binding.

## Mint flow

`mintConnector` runs a fixed sequence and fails closed:

1. POST `/v1/oauth/connections/custom_api` with a unique name and the final
   deny-all label and endpoint policy.
2. Use the returned `connection.id` as the authoritative gateway id.
3. Re-read that id and verify the provider, name, labels, and endpoint policy.
4. Delete the connector if verification fails.

Successful responses do not need name reconciliation. A name lookup is used only
when the create request has an uncertain outcome, such as a retryable transport
failure or an invalid response that may have followed a successful mutation.
If automatic deletion fails, the structured error retains the gateway connector
id and cleanup cause so the caller can reconcile the orphan.

Session-scoped connectors must specify `allowedEndpoints`; environment-scoped
connectors may authorize the full configured origin.

## Per-session connectors

Each session's `sprite.session-labels` migration owns the Sprite label set, and
the later `session.connector-resource` migration maintains one internal
connector. New provisioning targets the connector as the blocking
`session_connector` task between `cloud_container` and `repository`; the
coordinator runs the label migration first because it is earlier in the registry:

- The Sprite is created with `session:<sessionId>` labels, plus
  `env:<environmentId>` when the session came from an environment. Labels are
  platform metadata that in-VM root cannot change, so they are the connector's
  access-policy scope. For sprites created before label support,
  `SessionSpriteLabelsService` repairs missing labels independently of connector
  work. The first provisioning pass consumes the successful create response
  once; later passes re-read the Sprite. Its migration contract owns the complete
  label set; reconciliation replaces stale labels and verifies the exact returned
  set.
- The connector's base URL is `WORKER_URL`, its `test_url` is `WORKER_URL/health`
  (same origin, unauthenticated), and its injected credential is the Durable
  Object's existing `webhook_token`. The token is never handed to the Sprite.
- `allowedEndpoints` pins the session's own paths only: the two webhook routes,
  the ephemeral Git token mint route, and `/health`. S4 will add only the exact JSON
  inference-capability mint route. Git packfiles and provider streams do not traverse
  the connector.
- `ServerState.sessionConnectorId` and the active D1 `session_connectors` row
  are locators only. Reconciliation reads each known id directly from Sprites,
  verifies provider, base URL, test URL, and the full order-insensitive access
  policy, and never enumerates connectors by name. It repairs policy in place;
  structural mismatches are replaced and verified before old known ids are
  deleted. The verified D1 row is written before ServerState is checkpointed.
- Connector names are diagnostic random names, not correctness state. A create
  error is not name-reconciled; a retry creates anew, so an ambiguous provider
  response may leave an untracked orphan.
- Teardown marks the row `pending_revocation`, deletes and verifies the
  connector, then removes the row. A failed delete keeps the row so the
  connector id survives for reconciliation.

The gateway base a Sprite calls is
`https://api.sprites.dev/v1/gateway/custom_api/<connectionId>`, built by
`buildConnectorGatewayUrl`. Restricted network modes add that hostname through
`connectorGatewayHostname`; `open` mode is unchanged.

## Gateway Accept-header limitation

The gateway only forwards a request when its `Accept` header contains the
literal token `application/json` or the wildcard, or when `Accept` is absent.
Anything else returns `406 Not Acceptable` before reaching the upstream —
including `text/event-stream`, `text/plain`, `application/octet-stream`, and
git smart-HTTP's `application/x-git-*` types. A `text/*` wildcard does not
match `text/event-stream`, so this is a literal token allowlist rather than
real content negotiation. Verified by live probe 2026-07-28:
`pnpm --filter @repo/api-server test:live:gateway-accept`.

What this means per flow:

- **Webhooks: unaffected.** The vm-agent's webhook client sets no `Accept`, so
  `fetch` sends the wildcard and the gateway forwards.
- **Git data cannot traverse the connector.** Git hardcodes
  `application/x-git-*` accept types and the gateway does not merge multiple
  `Accept` headers. New sessions therefore use the connector only to mint a
  five-minute opaque ephemeral Git token. A repo-local credential helper requests
  that token with `Accept: application/json`; Git then presents it with
  HTTP Basic directly to the Worker Git proxy. The DO stores current and
  previous tokens in its existing secrets table, verifies expiry and
  repository authorization, and revokes them at teardown. Pre-connector
  sessions retain their legacy `git_proxy_secret`. An extracted token is
  replayable off-Sprite while it remains valid; connector identity prevents an
  off-Sprite caller from minting or refreshing one, not replay during the TTL.
- **Provider inference cannot stream through the connector.** A managed OpenRouter
  connector probe on 2026-08-27 proved both failure modes: `stream:true` with bare
  `Accept: text/event-stream` returned `406`; with `Accept: application/json`, the
  connector returned 19 SSE `data:` records behind a fixed `Content-Length`, with
  time-to-first-byte (1.6137s) equal to total time (1.6143s). The OpenRouter
  connector is useful for non-streaming/managed inference, but its presence does not
  imply live SSE support. S4 therefore uses the session connector only for a small
  JSON inference-capability mint. A localhost sidecar sends inference directly to
  the Cloude Node provider proxy, which streams without the Sprites gateway.

## Existing sessions

Completed setup runs remain immutable. Readiness applies the same ordered
runtime migration to sessions created before connector provisioning existed,
then applies the dependent ephemeral-Git-token and network-policy migrations.
Until a connector migration succeeds, the process manager retains the legacy
Sprite-held webhook-token fallback so an older session can still report output.

The initial clone always stays on the direct GitHub path with its short-lived
read-only token. Post-clone fetch and push use rotating ephemeral Git tokens
after the connector and Git cutover migrations complete.

## Live test

From the repository root, load the API server environment and run:

```bash
CONNECTOR_LIVE_TEST_BASE_API_URL=https://httpbin.org \
CONNECTOR_LIVE_TEST_TEST_URL=https://httpbin.org/headers \
CONNECTOR_LIVE_TEST_SPRITE_LABEL=session:live-test-1234 \
pnpm --filter @repo/api-server test:live:sprite-connector
```

The script creates, verifies, and deletes one disposable connector. It does not
print the Sprites token or submitted connector credential.
