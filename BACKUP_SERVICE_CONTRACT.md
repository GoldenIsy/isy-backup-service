# Isy Backup Service Contract

Status: proposed implementation contract

Contract version: 1

Last updated: 2026-10-31

Owner: GoldenIsy / IsyReport operations

## 1. Vision

The Isy Backup Service provides one reusable, provider-neutral backup agent for
IsyReport, IsyDocs, on-premise customer installations, and future Isy services.

One versioned container image is deployed independently in every application
stack. Configuration selects the data sources, storage destinations, policies,
and monitoring route. Credentials remain unique to the deployment and are
injected only at runtime.

The service must make backup state externally observable. A stopped host or
container must produce an alert through an independent parent monitor even
though the failed container can no longer report its own failure.

The service is successful only when it can prove recoverability. Uploading a
file or creating a snapshot is not sufficient without integrity checking,
remote readback, and scheduled restore tests.

## 2. Goals

1. Use one image and one contract across central, development, and on-premise
   deployments.
2. Support multiple backup sources and storage providers through adapters.
3. Keep every deployment's credentials and repositories isolated.
4. Encrypt data before it leaves the source environment.
5. Capture PostgreSQL and object/file data as one traceable backup set.
6. Verify backups at capture, repository, readback, and restore levels.
7. Detect both explicit failures and silent absence of backup activity.
8. Provide low-noise Slack notifications through the existing monitoring
   infrastructure.
9. Produce stable machine-readable receipts for monitoring, Jenkins, and
   operator diagnosis.
10. Make installation, provider selection, credential replacement, upgrade,
    rollback, and recovery repeatable.

## 3. Non-goals

- The service does not replace database replication or application-level
  revision/history features.
- The service does not manage customer cloud accounts or store customer
  credentials centrally.
- The service does not require Jenkins to hold storage credentials.
- The service does not use the Docker socket to stop, inspect, or control
  arbitrary containers.
- The service does not absorb or modify the private Plex pCloud mount.
- The first release does not promise production qualification for every
  provider supported by rclone.
- A successful upload response is not considered proof of recoverability.

## 4. Foundation and ownership boundary

The implementation should reuse established upstream tools:

| Responsibility | Preferred owner |
| --- | --- |
| Encrypted snapshots, deduplication, retention, restore | Restic |
| Cloud/provider connectivity, including pCloud | rclone |
| Profiles, schedules, locks, checks, metrics, hooks | Resticprofile or equivalent reviewed orchestration |
| PostgreSQL/MinIO paired capture and Isy receipts | Isy Backup Service |
| External absence detection and Slack routing | Isy monitoring parent |
| Image distribution | GHCR under `ghcr.io/goldenisy/` |

The service must not implement its own cryptographic backup format or generic
cloud SDK when Restic or rclone already owns that capability. Isy-specific code
owns consistency, policy, receipts, validation, and integration.

## 5. Deployment model

The same immutable image is instantiated once per deployment:

```text
central IsyDocs             -> deployment=isydocs
IsyReport development       -> deployment=dev
Profilectric installation   -> deployment=profilectric
future service              -> deployment=<stable-service-id>
```

Each instance has independent:

- source credentials;
- destination credentials;
- Restic repository password and recovery material;
- provider configuration;
- repositories and remote paths;
- cache and working directory;
- backup and retention policies;
- receipt history;
- heartbeat identity;
- notification routing.

No shared credential is implied by use of the same image. No runtime secret may
be present in the image layers.

## 6. Required features

### 6.1 Configuration and identity

The agent must:

- accept one versioned, schema-validated configuration document;
- reject unknown or invalid required fields;
- expose deployment, environment, image version, and configuration identity;
- reference secret file paths rather than embedding secret values;
- support required and optional sources and destinations;
- provide `config validate` and `doctor` commands;
- support a dry run that performs no backup or retention mutation.

Configuration failure is fail-closed. The service must not guess a provider,
repository, source, credential, or retention policy.

### 6.2 Connection management

The agent must preflight:

- every enabled source;
- every configured destination;
- repository access;
- recovery-key access;
- monitoring-parent access when enabled.

Connections require bounded timeouts and retries. Logs and receipts must use
redacted endpoint identity and stable error codes without exposing credentials.

### 6.3 Source adapters

The first release must support:

