# Isy Backup Service Testing Contract

Status: active test-design authority

Contract version: 1

Last updated: 2026-10-31

Owner: GoldenIsy / IsyReport operations

Depends on:

- [`BACKUP_SERVICE_CONTRACT.md`](BACKUP_SERVICE_CONTRACT.md)
- [`IMPLEMENTATION_CONTRACT.md`](IMPLEMENTATION_CONTRACT.md)

## 1. Purpose

Testing must answer whether backups remain recoverable when real dependencies,
credentials, networks, processes, and operators fail. Test count and broad
coverage percentages are not completion criteria.

Every required behavior needs the smallest detector that can distinguish:

- a valid backup from a merely uploaded artifact;
- a degraded optional target from a failed required target;
- a live container from a fresh, recoverable backup;
- an isolated restore from a dangerous production mutation;
- a redacted diagnostic from a credential leak.

## 2. Test levels

### 2.1 Unit

Pure tests cover schemas, state transitions, aggregation, naming, path safety,
redaction, scheduling, locks, and freshness calculations. They perform no
network or container access.

### 2.2 Adapter contract

Every source, target, and monitoring adapter runs a shared behavioral contract
against deterministic fakes. The contract covers success, rejection, timeout,
cancellation, malformed output, bounded diagnostics, cleanup, and redaction.

### 2.3 Local integration

An isolated Compose environment supplies real PostgreSQL, MinIO, Restic, and
the candidate service. It proves capture, repository operations, corruption
detection, and restore without external provider credentials.

### 2.4 Live provider qualification

Opt-in tests use dedicated disposable provider accounts or paths. Their result
is a dated qualification receipt, not a permanent assumption that the provider
will behave the same forever.

### 2.5 Deployment acceptance

The exact deployment configuration runs shadow backups, readback, restore,
heartbeat-loss, Slack recovery, and rollback exercises before cutover.

## 3. Required high-value scenarios

Every identifier below must map to an executable detector before version 1 is
complete.

### CFG-001 — Invalid configuration fails before side effects

Given unknown fields, duplicate YAML keys, invalid identifiers, unsafe paths,
or missing secret references, admission fails before network access, staging,
repository initialization, or heartbeat success.

### SEC-001 — Credentials remain isolated

Two deployment instances with different credentials run concurrently. Neither
can access the other's target, secret path, rclone configuration, receipt, or
cache. Logs and process arguments contain no secret values.

### SEC-002 — Redaction survives hostile diagnostics

Fake tools emit credentials in JSON fields, URLs, headers, command errors, and
multiline output. Stored receipts, stdout, stderr, heartbeat payloads, and Slack
events contain only redacted values and bounded output.

### BKP-001 — Paired PostgreSQL and object backup restores coherently

Deterministic relational rows reference deterministic MinIO objects. The
captured backup restores into isolated services, invariant queries pass, and
every referenced object is readable with the expected checksum.

### CON-001 — Quiescence is always released

Inject failure and termination after every phase between consistency entry and
exit. The application resumes writes through the guaranteed cleanup path, and
the backup never reports success when capture was incomplete.

### DST-001 — Required destination controls the verdict

With one passing target and one failed required target, the aggregate result is
`FAIL`. No success freshness timestamp is advanced for the failed target or the
overall required set.

### DST-002 — Optional destination degrades without lying

With every required target passing and one optional target failing, the result
is `WARN`; required-target freshness advances, optional-target freshness does
not, and the finding identifies the optional target without exposing secrets.

### INT-001 — Corrupted capture is rejected before upload

Mutation or truncation of a staged PostgreSQL dump, manifest, or object causes
capture validation to fail before any target snapshot is marked successful.

### INT-002 — Remote corruption is detected

After a successful backup, controlled repository data is removed or corrupted.
Repository/readback validation fails and the affected snapshot cannot produce a
passing restore receipt.

### RST-001 — Restore is real and isolated

The newest eligible snapshot restores into disposable PostgreSQL, object, and
filesystem targets. Source-specific validators pass and production identities
remain untouched.

### RST-002 — Production restore collision is blocked

If a restore target matches a protected production database, bucket, prefix,
or filesystem identity, the command fails before mutation even when an operator
passes force-like arguments not defined by the contract.

### OPS-001 — Interruption is recoverable

Terminate the process during preflight, capture, each target upload, receipt
publication, validation, and cleanup. On restart, state is classified as
`INTERRUPTED`, partial final receipts are absent, locks recover safely, and
plaintext staging follows the failure-retention policy.

### OPS-002 — Resource exhaustion fails safely

Full staging disk, bounded-memory pressure, provider throttling, and command
timeout produce stable findings without unbounded logs, silent partial success,
or deletion of prior backups.

### MON-001 — Silence is detected outside the stack

Kill the backup container and then the entire protected stack. The external
parent detects the missing heartbeat after the configured deadline and routes
one Slack incident without depending on the failed host.

### MON-002 — Failure and recovery are deduplicated

A persistent unchanged failure creates one initial Slack alert and bounded
reminders. The first subsequent healthy state creates one recovery message.
Routine successful heartbeats do not create message spam.

### MON-003 — Alive is not equivalent to backed up

