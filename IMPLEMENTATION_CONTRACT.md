# Isy Backup Service Implementation Contract

Status: proposed implementation authority

Contract version: 1

Last updated: 2026-10-31

Owner: GoldenIsy / IsyReport operations

Depends on: [`BACKUP_SERVICE_CONTRACT.md`](BACKUP_SERVICE_CONTRACT.md)

Testing authority: [`TESTING_CONTRACT.md`](TESTING_CONTRACT.md)

## 1. Purpose and authority

This contract defines how the Isy Backup Service is implemented. The product
contract owns goals, required behavior, and safety boundaries. This document
owns component boundaries, runtime behavior, schemas, adapter interfaces,
workflows, testing, image publication, and rollout.

When the contracts differ, the stricter safety requirement applies until the
conflict is resolved in both documents. Implementation convenience must not
weaken restore proof, credential isolation, required-target failure semantics,
or externally detected absence.

The target SaaS-IsyReport integration and the concrete backup-runtime delta are
owned by [`docs/SAAS_CONTROL_PLANE_INTEGRATION.md`](docs/SAAS_CONTROL_PLANE_INTEGRATION.md).
That integration uses the local installation agent and does not authorize the
backup container to hold SaaS credentials or expose a public listener.

The first implementation is a standalone service. Existing IsyReport and
IsyDocs backup paths remain active authorities until a deployment completes the
migration gates in Section 17.

## 2. Fixed implementation decisions

1. One OCI image serves every deployment. Configuration, not a
   deployment-specific build, selects behavior.
2. Restic owns encrypted repositories, snapshots, deduplication, checks,
   retention, and restoration.
3. rclone supplies provider connectivity not supported natively by Restic,
   including pCloud.
4. Resticprofile may supply reviewed profile, scheduling, hook, and metrics
   behavior. The public `isy-backup` command and Isy schemas remain the stable
   interface.
5. The image contains pinned Restic, rclone, and Resticprofile binaries. It
   never consumes a moving `latest` tag at build or runtime.
6. The Isy coordinator is strict TypeScript compiled to ESM and runs on a
   pinned active-LTS Node.js runtime.
7. YAML is the operator configuration format. JSON Schema is the validation
   authority. Runtime receipts and protocol payloads are JSON.
8. Every target has its own Restic repository and password. Multi-target
   backup does not reuse one repository across providers.
9. The service has a long-running `serve` mode for stack deployment and
   one-shot commands for tests, manual operation, and external schedulers.
10. The container does not receive the Docker socket and does not manage peer
    containers.
11. The monitoring parent is external to the protected application stack. It,
    not the backup container, owns missing-heartbeat and Slack escalation.
12. Plex and the existing Plex pCloud mount are outside this implementation.

## 3. Runtime architecture

```text
                         external monitoring environment
                    +--------------------------------------+
                    | parent heartbeat/freshness monitor   |
                    | alert policy -> existing Slack bridge|
                    +------------------^-------------------+
                                       |
                              authenticated HTTPS
                                       |
+---------------- application stack ---+-------------------------------+
|                                                                      |
|  PostgreSQL ----+                                                     |
|                 |      +------------------------------------------+   |
|  MinIO/S3 ------+----> | isy-backup-agent                         |   |
|                 |      | coordinator -> source adapters           |   |
|  files ---------+      |             -> manifest/receipt writer    |   |
|                        |             -> Restic/Resticprofile       |   |
|                        |             -> rclone                     |   |
|                        +---------+----------------+---------------+   |
|                                  |                |                   |
+----------------------------------+----------------+-------------------+
                                   |                |
                          local/S3/SFTP       pCloud/WebDAV/etc.
```

### 3.1 Process model

`isy-backup serve` is PID 1. It must:

- validate configuration and secret references before becoming ready;
- recover or classify interrupted local operations;
- start the heartbeat loop;
- schedule backup, check, retention, and restore-test operations;
- serialize conflicting operations;
- forward termination signals to active child processes;
- stop accepting new work during graceful shutdown;
- write a final bounded status receipt when shutdown is orderly.

