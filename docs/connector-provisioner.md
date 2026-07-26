# Connector Provisioner

`services/connector-provisioner` is a Cloudflare Worker that creates Sprites Custom API connectors.

A Custom API connector keeps an upstream credential outside the Sprite and injects it at the Sprites gateway, so a Sprite can call an upstream service without ever holding the token. Sprites ships no create API for them: the REST API only creates connections for preset providers, and creation is dashboard-only. This Worker closes that gap.

## Why a separate service

The provisioner needs an authenticated Sprites dashboard session (a Playwright `storageState`) and a Cloudflare Browser Rendering binding. Neither belongs in the api-server:

- The dashboard storage state is a full account credential, far broader than anything else the api-server holds. It stays in this Worker's secrets.
- Browser Rendering is slow and heavyweight relative to normal API request handling.

The api-server reaches the provisioner over HTTP with the provisioner bearer, and will move to a Cloudflare service binding once session integration lands. It never imports this service.

## Mint flow

`POST /connectors/mint` runs a fixed sequence and fails closed at every step:

1. **Dashboard shape gate** - read the connector form and compare it against the expected LiveView fields, events, and auth-method options. On drift, refuse *before* any secret is typed and return the observed shape for diagnosis.
2. **Browser create** - fill the form, run the dashboard's own "Test connection" (which gates the create button), then submit. The requested name gets a random per-attempt suffix.
3. **Reconcile** - list connections over REST and find the connector by that unique name. The suffix is the attribution key: only this call's submit can have produced that name, so a unique match is proof of ownership. An ambiguous match set is never deleted, because it may contain a concurrent mint's live connector.
4. **Scope** - `PATCH` the access policy to `allow_all: false` with the requested sprite labels.
5. **Verify** - re-read the connector and confirm the policy actually applied. Anything short of that deletes the connector and returns an error.

`DELETE /connectors/{gatewayConnectionId}` refuses any connector that is not scoped to session-only labels, so shared connectors cannot be removed through this route. `POST /connectors/live-test` mints and then deletes a disposable connector end to end.

## Ids

Two id spaces exist and are not interchangeable. The **gateway connection id** is what the Sprites REST API accepts; the **detail id** appears in the dashboard URL after create. Routes and stored metadata use the gateway connection id; the detail id is returned only when the dashboard exposed it.

## Conventions specific to this service

- **Error envelope.** Unlike the api-server's `{ error: string }`, provisioner errors are `{ error: { code, stage, retryable, ... } }`. This is a service-to-service API whose caller has to decide whether to retry, which stage failed, and whether cleanup happened; a human-readable string cannot carry that. Boundary rejections (`unauthorized`, `not_found`) send only `code`.
- **Wire contract placement.** Request and response schemas live in `src/connectors.schema.ts` alongside the OpenAPI route definitions, not in a shared package. Extract them into their own package only when a second consumer exists.
- **Durations.** Every response and error carries per-stage timings, because the mint has to fit inside Sprite boot overlap and browser-stage latency is the thing worth watching.

## Failure modes worth knowing

- `dashboard_drift` - the Fly dashboard form changed. The shape contract in `src/dashboard-shape.ts` must be re-synced from the live DOM before minting works again. This has happened once already.
- `reauthentication_required` - the stored dashboard session expired, including the case where the dashboard bounces a mid-submit request to sign-in. A fresh storage state is required.
- `orphan_reconciliation_required` - the submit may have created a connector that could not be found afterward. Retryable; the connector defaults to deny-all on create, so an orphan is inert.
- `connector_reconciliation_failed` - a connector matched the name but could not be uniquely attributed. Deliberately not retryable and never auto-deleted.

Operational setup, the storage-state size limit, and the live-test scripts are in `services/connector-provisioner/README.md`.
