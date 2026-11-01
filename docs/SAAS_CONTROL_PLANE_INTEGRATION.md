# SaaS Control-Plane Integration Requirements

Status
- Date: 2026-11-01.
- State: P0 protocol, P1 local evidence, and P2 read-only Unix socket
  implemented; P3 and later remain target requirements.
- Scope: changes required in Isy Backup Service for credential-free integration
  with the SaaS-IsyReport installation agent.
- SaaS authority:
  [`FULL_SYSTEM_BACKUP_CONTROL_PLANE_CONTRACT.md`](https://github.com/GoldenIsy/saas-isyreport/blob/main/docs/FULL_SYSTEM_BACKUP_CONTROL_PLANE_CONTRACT.md).
- Ordered cross-repository plan:
  [`FULL_SYSTEM_BACKUP_IMPLEMENTATION_PLAN.md`](https://github.com/GoldenIsy/saas-isyreport/blob/main/docs/FULL_SYSTEM_BACKUP_IMPLEMENTATION_PLAN.md).
- Runtime authority: [`../IMPLEMENTATION_CONTRACT.md`](../IMPLEMENTATION_CONTRACT.md).
- Product authority: [`../BACKUP_SERVICE_CONTRACT.md`](../BACKUP_SERVICE_CONTRACT.md).
- Test authority: [`../TESTING_CONTRACT.md`](../TESTING_CONTRACT.md).

This document is the integration delta for the backup runtime. It does not
make the current implementation production-complete and does not authorize a
live deployment or customer activation.

## Implementation status

The frozen local schemas and fixtures are implemented under
`schemas/control/v1`. The P1 evidence model is implemented in
`src/evidence/store.ts`: real completed backups publish immutable sanitized
summaries, cursors and runtime observation sequence survive restart, current
observations are atomic, pagination is bounded, and pruning protects the latest
required success, latest restore-test evidence, and an unresolved failure.
These projections are schema-validated and mutation-tested. The P2 read-only
Unix interface is implemented behind explicit `control.enabled` configuration.
It publishes no port and exposes no mutation route. Its startup refuses unsafe
parents, symlinks, non-socket collisions, unexpected ownership, and permissive
stale sockets; route bodies, methods, queries, cursors, pages, connections and
timeouts are bounded. The command routes below remain unimplemented.

## 1. Boundary decision

The backup container does not communicate with SaaS directly. It receives no
SaaS URL, device credential, installation private key, platform signing key,
operator token, browser session, or public listener.

The local IsyReport installation agent is the only external protocol client.
It reads bounded backup observations, consumes durable receipt summaries, and
submits typed local commands through an authenticated local interface. The
installation agent owns public transport, device proof, command signature
verification, retry, and the durable external outbox.

The backup runtime continues to schedule and execute backups while SaaS or the
installation agent is unavailable. SaaS delivery is never a prerequisite for
local backup success.

## 2. Required runtime additions

### 2.1 Local control socket

Add an optional Unix-domain socket, defaulting to:

```text
/run/isy-backup/control.sock
```

The socket is disabled unless configured. It is created with explicit owner,
group, and mode and shared through a narrow runtime volume. The backup and
installation-agent containers share only this socket volume; neither receives
the Docker socket.

The local protocol supports:

```text
GET  /v1/status
GET  /v1/observations/current
GET  /v1/receipts?after=<opaque-cursor>&limit=<bounded>
GET  /v1/operations/{operation_id}
POST /v1/commands/backup
POST /v1/commands/repository-check
POST /v1/commands/read-data-check
POST /v1/commands/restore-test
POST /v1/commands/cancel
```

There is no generic command endpoint. Unknown routes, methods, fields, command
types, source IDs, and target IDs fail closed. The interface never accepts an
executable, shell, Restic/rclone argument, environment variable, secret path,
repository URL, database name, bucket, prefix, restore directory, or arbitrary
filesystem path.

### 2.2 Local authorization

Filesystem ownership and mode are mandatory but not the only command control.
Mutating requests carry a local command envelope already verified by the
installation agent. The backup service validates:

- strict versioned schema;
- command and installation binding configured locally;
- command ID and idempotency key;
- immutable command digest;
- issued and expiry timestamps;
- expected backup configuration digest;
- supported capability and minimum protocol version;
- target logical ID where applicable;
- operation concurrency and cancellation state.

The backup service persists local command admission before execution and
returns the original result for an exact retry. Reusing an ID with changed
intent fails closed. Platform signature verification remains the installation
agent's responsibility; the backup container does not receive platform public
or private trust material merely to duplicate it.

### 2.3 No public health assumption

The existing HTTP health listener remains private to the application stack and
must not be published as a SaaS endpoint. The installation agent obtains local
truth through the Unix socket and must be able to report socket absence. SaaS
and the monitoring parent infer backup-service silence externally.

## 3. Observation and receipt schemas

Add strict versioned local schemas compatible with the SaaS summaries:

- `isy.backup.observation/v1`;
- `isy.backup.operation-summary/v1`;
- `isy.backup.receipt-summary/v1`;
- `isy.backup.command/v1`;
- `isy.backup.command-acknowledgement/v1`;
- `isy.backup.command-result/v1`.

The current observation includes:

- deployment/environment logical identity;
- runtime instance ID and monotonically increasing sequence;
- observed time, image identity, configuration digest, and service state;
- scheduler responsiveness, current operation, and next scheduled operation;
- last attempt and last required success;
- freshness per required target;
- last metadata check, full read-data check, retention, and restore-test result;
- stable finding codes and update availability.

A final operation summary includes operation/backup-set ID, kind, trigger,
result, timestamps, source results, target results, verification levels,
bounded findings, image identity, and configuration digest.

The public summary builder must remove:

- artifact paths and restore output paths;
- repository URLs and provider remote paths;
- secret paths and environment data;
- source roots, filenames, object names, database row values, and raw output;
- exception stacks and unbounded provider messages.

The existing local full receipt may retain safe operational fields required by
the backup contract. The SaaS summary is a separate deliberately smaller
projection, not the full receipt serialized unchanged.

## 4. Durable local history

The backup service already owns atomic journals, receipts, heartbeat, and
status. Integration adds:

- stable opaque receipt cursor ordering;
- bounded cursor pagination;
- immutable final operation summaries;
- durable command admission/acknowledgement/result records;
- observation sequence persistence per runtime instance;
- atomic current-observation publication;
- documented retention that cannot delete the latest required-success,
  restore-test, or unresolved-failure evidence before external acknowledgement.

The backup service does not own the external SaaS outbox. The installation
agent copies summaries into its own crash-safe outbox and acknowledges its
local cursor only after the copy is durable. SaaS acknowledgement then allows
the installation agent to retire the external outbox item according to its
policy.

## 5. Required commands

### 5.1 Run backup

`backup` invokes the same operation service as the scheduler. It records a
manual-control-plane trigger and command ID but cannot alter source, target,
retention, or credential configuration.

### 5.2 Repository check

`repository-check` runs metadata validation for one configured logical target
or every configured target. Required/optional semantics remain visible in the
result. It cannot initialize or repair a repository.

### 5.3 Read-data check

`read-data-check` downloads and authenticates repository data according to a
bounded configured policy. The command chooses only a configured target and a
schema-owned policy name. It cannot supply raw Restic arguments or an arbitrary
subset expression.

### 5.4 Restore test

`restore-test` is distinct from the current file restore command. It must:

1. resolve an immutable configured snapshot identity;
2. create a new isolated disposable destination from configuration;
3. validate manifest and source artifacts;
4. restore PostgreSQL only into a disposable verification database and run
   configured invariant queries without row values;
5. validate MinIO/S3 inventory only in an isolated bucket/prefix or local
   verification area;
6. validate configured filesystem invariants;
7. publish a durable receipt bound to snapshot and backup-set identities;
8. clean up only after the receipt is durable.

Production database names, buckets, prefixes, source roots, repositories,
state, staging, cache, and secret paths are rejected. A remote production
restore command is outside version 1.

### 5.5 Cancellation

Cancellation is permitted only for operations whose adapter and state machine
declare safe cancellation. It records request and final state, forwards a
bounded termination signal, and preserves staging/journal evidence required
for recovery. It never converts an uncertain operation into success.

## 6. Configuration additions

The strict configuration schema gains optional blocks equivalent to:

```yaml
control:
  enabled: true
  socket: /run/isy-backup/control.sock
  owner_uid: 1000
  group_gid: 1001
  mode: "0660"
  installation_id_file: /run/isy-backup/installation-id
  allowed_commands:
    - backup
    - repository-check
    - read-data-check
    - restore-test
    - cancel
  max_receipt_page_size: 100

restore_test:
  enabled: true
  directory: /restore-tests
  interval_seconds: 604800
  target_id: secondary
  postgres_verifier:
    host: restore-postgres
    port: 5432
    username: backup_restore
    password_file: /run/secrets/restore-pgpass
    maintenance_database: postgres
    database_prefix: backup_restore_test
```

The exact final schema may use a schedule abstraction instead of cron, but it
must remain declarative and bounded. Configuration contains no SaaS URL,
credential, provider token, database password, or command signing key.

The configured installation ID or enrolled identity file is a local binding
assertion, not an authority by itself. Deployment packaging shares only the
socket directory; the backup service rejects a mismatched command identity.

## 7. Capabilities and version negotiation

The installation agent advertises only capabilities proven by the local backup
runtime. Initial capability names are:

- `backup.observation.v1`;
- `backup.history.v1`;
- `backup.run.v1`;
- `backup.repository-check.v1`;
- `backup.read-data-check.v1`;
- `backup.restore-test.v1`;

The absence of a capability disables the SaaS action at both UI and backend
admission. Unknown future commands are rejected; there is no silent downgrade
or legacy alias.

## 8. Status and failure semantics

The local projection distinguishes:

- service state from backup freshness;
- scheduler health from target success;
- communication observation from operation truth;
- last attempt from last required success;
- metadata check from read-data check;
- restore command completion from validated restore-test success;
- optional target warning from required target failure.

If the installation agent cannot connect to the socket, it reports local
service absence. If the agent is down, the independent parent and SaaS detect
agent/installation silence. The backup service cannot declare external health
merely by writing its own heartbeat.

## 9. Security and privacy

- Run as the existing unprivileged UID with read-only root filesystem, dropped
  capabilities, no-new-privileges, bounded PIDs/resources, and no Docker
  socket.
- Create the socket atomically in a protected runtime directory and refuse a
  symlink, pre-existing non-socket entry, permissive mode, or unexpected owner.
- Bound request bodies, response arrays, strings, cursor size, timeouts, and
  concurrent connections.
- Use no shell for command execution and expose no generic adapter invocation.
- Redact secrets before findings are persisted or returned.
- Do not return raw configuration, environment, stack, provider response, or
  filesystem layout through the control socket.
- Do not accept credentials or credential changes through the socket.
- Record command ID and outcome without recording signed envelopes or secrets
  in ordinary logs.
- Keep provider and Restic credentials in deployment-owned read-only secret
  files; SaaS and the installation agent never receive their values.

## 10. Tests required

Add focused unit, integration, contract, container, mutation, and fault tests
for:

- socket ownership, mode, symlink, replacement, and unavailable-path failures;
- route/method/schema allowlisting and body/array/string bounds;
- exact idempotent command retry and changed-intent rejection;
- installation/configuration digest mismatch;
- unsupported capability and expired command rejection;
- operation lock contention and cancellation races;
- receipt cursor ordering, pagination, restart, and retention boundaries;
- summary redaction against tokens, paths, URLs, filenames, provider output,
  environment dumps, and hostile strings;
- backup/check/read-data/restore-test positive and negative paths;
- restore collision with every protected identity;
- PostgreSQL and MinIO restore validation failures;
- agent absent while backups continue;
- backup service absent while agent remains alive;
- interruption between local receipt publication and agent cursor advance;
- stale/duplicate event replay after restart;
- container read-only/non-root/capability/resource controls;
- mutation testing of command admission, protected-path checks, result
  aggregation, redaction, and receipt acknowledgement rules.

Tests use disposable repositories and isolated restore targets. They never
revoke live credentials, damage a retained repository, touch Plex, or restore
over a production identity.

## 11. Implementation sequence

The cross-repository dependency order and test gates are owned by the
[`Full-System Backup Control Plane Implementation Plan`](https://github.com/GoldenIsy/saas-isyreport/blob/main/docs/FULL_SYSTEM_BACKUP_IMPLEMENTATION_PLAN.md).
Within this repository, work proceeds in that plan's order:

1. freeze local schemas, fixtures and redaction bounds;
2. build sanitized evidence, cursors, persistence and retention guards;
3. expose and harden the read-only Unix socket;
4. add durable admission for backup/check/read-data commands only after the
   read-only Core/SaaS path is qualified;
5. add bounded cancellation after command state/restart behavior is proven;
6. implement and qualify scheduled local restore tests before advertising a
   remote restore-test capability;
7. run full backup-service qualification before Demo and parallel observation.

Core transport, SaaS UI, public ingress, Slack and pilot activation are not
backup-service implementation shortcuts and cannot reorder these local gates.

## 12. Completion criteria

Integration is complete only when:

1. the backup container has no public listener or SaaS credential;
2. local status/history remains available and bounded across restart;
3. external event delivery can be offline without blocking local backups;
4. every remote action maps to one strict configured local command;
5. duplicate and changed-intent commands behave deterministically;
6. restore-test proves source artifacts in disposable destinations;
7. SaaS summaries contain no credentials, content names, raw paths, or raw
   provider output;
8. backup-service, installation-agent, host, network, SaaS, and target outages
   are distinguishable;
9. independent parent monitoring still detects silence and routes Slack;
10. development passes the complete backup, read-data, restore-test,
    interruption, offline replay, and recovery scenario before an on-premise
    pilot.

The existing `restore` command, heartbeat file, or successful scheduled backup
alone does not satisfy this integration contract.