One-shot commands execute the same operation services without starting the
scheduler or heartbeat loop unless explicitly requested.

### 3.2 Container health

The Docker health check runs:

```text
isy-backup status --healthcheck
```

It passes only when configuration is loaded, the scheduler loop is responsive,
and local state is readable. It does not claim that a recent backup exists.
Backup freshness is exclusively a parent-monitor decision.

## 4. Repository structure

The implementation converges on this layout:

```text
isy-backup-service/
├── README.md
├── BACKUP_SERVICE_CONTRACT.md
├── IMPLEMENTATION_CONTRACT.md
├── AGENTS.md
├── Dockerfile
├── compose.example.yml
├── package.json
├── package-lock.json
├── tsconfig.json
├── config/
│   ├── backup-config.schema.json
│   ├── backup-config.example.yml
│   └── providers/
├── schemas/
│   ├── receipt.schema.json
│   ├── heartbeat.schema.json
│   ├── manifest.schema.json
│   └── status.schema.json
├── src/
│   ├── cli/
│   ├── config/
│   ├── domain/
│   ├── operations/
│   ├── adapters/
│   │   ├── sources/
│   │   ├── targets/
│   │   └── monitoring/
│   ├── runtime/
│   └── security/
├── tests/
│   ├── unit/
│   ├── contract/
│   ├── integration/
│   ├── qualification/
│   └── fixtures/
└── .github/workflows/
```

Generated artifacts, provider credentials, repository passwords, staging data,
real deployment receipts, and live rclone configuration are forbidden in the
source repository.

## 5. Configuration implementation

### 5.1 Admission

Configuration admission occurs before network access or mutation:

1. Read exactly one configuration file.
2. Parse YAML with duplicate-key rejection.
3. Validate against `config/backup-config.schema.json`, rejecting unknown
   fields.
4. Normalize paths without resolving through untrusted symlinks.
5. Validate deployment and target identifiers.
6. Validate every referenced secret file's type, ownership, mode, and maximum
   size without logging its content.
7. Compute a redacted configuration SHA-256 identity.
8. Build immutable in-memory domain objects.

Admission errors use `CONFIG_INVALID` or `SECRET_INVALID`, exit before any
backup operation, and identify only the field or secret reference—not its
value.

### 5.2 Identifiers

Deployment, source, and target IDs match:

```text
^[a-z0-9][a-z0-9._-]{0,63}$
```

IDs are stable protocol identifiers. Renaming a target creates a new target
identity and requires explicit repository migration or reinitialization.

### 5.3 Secrets

Configuration stores absolute secret-file paths. Secret values in YAML are
forbidden. Recognized secret kinds include:

- PostgreSQL credentials;
- MinIO/S3 credentials;
- Restic repository passwords;
- rclone configuration or provider tokens;
- SFTP private keys and known-hosts material;
- heartbeat client credentials;
- optional direct-notification fallback credentials.

## 6. Domain model and state machine

### 6.1 Backup set

A backup set is the aggregate root for one capture attempt. Its immutable
identity contains:

```text
schema + deployment + environment + started_at + random_nonce
```

The external ID is:

```text
<deployment>-<UTC basic timestamp>-<first 8 hex of identity SHA-256>
```

### 6.2 Operation states

```text
CREATED
  -> PREFLIGHT_RUNNING
  -> PREFLIGHT_PASSED
  -> CAPTURE_RUNNING
  -> CAPTURE_VALIDATED
  -> TARGETS_RUNNING
  -> TARGETS_RECORDED
  -> FINAL_VALIDATION
  -> PASS | WARN | FAIL
```

Any running state may become `INTERRUPTED` after process loss. Any state may
become `FAIL` through a structured finding. State transitions are append-only
in the operation journal and atomically persisted.

`PASS` requires all required sources and targets to pass their configured
validation level. `WARN` is allowed only for optional-target or non-required
policy findings. Required-source or required-target failure produces `FAIL`.

### 6.3 Atomic state

Manifests, receipts, status, and journal records are written to a
same-filesystem temporary file with restrictive permissions, synchronized, and
atomically renamed. A partially written final JSON file is never valid state.

