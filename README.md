# Isy Backup Service

Reusable, provider-neutral backup service for IsyReport, IsyDocs, and future
Isy services.

The authorities are:

- [`BACKUP_SERVICE_CONTRACT.md`](BACKUP_SERVICE_CONTRACT.md): product vision,
  features, safety boundaries, and acceptance criteria;
- [`IMPLEMENTATION_CONTRACT.md`](IMPLEMENTATION_CONTRACT.md): concrete runtime
  architecture, interfaces, schemas, workflows, and rollout;
- [`TESTING_CONTRACT.md`](TESTING_CONTRACT.md): risk-based test inventory,
  evidence rules, failure injection, and qualification gates;
- [`docs/SAAS_CONTROL_PLANE_INTEGRATION.md`](docs/SAAS_CONTROL_PLANE_INTEGRATION.md):
  credential-free local installation-agent interface, observations, command
  admission, offline behavior, security boundary, required changes, and tests.

## Current status

The repository now contains a tested long-running runtime and one-shot command
surface. It can
validate configuration, diagnose dependencies, capture filesystem,
PostgreSQL, and MinIO/S3 data, create and check Restic snapshots, list
snapshots, apply explicit policy-driven retention with a separate receipt, and
restore a snapshot into an isolated directory. `serve` schedules
recurring backups, publishes an independent heartbeat, exposes private
liveness/readiness/status endpoints, recovers interrupted journal state, and
handles orderly container shutdown.

Every completed backup also publishes an immutable, allowlisted operation
summary under the private state directory. The local evidence store provides
stable bounded cursors, restart-safe runtime/observation sequencing, atomic
current observations, and retention guards for the latest required success,
latest restore-test proof, and unresolved failure. When `control.enabled` is
true, an owner/group-restricted Unix socket exposes only bounded status,
observation, receipt-history, and operation-detail GET routes. It never copies artifact
paths, repository locations, provider output, finding details, or credentials
into control-plane evidence. Explicitly allowlisted backup, repository-check,
read-data-check, isolated restore-test, and bounded cancellation commands use the same socket and are
durably admitted before execution.

The runtime carries PostgreSQL 16 client tools. PostgreSQL sources must use
major version 16 so capture never relies on an older `pg_dump` than the server.

The IsyDocs development deployment was the first qualified pilot. IsyDocs
production activated the digest-pinned service on 2026-11-01 after dual-target
backup, repeated isolated pCloud restore, guarded snapshot deletion, and live
L4 proof. Its former Jenkins scheduler is disabled and retained only as
rollback evidence. Other services still require their own admission and
retirement decisions.

The intended delivery is one versioned OCI image deployed as a separate
instance in each application stack. Every instance has its own configuration,
credentials, repositories, cache, receipts, and monitoring identity.
The image also exports its complete Compose/config/credential-helper bundle, so
an on-premise host does not need source-repository access.

Planned instances include:

- central IsyDocs;
- IsyReport development;
- each Profilectric/on-premise installation;
- other Isy services added through source and destination adapters.

Plex and its existing pCloud mount remain outside this service.

## Intended image

```text
ghcr.io/goldenisy/isy-backup-agent:<version>
ghcr.io/goldenisy/isy-backup-agent@sha256:<digest>
```

Production deployments must use an approved digest. Runtime credentials must
never be included in the image, repository, Compose source, Jenkins parameters,
or logs.

## Repository layout

```text
isy-backup-service/
├── README.md
├── BACKUP_SERVICE_CONTRACT.md
├── IMPLEMENTATION_CONTRACT.md
├── TESTING_CONTRACT.md
├── package.json
├── config/                       # strict schema and provider examples
├── schemas/                      # runtime receipt schemas
├── src/                          # coordinator, adapters, security, and CLI
└── tests/                        # unit, contract, and local integration tests
```

Generated JavaScript is written to `dist/` and is not versioned.

The container defaults to the long-running service. Build and inspect it locally
without starting the service with:

```bash
docker build -t isy-backup-agent:local .
docker run --rm --read-only --cap-drop ALL \
  --security-opt no-new-privileges isy-backup-agent:local version
```

[`compose.example.yml`](compose.example.yml) shows the long-running security,
health, configuration, and mount boundary.

Remote and on-premise installation is documented in
[`docs/ON_PREMISE_DEPLOYMENT.md`](docs/ON_PREMISE_DEPLOYMENT.md). The public
GHCR image can be pulled anonymously; publishing uses GitHub Actions'
repository-scoped token and does not require a personal Git password or token.

