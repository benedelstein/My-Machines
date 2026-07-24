# Connector provisioner

Dedicated Cloudflare Worker that creates Sprites Custom API connectors through the
authenticated Phoenix LiveView dashboard, then discovers, scopes, and verifies them
through the supported Sprites REST API.

The Worker keeps dashboard storage state and the Sprites API token in
provisioner-only secrets. Every operation requires a separate provisioner bearer:

- `POST /v1/connectors/mint` creates and returns a verified connector.
- `DELETE /v1/connectors/:id` deletes a connector and confirms it is gone.
- `POST /v1/connectors/live-test` mints and then deletes a disposable connector.

## Local unit tests

```bash
pnpm --filter @repo/connector-provisioner test
```

## Disposable live test

Create a Playwright storage-state file from an authenticated Sprites dashboard
session, following [Playwright's authentication guidance](https://playwright.dev/docs/auth).
Treat that file like a password and never commit it. The temporary Worker currently
receives the compact JSON through a Worker secret, so confirm it fits Cloudflare's
5 KB per-variable limit:

```bash
wc -c /secure/path/sprites-storage-state.json
export SPRITES_DASHBOARD_STORAGE_STATE="$(jq -c . /secure/path/sprites-storage-state.json)"
```

Then export `SPRITES_API_KEY`, `SPRITES_ORG_SLUG`, and the
`CONNECTOR_LIVE_TEST_*` variables shown in `.env.example` and run:

```bash
pnpm --filter @repo/connector-provisioner test:live
```

The script starts `wrangler dev --remote` with a temporary mode-0600 env file,
creates a uniquely named connector, applies the supplied Sprite label, verifies
`allow_all` is false, deletes the connector, and confirms it no longer exists.
It never prints the dashboard storage state, Sprites API token, or dummy connector
token.

The test requires Cloudflare Wrangler authentication and a Browser Run-enabled
Cloudflare account. It does not deploy the Worker or persist the supplied secrets.

If the storage state exceeds 5 KB, do not trim cookies blindly. The production
follow-up should encrypt the state and load it from KV, which is also the storage
pattern in [Cloudflare's Browser Run example](https://developers.cloudflare.com/browser-run/playwright/#storage-state).

## Deployment boundary

For a deployed spike, set all four provisioner secrets listed in `wrangler.jsonc`
with `wrangler secret put`, then deploy this package. The public workers.dev route
remains bearer-protected for the spike. Before session integration, disable that
route and bind the API Worker to this Worker with a Cloudflare service binding.