## 7. Adapter contracts

Adapters are selected through a closed registry. Configuration cannot load
arbitrary modules or execute arbitrary operator-supplied shell commands.

### 7.1 Source adapter

```typescript
interface SourceAdapter {
  readonly type: string;
  preflight(context: SourceContext): Promise<SourcePreflight>;
  capture(context: CaptureContext): Promise<CapturedSource>;
  validateCapture(context: ValidationContext): Promise<SourceValidation>;
  restore(context: RestoreContext): Promise<RestoredSource>;
  validateRestore(context: RestoreValidationContext): Promise<SourceValidation>;
}
```

All methods receive cancellation and deadline signals. Adapter output is
structured; stdout parsing is isolated inside the adapter and bounded.

### 7.2 PostgreSQL source

The PostgreSQL adapter must:

- connect using a secret file, not credentials in command arguments;
- record server major version and client tool version;
- use a custom-format logical dump unless a documented topology requires
  another format;
- default to ownership- and ACL-neutral export flags;
- write to an exclusive backup-set staging path;
- fail on non-zero exit or an empty artifact;
- validate with `pg_restore --list`;
- record SHA-256 and byte size;
- restore only into an explicitly supplied empty verification database;
- run configured invariant queries without exposing row values.

It must never delete, create, or overwrite a production database.

### 7.3 MinIO/S3 source

The default object-source adapter captures through the S3 API into protected
staging. It must:

- list configured buckets/prefixes with bounded pagination;
- capture object bytes and required metadata;
- detect changes during transfer where provider metadata permits;
- create an inventory with redacted key identity, size, version/etag when
  available, and content checksum when available;
- reject partial or unbounded provider listings;
- validate inventory and staged files before snapshotting;
- restore only to an isolated bucket or prefix;
- compare restored inventory without exposing sensitive object names.

Raw live MinIO volume backup is forbidden by default. A separate adapter may
enable it only after proving source quiescence and successful startup/readback
from the captured MinIO storage layout.

### 7.4 Filesystem source

The filesystem adapter must:

- accept configured absolute roots mounted read-only;
- reject roots overlapping state, staging, secrets, cache, or repositories;
- apply explicit include/exclude rules;
- define symlink and cross-filesystem behavior;
- record file count, total bytes, and a redacted root identity;
- restore only below an explicit empty output root.

### 7.5 Cross-source consistency

Multi-source backup cannot claim application consistency without a configured
and qualified strategy:

- `quiesced`: a reviewed application interface pauses relevant writes,
  capture runs, and a finally path resumes writes;
- `ordered-postgres-before-objects`: allowed only when an application contract
  proves referenced objects are durable and immutable before the database
  reference commits;
- `independent`: sources share a reporting ID but no consistency claim;
  forbidden when recovery requires paired state.

The deployment adapter owns consistency entry and exit. It cannot use the
Docker socket. Failure to resume a quiesced application is critical even if
capture succeeded.

### 7.6 Target adapter

```typescript
interface TargetAdapter {
  readonly type: string;
  preflight(context: TargetContext): Promise<TargetPreflight>;
  initialize(context: TargetContext): Promise<RepositoryIdentity>;
  snapshot(context: SnapshotContext): Promise<TargetSnapshot>;
  check(context: CheckContext): Promise<TargetValidation>;
  readback(context: ReadbackContext): Promise<TargetValidation>;
  restore(context: TargetRestoreContext): Promise<RestoredSnapshot>;
  retain(context: RetentionContext): Promise<RetentionResult>;
}
```

Target adapters construct Restic arguments and a sanitized child environment.
Credentials cannot appear in process arguments.

The first target registry contains:

- `filesystem`;
- `sftp`;
- `s3` for AWS S3, MinIO, and qualified compatible providers;
- `rest-server`;
- `rclone` for pCloud, WebDAV, and later qualified remotes.

The rclone adapter uses a dedicated configuration directory per target. It
cannot share writable `rclone.conf` files between targets or deployments.
pCloud EU/US API host selection is explicit and tested during setup.