- PostgreSQL logical backup;
- MinIO/S3-compatible object capture;
- files and directories mounted read-only.

Each source adapter defines:

- preflight;
- capture;
- capture validation;
- metadata and checksum production;
- restore;
- restore validation;
- timeout and cancellation behavior.

Future source adapters may add MariaDB/MySQL, SQLite, or application export
commands without changing destination adapters.

### 6.4 Consistent backup sets

One run creates one backup-set ID. All source artifacts, destination snapshots,
manifests, receipts, and verification results bind to that ID.

For IsyReport and IsyDocs, PostgreSQL and MinIO/file content must not be
reported as one successful backup unless the configured consistency procedure
and all required captures succeed.

Every backup set records at least:

- deployment and environment;
- UTC start and completion times;
- backup-set ID;
- source and application version identities when available;
- source artifact identities and checksums;
- target snapshot identities;
- verification level per target;
- final result and stable findings.

### 6.5 Destination adapters

The service must allow multiple destinations in one deployment. Each target has
independent credentials, repository, policy, and result.

Initial qualification targets:

| Target | Transport |
| --- | --- |
| Local filesystem or mounted NAS | Restic filesystem |
| SFTP | Restic SFTP |
| S3-compatible storage and MinIO | Restic S3 |
| pCloud | Restic through rclone |
| WebDAV | Restic through rclone |

Later qualification may cover AWS S3, Azure Blob Storage, Google Cloud Storage,
Backblaze B2, Google Drive, OneDrive, Dropbox, Hetzner Storage Box, and a Restic
REST server.

Underlying tool support does not equal Isy production qualification. A provider
is qualified only after its adapter passes authentication, backup, interruption,
integrity, retention, readback, and restore tests.

Targets are classified as:

- `required`: failure makes the backup set fail;
- `optional`: failure makes the backup set warn while required targets may pass.

### 6.6 Encryption and credentials

The service must:

- use Restic repository encryption;
- separate repository passwords from provider credentials;
- consume secrets through read-only mounted files or Docker secrets;
- reject credentials with unsafe ownership or permissions;
- never print credentials, tokens, private keys, or unredacted provider output;
- support credential replacement without rebuilding the image;
- require recovery-key proof before production activation.

Provider credentials must be scoped to the smallest available folder, bucket,
or account. When a provider cannot sufficiently limit token scope, a dedicated
account is the isolation boundary.

OAuth provisioning is an explicit setup operation. The normal backup runtime
must not start an interactive OAuth listener.

### 6.7 Validation levels

The following levels are distinct and must be reported truthfully:

1. `CAPTURE_VALIDATED`: source export completed and local validation/checksums
   passed.
2. `SNAPSHOT_VALIDATED`: the target repository contains the expected snapshot
   and repository metadata is consistent.
3. `READBACK_VALIDATED`: representative or policy-selected remote data was read
   from the provider and cryptographically verified.
4. `RESTORE_VALIDATED`: a snapshot was restored into an isolated location and
   source-specific validation passed.

No lower level may be described as a higher level. Provider acceptance alone is
not readback validation.

### 6.8 Restore

The service must provide:

- snapshot listing and selection;
- restore to an explicit empty target;
- isolated automated restore tests;
- PostgreSQL import validation;
- representative MinIO/object validation;
- file checksum validation;
- restore receipts bound to the source backup-set ID;
- documented manual recovery commands.

The default policy should run lightweight validation after every backup,
rotating readback checks regularly, and a full isolated restore rehearsal at a
configured interval.

### 6.9 Retention and capacity

Retention is configurable per target and may include hourly, daily, weekly,
monthly, yearly, and keep-within rules.

The service must:

- run pruning as an explicit controlled operation;
- report retention and prune results separately from backup results;
- monitor repository capacity where the provider exposes it;
- warn before capacity exhaustion;
- never mask retention failure;
- preserve the last known recoverable window;
- support append-only writers and separate maintenance credentials when the
  provider permits them;
- support provider object lock/versioning as defense in depth where available.

### 6.10 Scheduling and concurrency

The image may run a reviewed internal scheduler, or execute as a one-shot job
under an external scheduler. The same command contract must serve both modes.

Only one mutating operation per deployment/repository may run at once. Lock
acquisition has a bounded wait and an explicit result.

