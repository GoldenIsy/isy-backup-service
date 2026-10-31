# Isy Backup Service

Reusable, provider-neutral backup service for IsyReport, IsyDocs, and future
Isy services.

The authoritative product and architecture contract is
[`BACKUP_SERVICE_CONTRACT.md`](BACKUP_SERVICE_CONTRACT.md).

## Current status

The service is in the contract and implementation-planning stage. This folder
does not yet contain a deployable image and must not be treated as a production
backup authority.

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

## Planned repository layout

```text
isy-backup-service/
├── README.md
├── BACKUP_SERVICE_CONTRACT.md
├── compose.example.yml           # future deployment example
├── config/                       # future schemas and examples
├── src/                          # future orchestration and adapters
└── tests/                        # future contract and integration tests
```

Only the two documentation files exist at present. New implementation paths
must be added deliberately with tests and documentation.

## Related existing authorities

- IsyReport backup capture and pCloud broker:
  `../isyreport-core/ops/deployment/scripts/`
- IsyDocs pCloud provisioning and readback verification:
  `../isydocs/tools/backup/`
- Slack notification bridge and monitoring:
  `../caddy/services-private/dashboard/`

These are implementation inputs. They remain authoritative for their current
deployments until an explicit, tested migration activates this service.
