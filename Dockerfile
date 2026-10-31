# syntax=docker/dockerfile:1.7
FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY config ./config
COPY schemas ./schemas
COPY src ./src
COPY tests ./tests
COPY docs ./docs
COPY README.md BACKUP_SERVICE_CONTRACT.md IMPLEMENTATION_CONTRACT.md TESTING_CONTRACT.md compose.example.yml ./
RUN npm test && npm prune --omit=dev

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS runtime

ARG IMAGE_VERSION=0.1.0
ARG SOURCE_REVISION=development
ARG RESTIC_VERSION=0.14.0-1+b5
ARG RCLONE_VERSION=1.60.1+dfsg-2+b5
ARG POSTGRES_CLIENT_VERSION=15.19-0+deb12u1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      "postgresql-client-15=${POSTGRES_CLIENT_VERSION}" \
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

ENV NODE_ENV=production \
    ISY_BACKUP_VERSION=${IMAGE_VERSION} \
    ISY_BACKUP_SOURCE_REVISION=${SOURCE_REVISION}
USER 1000:1000
ENTRYPOINT ["node", "/app/dist/cli/main.js"]
CMD ["version"]