Repository initialization is never implicit during scheduled backup. It is an
explicit `repository init` operation with its own receipt.

## 8. Backup workflow

1. Acquire the deployment mutation lock.
2. Create the backup-set journal and protected staging directory.
3. Validate source, target, recovery-key, disk-space, and parent preconditions.
4. Enter the configured consistency strategy.
5. Capture required sources in the strategy-defined order.
6. Validate sources and write the immutable capture manifest.
7. Exit the consistency strategy in a guaranteed finally path.
8. Snapshot the manifest and artifacts into each target repository.
9. Record target results independently.
10. Run configured repository and readback validation.
11. Compute `PASS`, `WARN`, or `FAIL` from required semantics.
12. Atomically publish final receipt and status.
13. Report the result to the parent.
14. Remove plaintext staging according to diagnostics policy; successful
    staging is removed immediately by default.
15. Release the lock.

Target concurrency is allowed only after qualification proves safe resource and
result isolation. Version 1 executes targets sequentially.

## 9. Verification and restore

### 9.1 Repository checks

Metadata checks run independently per repository. Data checks use a rotating
subset so the complete repository is covered within a bounded cycle. The cycle
position advances only after a passing check.

### 9.2 Readback

Readback reads actual encrypted repository data through the configured provider
and validates it through Restic. Provider metadata or an upload response alone
cannot satisfy readback.

### 9.3 Restore tests

1. Select the newest eligible passing snapshot.
2. Restore into a newly created isolated output root.
3. Validate manifest and source artifacts.
4. Restore PostgreSQL into an isolated disposable database and run invariants.
5. Restore object data into an isolated bucket/prefix or validate locally,
   according to deployment policy.
6. Publish a receipt bound to backup-set and snapshot identities.
7. Delete isolated state only after the receipt is durable.

Automated restore tests cannot point at production database names, buckets,
prefixes, or filesystem roots.

## 10. Local state and naming

```text
/etc/isy-backup/config.yml         read-only configuration
/run/secrets/                      read-only runtime secrets
/run/isy-backup/control.sock       optional local read-only agent interface
/var/lib/isy-backup/journal/       operation journal
/var/lib/isy-backup/receipts/      final receipts
/var/lib/isy-backup/manifests/     capture manifests
/var/lib/isy-backup/restore-tests/ restore receipts
/var/lib/isy-backup/staging/       protected temporary plaintext
/var/cache/isy-backup/restic/      Restic cache
/var/cache/isy-backup/rclone/      provider cache when required
```

State and cache use separate mounts. Staging and state are mode `0700` and
owned by the runtime UID. Secret mounts are never copied into state.

Operational artifacts follow the product contract's deployment/date/ID layout.
Protocol timestamps are RFC 3339 UTC. Human display may localize time, but
identities and stored receipts never use local time.

## 11. Receipt and protocol contracts

### 11.1 Final receipt

`schemas/receipt.schema.json` requires at least:

```json
{
  "schema": "isy.backup.receipt/v1",
  "operation": "backup",
  "deployment": "profilectric",
  "environment": "production",
  "backup_set_id": "profilectric-20261031T073000Z-4f29c0d8",
  "result": "PASS",
  "started_at": "2026-10-31T07:30:00Z",
  "completed_at": "2026-10-31T07:42:00Z",
  "config_sha256": "<64 lowercase hex>",
  "image": {
    "version": "1.0.0",
    "source_revision": "<git sha>",
    "digest": "sha256:<64 lowercase hex>"
  },
  "sources": [],
  "targets": [],
  "verification": [],
  "findings": []
}
```

Schemas bound array sizes and string lengths. Findings contain stable code,
phase, owner, redacted detail, and next safe action. Raw provider responses and
secret-bearing command lines are forbidden.

### 11.2 Heartbeat

`isy.backup.heartbeat/v1` includes:

- deployment and environment;
- monotonic sequence within one runtime instance;
- runtime instance UUID;
- observed UTC timestamp;
- image and redacted configuration identities;
- state: `STARTING`, `READY`, `RUNNING`, `DEGRADED`, or `STOPPING`;
- last attempt and successful operation timestamps;
- freshness timestamps per required target;
- last readback and restore-test success;
- current operation ID when present;
- latest stable finding codes only.

The parent authenticates deployment identity, rejects stale replays, and treats
silence as failure after its deadline. The agent cannot mark itself externally
healthy merely by sending a heartbeat; the parent computes freshness.

### 11.3 Installation-agent boundary

The backup service does not deliver to the SaaS parent. With explicit control
configuration it exposes bounded read-only evidence on an owner/group-restricted
Unix socket. The installation agent copies accepted evidence into its own
durable public-transport outbox. Backup success never depends on the socket,
the installation agent, or SaaS availability. The socket has no generic API,
public listener, SaaS credential, provider credential, Docker socket, or
mutation route in the read-only phase.

## 12. Slack boundary

The agent emits structured state; it does not format Slack messages as its
primary path. The monitoring parent owns:

- freshness evaluation;
- deduplication and grouping;
- first-failure notification;
- rate-limited reminders;
- recovery notification;
- Slack routing and formatting;
- optional summaries.

The existing Slack bridge should adapt to the parent event contract rather than
being duplicated here. A direct webhook fallback is disabled by default and can
report explicit local failures only. It cannot satisfy absence monitoring.

## 13. Commands and exit codes

Commands are non-interactive except `provider login`. Each supports structured
JSON and redacted human output.

| Exit | Meaning |
| ---: | --- |
| 0 | Operation passed |
| 2 | Configuration or invocation invalid |
| 3 | Preflight or dependency unavailable |
| 4 | Capture failed |
| 5 | Required target or snapshot failed |
| 6 | Verification or restore failed |
| 7 | Retention failed |
| 8 | Lock unavailable or conflicting operation active |
| 9 | Required monitoring delivery failed |
| 10 | Interrupted before completion |

Automation consumes JSON receipts rather than inferring detailed cause only
from the numeric exit code.

`provider login` writes only to an explicit protected output directory, refuses
overwrite without a replace flag, and never prints a token.

## 14. Security implementation

The runtime image must:

- use a numeric non-root UID/GID;
- support a read-only root filesystem;
- set `no-new-privileges`;
- require no added capability for normal operation;
- exclude build toolchains from the final stage;
- invoke child processes without shell interpolation;
- pass secrets through files or sanitized environments only when unavoidable;
- redact known secret values and credential-shaped fields before logging;
- cap captured stdout, stderr, and provider response sizes;
- reject symlink escapes from staging, restore, secret, and source roots;
- treat repository content as data, never executable input;
- disable core dumps by default.

Network policy should permit only configured sources, targets, DNS, time, and
the parent. Provider login is a separate operator workflow and may use broader
temporary egress.

## 15. Image build and publication

The multi-stage build pins:

- base images by digest;
- Node.js runtime by digest;
- Restic version and checksum;
- rclone version and checksum;
- Resticprofile version and checksum;
- PostgreSQL client major version;
- object-transfer client version when required.

CI fails when a checksum, architecture artifact, license inventory, or expected
version is missing. `isy-backup version --json` reports all embedded versions.

Release publication must:

1. run unit, contract, integration, restore, and security checks;
2. build supported architectures from the reviewed commit;
3. generate SBOM and provenance;
4. scan the final image and disposition blocking findings;
5. sign the image or publish registry-verifiable provenance;
6. publish semantic-version and immutable digest references;
7. record the previous qualified digest for rollback;
8. never use `latest` as production authority.

## 16. Test and qualification contract

Detailed scenario ownership and evidence requirements are defined in
[`TESTING_CONTRACT.md`](TESTING_CONTRACT.md). The requirements below are the
implementation boundary that document expands.

### 16.1 Unit tests

Unit tests cover schema rejection, identifiers, paths, state transitions,
required/optional aggregation, identity hashes, atomic writes, error mapping,
redaction, heartbeat projections, schedules, and locks.

### 16.2 Adapter contract tests