The service must handle interruption by:

- marking incomplete runs;
- cleaning or quarantining abandoned staging state;
- retaining bounded redacted diagnostics;
- safely restarting or resuming where the provider and engine support it;
- never treating an interrupted run as successful.

### 6.11 Heartbeat and parent-monitor protocol

The backup container cannot be the sole authority for reporting its own health.
An external parent monitor, outside the application stack and preferably outside
the source host, owns absence detection and Slack escalation.

The agent reports at least:

- `last_seen`;
- `last_attempt`;
- `last_success`;
- `last_required_offsite_success`;
- `last_readback_success`;
- `last_restore_test_success`;
- image and configuration identity;
- current operation and last stable result.

The parent alerts on missing heartbeat, missed schedule, stale required backup,
stale off-site backup, overdue readback, overdue restore test, or repeated
failure. `last_seen` must never substitute for `last_success`.

Heartbeat authentication must prevent one deployment from updating another
deployment's status. Customer data and secrets are forbidden in heartbeat
payloads.

### 6.12 Slack and notification behavior

The preferred path is:

```text
backup agent -> structured event/heartbeat -> monitoring parent -> Slack bridge
```

The parent sends notifications for:

- first failure;
- missed heartbeat or schedule;
- stale local or off-site backup;
- failed readback or restore test;
- credential rejection;
- capacity warning;
- recovery after a reported failure;
- optional periodic summary.

Repeated unchanged failures are rate-limited and summarized. Routine successes
are silent by default. A direct agent-to-Slack path may exist only as a
non-authoritative fallback because it cannot detect a stopped container or host.

### 6.13 Receipts, metrics, and error taxonomy

Every command emits a bounded machine-readable receipt. A receipt contains no
secret values or customer content.

Stable finding codes include at least:

- `CONFIG_INVALID`;
- `SECRET_INVALID`;
- `SOURCE_UNAVAILABLE`;
- `CAPTURE_FAILED`;
- `TARGET_UNAVAILABLE`;
- `SNAPSHOT_FAILED`;
- `READBACK_FAILED`;
- `RESTORE_FAILED`;
- `RETENTION_FAILED`;
- `CAPACITY_LOW`;
- `LOCK_UNAVAILABLE`;
- `HEARTBEAT_REJECTED`.

Metrics must expose backup freshness, off-site freshness, restore-test
freshness, duration, transferred bytes, repository size when known, result per
target, and consecutive failures.

### 6.14 Backup naming and operational structure

Backup-set IDs use a stable deployment prefix, UTC timestamp, and collision-safe
suffix, for example:

```text
profilectric-20261031T073000Z-4f29c0d8
```

Names must not contain customer data, database values, usernames, tokens, or
other sensitive material.

Restic owns the internal repository structure. The service must not rename or
rearrange Restic repository objects. Human-readable operational artifacts use a
separate layout:

```text
receipts/<deployment>/<yyyy>/<mm>/<dd>/<backup-set-id>.json
manifests/<deployment>/<yyyy>/<mm>/<dd>/<backup-set-id>.json
restore-tests/<deployment>/<yyyy>/<mm>/<dd>/<backup-set-id>.json
```

Repository tags bind snapshots to deployment, environment, source type, and
backup-set ID.

### 6.15 Runtime hardening

The production container must:

- run without root where source access permits;
- use a read-only root filesystem;
- drop unnecessary Linux capabilities;
- avoid the Docker socket;
- accept only explicit read-only source mounts;
- protect and clean plaintext staging data;
- enforce resource limits, timeouts, and bounded retries;
- support graceful termination;
- pin upstream tools and the final image by digest;
- support required deployment architectures, initially `linux/amd64` and
  optionally `linux/arm64` when a concrete target requires it.

## 7. Command contract

The intended operator surface is:

```text
isy-backup config validate
isy-backup doctor
isy-backup provider login <target>
isy-backup provider test <target>
isy-backup repository init <target>
isy-backup backup [--dry-run]
isy-backup check [target]
isy-backup snapshots [target]
isy-backup restore <target> <snapshot> <output>
isy-backup restore-test [target]
isy-backup retention [target]
isy-backup status
isy-backup version
```

Interactive provider login is a temporary setup operation. Scheduled commands
must be non-interactive and fail explicitly when input is missing.