Keep heartbeats healthy while preventing scheduled backups. The parent alerts
on stale backup freshness even though `last_seen` continues to advance.

### RET-001 — Retention preserves the recovery window

Populate snapshots across every retention boundary. Forget/prune removes only
eligible snapshots, retains the configured recovery window, and reports a
failure without destructive fallback when maintenance credentials are absent.

### RET-002 — Append-only writers cannot prune

Where a provider supports append-only operation, the normal backup credential
can create new backup data but cannot delete or overwrite existing recovery
data. Maintenance succeeds only with the separate retention credential.

### PCL-001 — pCloud EU OAuth backup and restore

Using a dedicated EU-region test account or path, provider setup selects the EU
API host, creates a Restic repository through rclone, backs up, reads back,
restores, and validates data without printing the OAuth token.

### PCL-002 — pCloud shared-folder behavior is proven

When shared-folder operation is claimed, the dedicated backup account can see
only the intended shared location needed by the deployment. Backup, list,
readback, and restore work from the runtime credential. The qualification
records any broader account visibility as a security limitation.

### SUP-001 — The released image is reproducible and attributable

The running image reports the expected source revision and embedded tool
versions. The deployed digest matches the published provenance and SBOM, and
rollback selects the previously qualified digest rather than a moving tag.

## 4. Property and fuzz tests

Property tests should generate:

- valid and invalid identifiers;
- nested and escaping paths, symlinks, and Unicode names;
- schedules around daylight-saving changes while stored time remains UTC;
- arbitrary required/optional target result combinations;
- interrupted state-machine sequences;
- credential-shaped strings embedded in structured and unstructured errors;
- bounded manifests near configured size and item-count limits.

Useful invariants include:

- required failure can never aggregate to `PASS` or `WARN`;
- optional failure can never advance that target's success timestamp;
- final state can be published only once;
- every success timestamp corresponds to a durable passing receipt;
- normalized paths never escape their configured root;
- redacted output never contains any supplied secret byte sequence;
- restore targets never overlap protected sources.

## 5. Fixture policy

Fixtures are synthetic and deterministic. Customer data, real credentials,
production bucket names, exported production metadata, and copied logs are
forbidden.

Fixture secrets use unmistakable test-only values and invalid domains. Tests
must still prove those values are redacted. Large-data tests generate content
at runtime from a fixed seed rather than storing large binary fixtures in Git.

## 6. Failure injection

The coordinator and adapters must expose test seams for controlled failure at
named phase boundaries. Production configuration cannot enable those seams.

Failure injection must cover:

- child exit codes and signals;
- hangs and deadline cancellation;
- short reads and writes;
- partial JSON and oversized output;
- DNS, TLS, authentication, and connection failures;
- provider throttling and retry exhaustion;
- disk-full and permission failures;
- atomic rename failure;
- clock skew at the parent boundary;
- duplicate and replayed heartbeat/event delivery.

## 7. Evidence and test gates

Every test result records the source revision, candidate image digest when
applicable, configuration/fixture identity, exact command, start/completion
time, and verdict.

Required gates are:

| Gate | Required evidence |
| --- | --- |
| Pull request | Unit and adapter contracts for affected components |
| Candidate image | Unit, contracts, local integration, restore, redaction, and interruption |
| Provider qualification | Candidate digest plus provider-specific backup/readback/restore receipt |
| Deployment cutover | Exact configuration, shadow window, absence alert, Slack recovery, and restore proof |
| Release | All version-one scenarios applicable to the release, SBOM/provenance, rollback digest |

A broad green suite cannot override a failed required scenario. A provider test
cannot qualify a different image digest or materially different configuration.

## 8. Test hygiene

- Tests own and remove only resources created under their unique run ID.
- Cleanup failure is visible and does not change a product failure into a pass.
- Destructive tests use disposable repositories and isolated restore targets.
- Live-provider cleanup never uses an account root or an unresolved path.
- Secrets enter live tests through protected files or CI secret mounts and are
  never captured as artifacts.
- Retries are limited to behavior that is expected to be transient; assertion
  failures are not retried into green results.
- Time-dependent tests use an injected clock except for explicit real-scheduler
  qualification.

## 9. Current executable coverage

`npm test` currently checks:

- Markdown formatting and balanced fences;
- relative contract links;
- README routing to all authorities;
- uniqueness and presence of the required scenario identifiers above;
- obvious credential material in versioned text/configuration files.
- strict configuration rejection before side effects (`CFG-001`);
- secret-file permissions, diagnostic redaction, and argument isolation
  (`SEC-001`, `SEC-002`);
- required and optional target aggregation (`DST-001`, `DST-002`);
- protected restore-path collision rejection (`RST-002`);
- successful filesystem, PostgreSQL, and MinIO/S3 capture through synthetic
  process adapters;
- Restic repository initialization, snapshot, check, list, and isolated
  restore through a deterministic fake binary;
- atomic state, mutation locking, bounded subprocess timeout, journal and
  receipt publication;
- preservation of successful and per-target freshness across a failed attempt
  (`MON-003`).

These tests prove the local orchestration boundary, not live provider behavior,
real restore correctness, container behavior, or external absence detection.
Each remaining scenario moves from contract-only to executable evidence as its
owning runtime component is implemented.
