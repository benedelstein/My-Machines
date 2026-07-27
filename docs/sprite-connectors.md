# Sprite Connectors

The API server creates Sprites Custom API connectors through the Sprites REST
API. A connector keeps an upstream credential outside the Sprite and injects it
at the Sprites gateway after evaluating its access policy.

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

Session-scoped connectors must specify `allowedEndpoints`; environment-scoped
connectors may authorize the full configured origin.

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