## 8. Configuration shape

The exact schema will be versioned before implementation. The target shape is:

```yaml
schema: isy.backup-service/v1
deployment: profilectric
environment: production

sources:
  postgres:
    enabled: true
    credential_file: /run/secrets/postgres
  minio:
    enabled: true
    credential_file: /run/secrets/minio

targets:
  - name: local
    provider: filesystem
    repository: /backup/local
    repository_password_file: /run/secrets/restic-local
    required: true

  - name: customer-pcloud
    provider: rclone
    remote_type: pcloud
    remote_path: IsyDocs-backup/Profilectric
    credential_file: /run/secrets/pcloud-rclone.conf
    repository_password_file: /run/secrets/restic-pcloud
    required: true

retention:
  daily: 7
  weekly: 4
  monthly: 12
  yearly: 3

verification:
  repository_check: daily
  readback_cycle: 7d
  restore_test: monthly

monitoring:
  heartbeat_interval: 5m
  heartbeat_deadline: 15m
  credential_file: /run/secrets/monitoring
```

Secret values in configuration are forbidden. Provider-specific extensions
must be schema-owned and fail on unknown fields.

## 9. Image distribution and supply chain

The service belongs in an independent source repository rather than IsyReport
or IsyDocs application source. Releases publish an OCI image to:

```text
ghcr.io/goldenisy/isy-backup-agent:<semantic-version>
ghcr.io/goldenisy/isy-backup-agent@sha256:<manifest-digest>
```

Production stacks use an approved digest. A release must include:

- source revision;
- image digest;
- pinned upstream tool versions;
- dependency and vulnerability review result;
- multi-architecture manifest when required;
- focused backup and restore qualification results;
- rollback digest.

The image contains no environment or customer credentials. If the package is
private, on-premise hosts receive only a package-read credential. Public image
distribution is preferred when source-disclosure policy permits it because it
removes another long-lived on-premise credential.

## 10. Acceptance criteria

The first production release is not acceptable until it proves:

1. PostgreSQL, MinIO, and filesystem capture through supported adapters.
2. Paired backup-set identity and fail-closed required-source behavior.
3. Local, S3/MinIO, SFTP, and pCloud destinations.
4. Independent credentials and repositories per deployment and target.
5. Encryption and recovery-key proof.
6. Capture, snapshot, remote readback, and isolated restore validation.
7. Required/optional destination semantics.
8. Retention, capacity warning, locking, and interrupted-run cleanup.
9. Structured redacted receipts and metrics.
10. Authenticated heartbeat and externally detected absence.
11. Slack failure, recovery, staleness, and missed-heartbeat notifications with
    rate limiting.
12. Digest-pinned installation and rollback in a representative Docker stack.

Production activation requires a successful backup plus restore test for that
deployment's exact source and destination configuration.

## 11. Implementation sequence

1. Freeze the configuration, receipt, heartbeat, and adapter schemas.
2. Build a local-filesystem prototype on the selected Resticprofile/Restic
   foundation.
3. Add PostgreSQL and MinIO capture plus paired manifests.
4. Add local, S3/MinIO, and SFTP qualification.
5. Add rclone destinations and qualify pCloud with isolated credentials.
6. Add readback, restore-test, retention, and crash recovery.
7. Integrate the existing monitoring parent and Slack bridge.
8. Publish the digest-pinned GHCR image and deployment example.
9. Activate development first and exercise failure/recovery paths.
10. Migrate central IsyDocs after development qualification.
11. Package and activate Profilectric/on-premise instances individually.
12. Retire previous backup paths only after equivalent recovery proof and an
    explicit migration decision.

Plex remains untouched throughout.

## 12. Open decisions before implementation

- Whether Resticprofile is used unchanged as the container foundation or its
  required orchestration features are invoked through a smaller wrapper.
- Whether the published image is public or package-read authentication is
  required.
- Exact external parent endpoint and heartbeat authentication mechanism.
- Exact PostgreSQL/MinIO consistency procedure for each product topology.
- Default retention and restore-test policies for central versus on-premise
  deployments.
- Whether the first release needs `linux/arm64` in addition to `linux/amd64`.
- Which provider capabilities qualify append-only or immutable operation.

These decisions may refine implementation, but must not weaken credential
isolation, external absence detection, or restore validation.
