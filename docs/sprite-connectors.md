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
  validation and the create, verify, reconcile, and delete sequence.
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
If automatic deletion fails, the structured error retains the gateway connection
id and cleanup cause so the caller can reconcile the orphan.

Session-scoped connectors must specify `allowedEndpoints`; environment-scoped
connectors may authorize the full configured origin.

## Per-session connectors

Each session mints one internal connector during provisioning, as the blocking
`session_connector` setup task between `cloud_container` and `repository`:

- The Sprite is created with `session:<sessionId>` labels, plus
  `env:<environmentId>` when the session came from an environment. Labels are
  platform metadata that in-VM root cannot change, so they are the connector's
  access-policy scope. For sprites created before label support,
  `SessionConnectorService` re-reads the Sprite and repairs missing labels
  before minting; Fly enforces the label policy at the gateway.
- The connector's base URL is `WORKER_URL`, its `test_url` is `WORKER_URL/health`
  (same origin, unauthenticated), and its injected credential is the Durable
  Object's existing `webhook_token`. The token is never handed to the Sprite.
- `allowedEndpoints` pins the session's own paths only: the two webhook routes,
  the ephemeral Git token mint route, and `/health`. Git packfile traffic does not
  traverse the connector while the gateway rejects Git smart-HTTP `Accept` types.
- Non-secret metadata lands in the D1 `session_connectors` table; the gateway
  connection id is also checkpointed in `ServerState.sessionConnectorId`. If the
  D1 write fails, the connector is deleted before the failure surfaces.
- Teardown marks the row `pending_revocation`, deletes and verifies the
  connector, then removes the row. A failed delete keeps the row so the
  connection id survives for reconciliation.

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
- **The ephemeral Git token path is temporary.** When Fly fixes the gateway, rerun
  `test:live:gateway-accept` and require Git's `application/x-git-*` requests to
  reach the Worker before changing production routing. Then add the session's
  Git-proxy path back to the connector allowlist, point post-clone fetch and push
  remotes at the connector gateway, and authenticate them with the
  gateway-injected session token. Stop installing the credential helper and
  issuing ephemeral tokens for new sessions; retain ephemeral-token-mode compatibility
  only until existing sessions have migrated or drained.
- **Provider inference (S4): verify before building.** A client that sends a
  bare `Accept: text/event-stream` for streaming would 406; one that sends
  `application/json` (alone or alongside SSE) works. Check what the Claude and
  Codex CLIs actually send before routing inference through the gateway.

## Legacy sessions

Connector provisioning is unconditional for new sessions. Sessions provisioned
before connectors existed keep their original credential paths for the rest of
their life: a setup run that already finished is never reopened, so those
sessions never mint a connector. Their webhook delivery stays Sprite-held
(`DO_WEBHOOK_TOKEN`), logged as a warning (`"Session has no connector; using
sprite-held webhook token"`) on every process spawn so the remaining legacy
population is visible. It deliberately does not fail closed: the alternative is
a session that cannot report agent output at all.

The initial clone always stays on the direct GitHub path with its short-lived
read-only token. New sessions use rotating ephemeral Git tokens for both post-clone
fetch and push; pre-connector sessions keep their original remotes and bearer.
Removing the legacy webhook validation path is a follow-up,
safe once no pre-connector sessions remain.

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