Every adapter uses the same controlled contract cases for success,
authentication rejection, timeout, cancellation, partial output, malformed or
oversized output, interruption, retry, redaction, isolated restore, and cleanup.

### 16.3 Local integration tests

An isolated Compose qualification stack contains:

- PostgreSQL with deterministic fixtures;
- MinIO with deterministic objects;
- the candidate backup image;
- local filesystem and MinIO/S3 target repositories;
- isolated restore PostgreSQL and MinIO targets;
- a fake parent recording authenticated heartbeat/events.

It proves backup, multi-target behavior, readback, restore, retention, missing
credentials, target outage, source outage, interruption, cleanup, and parent
delivery recovery.

### 16.4 Live provider qualification

Live tests are opt-in and secret-backed. They use dedicated disposable paths or
accounts and never Plex or production repositories. A qualification records
provider/region, tool versions, credential scope description, initialization,
backup, interruption, check, readback, restore, retention, cleanup, known
limitations, and qualification expiry.

pCloud qualification covers the EU API host, OAuth setup, shared-folder
visibility when claimed, upload, readback, restore, and credential replacement.

### 16.5 Failure paths

Before production, tests exercise container termination during capture/upload,
full staging disk, invalid repository password, revoked provider token, required
and optional target outages, corrupted capture, damaged repository data, stale
locks, parent outage/recovery, externally detected heartbeat silence, and a
restore target colliding with a protected production identity.

## 17. Rollout and migration

### 17.1 Order

1. Isolated local qualification.
2. IsyReport development with local and test pCloud targets.
3. Central IsyDocs after development qualification.
4. One explicitly selected Profilectric/on-premise pilot.
5. Remaining on-premise deployments individually.

Plex is excluded from every stage.

### 17.2 Parallel observation

The new service runs without disabling the incumbent backup. The observation
window must prove scheduled success, required-target success, heartbeat and
absence alerts, Slack failure/recovery, remote readback, isolated restore, and
no secret or customer-data leakage.

### 17.3 Cutover

Cutover requires explicit deployment approval and a receipt naming:

- candidate image digest and configuration identity;
- source and target identities;
- last incumbent successful backup;
- candidate backup and restore-test receipts;
- parent-monitor readiness;
- rollback command and previous authority.

Only after cutover may the incumbent schedule be disabled. Existing backups and
credentials remain until their recovery period expires. Credential revocation
requires separate explicit authorization.

### 17.4 Rollback

Rollback restores the previous qualified digest or re-enables the incumbent
schedule. Incident rollback cannot delete candidate repositories, receipts, or
credentials. Cleanup is a later explicit operation.

## 18. Definition of done for version 1

Version 1 is complete only when:

1. Configuration, manifest, receipt, status, and heartbeat schemas are
   versioned and tested.
2. `serve`, `doctor`, `backup`, `check`, `snapshots`, `restore`, `restore-test`,
   `retention`, `status`, and `version` are implemented.
3. PostgreSQL, MinIO/S3, and filesystem sources satisfy their contracts.
4. Filesystem, SFTP, S3/MinIO, and pCloud targets are qualified.
5. Required/optional multi-target semantics are proven.
6. Recovery-key proof, checks, rotating readback, and isolated restore tests
   are operational.
7. Parent heartbeats detect a stopped container and stale backups.
8. Slack produces first-failure, rate-limited reminder, and recovery messages.
9. Security, redaction, interruption, and rollback tests pass.
10. A signed/provenanced digest-pinned image is published to GHCR.
11. Development completes parallel observation and cutover gates.
12. Setup, login, recovery, upgrade, and rollback runbooks are exercised.

Code completion without restore, absence-detection, and deployment proof does
not satisfy version 1.

## 19. Deferred work

Deferred unless a concrete deployment requires it:

- database engines other than PostgreSQL;
- Kubernetes operators;
- a graphical management UI;
- centrally stored customer provider credentials;
- cross-customer repository sharing;
- automatic provider-account creation;
- automatic destructive repository repair;
- use for Plex media.

Deferred work must extend versioned adapters and schemas rather than bypassing
this contract.
