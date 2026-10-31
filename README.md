# Isy Backup Service

Reusable, provider-neutral backup service for IsyReport, IsyDocs, and future
Isy services.

The authorities are:

- [`BACKUP_SERVICE_CONTRACT.md`](BACKUP_SERVICE_CONTRACT.md): product vision,
  features, safety boundaries, and acceptance criteria;
- [`IMPLEMENTATION_CONTRACT.md`](IMPLEMENTATION_CONTRACT.md): concrete runtime
  architecture, interfaces, schemas, workflows, and rollout;
- [`TESTING_CONTRACT.md`](TESTING_CONTRACT.md): risk-based test inventory,
  evidence rules, failure injection, and qualification gates.

## Current status

The repository now contains a tested long-running runtime and one-shot command
surface. It can
validate configuration, diagnose dependencies, capture filesystem,
PostgreSQL, and MinIO/S3 data, create and check Restic snapshots, list
snapshots, and restore a snapshot into an isolated directory. `serve` schedules
recurring backups, publishes an independent heartbeat, exposes private
liveness/readiness/status endpoints, recovers interrupted journal state, and
handles orderly container shutdown.

It is not yet a production backup authority. The external heartbeat parent,
Slack bridge integration, retention,
automatic restore tests, and live provider qualification remain open. Existing
IsyReport and IsyDocs backup paths remain active until the contract's migration
gates are completed.

The intended delivery is one versioned OCI image deployed as a separate
instance in each application stack. Every instance has its own configuration,
credentials, repositories, cache, receipts, and monitoring identity.

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
isy-backup serve --config /absolute/config.yml
isy-backup config validate --config /absolute/config.yml
isy-backup doctor --config /absolute/config.yml
isy-backup repository init --config /absolute/config.yml --target <id>
isy-backup backup --config /absolute/config.yml
isy-backup check --config /absolute/config.yml --target <id>
isy-backup snapshots --config /absolute/config.yml --target <id>
isy-backup restore --config /absolute/config.yml --target <id> \
  --snapshot <id> --output /new/isolated/path
isy-backup status --config /absolute/config.yml
isy-backup status --healthcheck --config /absolute/config.yml
```

Repository initialization is deliberately separate from scheduled/manual
backup. Restore refuses output paths that overlap sources, state, staging, or
filesystem repositories.

## pCloud configuration

Restic reaches pCloud through rclone. Start with
[`config/providers/pcloud-eu.example.yml`](config/providers/pcloud-eu.example.yml).
The dedicated account's rclone configuration and the independent Restic
repository password are mounted as owner-only files. `RCLONE_CONFIG` receives
the config path, never the OAuth token as a command argument.

This wiring has deterministic adapter coverage, but it is not live-qualified
against the customer or company pCloud account yet.

## Validation

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
