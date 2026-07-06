## ADDED Requirements

### Requirement: Dashboard-backed Custom API connector creation

The system SHALL provide an internal provisioning workflow that creates Sprites
Custom API connectors through the Sprites dashboard flow when public REST create
support is unavailable.

#### Scenario: Create connector through dashboard flow

- **WHEN** an authorized Cloude user submits a valid Custom API connector
  definition with a plaintext token
- **THEN** the system creates a pending connector record and provisions a
  Sprites Custom API connector through the dashboard-backed workflow

#### Scenario: Dashboard create unavailable

- **WHEN** the dashboard flow cannot be reached or its expected shape is missing
- **THEN** the system marks the connector provisioning attempt as failed or
  paused without exposing the secret to a Sprite runtime

### Requirement: Provisioner-only dashboard authentication

The system SHALL keep Sprites dashboard authentication material scoped to the
connector provisioner and MUST NOT expose dashboard cookies, storage state, CSRF
tokens, or session payloads to clients, Sprite runtimes, logs, or D1 metadata
tables.

#### Scenario: Provisioner authenticates dashboard session

- **WHEN** the provisioner creates a connector
- **THEN** it uses provisioner-only dashboard authentication material to access
  the Sprites dashboard

#### Scenario: Dashboard auth expires

- **WHEN** the provisioner dashboard session is expired or rejected
- **THEN** connector provisioning stops with a reauthentication-required status
  instead of falling back to raw secret injection

### Requirement: Connector metadata persistence

The system SHALL persist Sprites connector metadata in D1 after provisioning,
including the Sprites connection id, provider type, base API URL, auth method
metadata, linked environment ids, access-policy summary, provisioning status,
and sanitized provisioning errors.

#### Scenario: Successful provisioning persists metadata

- **WHEN** the dashboard-backed workflow creates a Sprites connector
- **THEN** the system stores the resulting Sprites connection id and metadata in
  D1 without storing the plaintext token

#### Scenario: Failed provisioning records safe error

- **WHEN** connector provisioning fails after a pending row exists
- **THEN** the system records a sanitized error and status without storing or
  logging the plaintext token

### Requirement: Plaintext secret lifetime

The system SHALL retain plaintext user API secrets only for the minimum time
needed to create the Sprites connector and MUST delete any encrypted pending
secret material after success or terminal failure.

#### Scenario: Secret is submitted for provisioning

- **WHEN** a user submits a plaintext API token for a Custom API connector
- **THEN** the system makes it available only to the provisioning workflow and
  not to the Sprite runtime

#### Scenario: Connector creation completes

- **WHEN** connector provisioning succeeds or reaches a terminal failure
- **THEN** the system deletes the pending secret material and retains only
  non-secret connector metadata

### Requirement: Sprite-scoped connector access policy

The system SHALL configure each provisioned Sprites connector with an access
policy that limits use to the intended Sprite id or Sprite tag.

#### Scenario: Session-scoped connector

- **WHEN** a connector is intended for a single session Sprite
- **THEN** the provisioner configures the connector policy so only that Sprite
  can call the connector

#### Scenario: Tag-scoped connector

- **WHEN** a connector is intended for a dynamic group of session Sprites
- **THEN** the provisioner configures the connector policy by a controlled tag
  and session provisioning ensures intended Sprites carry that tag before use

### Requirement: Dashboard shape drift detection

The system SHALL verify the expected Sprites dashboard form shape before
attempting connector creation and MUST fail closed when required fields, events,
or success states are missing.

#### Scenario: Expected fields are present

- **WHEN** the dashboard form includes the expected Custom API fields and
  LiveView events
- **THEN** the provisioner may proceed with test and create actions

#### Scenario: Expected fields are missing

- **WHEN** the dashboard form no longer exposes required fields or events
- **THEN** the provisioner records dashboard drift and does not submit the
  connector secret

### Requirement: Connection test before create

The system SHALL perform the dashboard Custom API connection test before
submitting connector creation and MUST create the connector only after the
dashboard reports a successful test.

#### Scenario: Test succeeds

- **WHEN** the connection test succeeds for the supplied base URL, token, auth
  method, and test URL
- **THEN** the provisioner submits the dashboard create action

#### Scenario: Test fails

- **WHEN** the connection test fails
- **THEN** the provisioner records the sanitized failure and does not create the
  connector

### Requirement: Reconciliation with Sprites connector state

The system SHALL reconcile D1 connector metadata with Sprites connector state
using supported Sprites REST APIs where available.

#### Scenario: Created connector is fetched

- **WHEN** dashboard-backed creation returns or reveals a Sprites connection id
- **THEN** the system fetches the connection through supported APIs when
  available and stores the observed state

#### Scenario: Connector missing during reconciliation

- **WHEN** reconciliation cannot find a D1-tracked Sprites connector
- **THEN** the system marks the connector unavailable and prevents new sessions
  from depending on it
