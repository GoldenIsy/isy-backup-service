# syntax=docker/dockerfile:1.7
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY Dockerfile ./Dockerfile
RUN npm ci --ignore-scripts
COPY config ./config
COPY schemas ./schemas
COPY src ./src
COPY tests ./tests
COPY docs ./docs
COPY scripts ./scripts
COPY README.md BACKUP_SERVICE_CONTRACT.md IMPLEMENTATION_CONTRACT.md TESTING_CONTRACT.md compose.example.yml ./
RUN npm run build && npm prune --omit=dev

FROM postgres:16@sha256:081f1bc7bd5e143dbb6e487b710bbc27712cdcfaced4c071b8e47349aa1b4171 AS postgres-packaging

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS runtime

ARG IMAGE_VERSION=0.3.0
ARG SOURCE_REVISION=development
ARG RESTIC_VERSION=0.14.0-1+b5
ARG RCLONE_VERSION=1.60.1+dfsg-2+b5
ARG POSTGRES_CLIENT_VERSION=16.15-1.pgdg12+2

COPY --from=postgres-packaging /usr/local/share/keyrings/postgres.gpg.asc /usr/local/share/keyrings/postgres.gpg.asc

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && echo "deb [signed-by=/usr/local/share/keyrings/postgres.gpg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      "postgresql-client-16=${POSTGRES_CLIENT_VERSION}" \
      "rclone=${RCLONE_VERSION}" \
      "restic=${RESTIC_VERSION}" \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/isy-backup /var/cache/isy-backup /app \
    && chown -R node:node /var/lib/isy-backup /var/cache/isy-backup /app

WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/schemas ./schemas
COPY --from=build --chown=node:node /app/compose.example.yml ./compose.example.yml
COPY --from=build --chown=node:node /app/docs/ON_PREMISE_DEPLOYMENT.md ./docs/ON_PREMISE_DEPLOYMENT.md
COPY --from=build --chown=node:node /app/scripts/put-secret.sh ./scripts/put-secret.sh

ENV NODE_ENV=production \
    ISY_BACKUP_VERSION=${IMAGE_VERSION} \
    ISY_BACKUP_SOURCE_REVISION=${SOURCE_REVISION}
USER 1000:1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "/app/dist/cli/main.js", "status", "--healthcheck", "--config", "/etc/isy-backup/config.yml"]
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["serve", "--config", "/etc/isy-backup/config.yml"]