## Implemented commands

```text
isy-backup version
isy-backup deployment export --output /empty/deployment/directory
isy-backup serve --config /absolute/config.yml
isy-backup config validate --config /absolute/config.yml
isy-backup doctor --config /absolute/config.yml
isy-backup repository init --config /absolute/config.yml --target <id>
isy-backup backup --config /absolute/config.yml
isy-backup check --config /absolute/config.yml --target <id>
isy-backup snapshots --config /absolute/config.yml --target <id>
isy-backup restore --config /absolute/config.yml --target <id> \
  --snapshot <id> --output /new/isolated/path
isy-backup restore-test --config /absolute/config.yml
isy-backup forget --config /absolute/config.yml --target <id> \
  --snapshot <id> --confirm-delete <same-id>
isy-backup retention --config /absolute/config.yml --target <id>
isy-backup status --config /absolute/config.yml
isy-backup status --healthcheck --config /absolute/config.yml
```

## Read-only installation-agent socket

The optional local interface is disabled unless this strict configuration is
present with `enabled: true`:

```yaml
control:
  enabled: true
  socket: /run/isy-backup/control.sock
  owner_uid: 1000
  group_gid: 1001
  mode: "0660"
  installation_id_file: /run/isy-backup/installation-id
  allowed_commands: [backup, repository-check, read-data-check, restore-test, cancel]
  max_receipt_page_size: 100
```

The socket supports `GET /v1/status`,
`GET /v1/observations/current`, bounded `GET /v1/receipts`, and
`GET /v1/operations/{operation_id}`, plus the four allowlisted command POST
routes. The installation ID may be fixed or read from the shared public
identity file written after agent enrollment. Unknown routes fail closed.
[`compose.example.yml`](compose.example.yml) initializes and
shares only `/run/isy-backup`; it does not share the Docker socket or publish a
port. The installation-agent container joins supplemental group `1001` and
mounts the same named volume.

Repository initialization is deliberately separate from scheduled/manual
backup. Restore refuses output paths that overlap sources, state, staging, or
filesystem repositories. Snapshot deletion requires the same immutable ID
twice and runs Restic `forget --prune`; provider files must never be deleted
manually because doing so can corrupt the repository.

## pCloud configuration

Restic reaches pCloud through rclone. Start with
[`config/providers/pcloud-eu.example.yml`](config/providers/pcloud-eu.example.yml).
The dedicated account's rclone configuration and the independent Restic
repository password are mounted as owner-only files. `RCLONE_CONFIG` receives
the config path, never the OAuth token as a command argument.

The IsyDocs development flow was first qualified on 2026-10-31 with a
disposable pCloud repository. On 2026-11-01 it was cut over to the dedicated
EU account and the company-owned shared folder visible to that account as
`IsyDocs-backup`. The live qualification proved EU-only OAuth identity,
shared-folder write/read/delete access, initialization, encrypted dual-target
backup, Restic check, isolated restore, PostgreSQL archive parsing, and guarded
`forget --prune`. The retained development repository is below
`IsyDocs-backup/testing/dev-isydocs/restic`.

Restic snapshots must be removed with the guarded `forget` command, never by
deleting repository files in pCloud. rclone file deletion works with OAuth and
pCloud moves deleted provider objects through its Trash lifecycle. Emptying
Trash through rclone is a separate pCloud API limitation that requires storing
the account username/password; this deployment intentionally does not do so.

## Validation

Targets may set `verification: read-data` to run `restic check --read-data`
after every snapshot. This is stronger and more expensive than the default
metadata check; use it when a run must prove remote pack readability.

Run `npm run test:mutation` for the focused mutation gate over result
aggregation, restore guards, mutation locking, and secret redaction. The
initial enforced floor is 60%; raise it only after killing meaningful
survivors rather than excluding difficult production branches.

Install exact locked dependencies and run the checks with:

```bash
npm ci --ignore-scripts
npm test
```

The suite compiles strict TypeScript and runs repository, unit, CLI, and local
integration tests with synthetic data and fake external binaries. No live
credentials or customer data are required.

## Related existing authorities

- IsyReport backup capture and pCloud broker:
  `../isyreport-core/ops/deployment/scripts/`
- IsyDocs pCloud provisioning and readback verification:
  `../isydocs/tools/backup/`
- Slack notification bridge and monitoring:
  `../caddy/services-private/dashboard/`

These are implementation inputs. They remain authoritative for their current
deployments until an explicit, tested migration activates this service.
