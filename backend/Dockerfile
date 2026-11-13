FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend --include-workspace-root
COPY backend backend
RUN npm run build:backend \
    && npm prune --omit=dev --workspace backend --include-workspace-root \
      --ignore-scripts --no-audit --no-fund --offline

FROM node:22-bookworm-slim AS app-runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /workspace/backend/dist ./backend/dist
RUN groupadd --gid 10002 kfive-importer-socket \
    && useradd --uid 10001 --gid 10002 --no-create-home --shell /usr/sbin/nologin kfive-importer \
    && mkdir -p /app/uploads /app/logs /run/kfive-repository-importer \
    && chown -R node:node /app/uploads /app/logs \
    && chown 10001:10002 /run/kfive-repository-importer \
    && chmod 0770 /run/kfive-repository-importer

USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "backend/dist/server.js"]

# The repository importer uses the same reviewed production graph without the
# API's identity or HTTP health metadata at runtime. Compose adds no network.
FROM app-runtime AS repository-importer
USER 10001:10002
HEALTHCHECK NONE
CMD ["node", "--max-old-space-size=128", "backend/dist/repositoryImporterServerMain.js"]

# Install the broker-only Docker client in a source-independent stage so
# application edits do not repeatedly download its package graph.
FROM node:22-bookworm-slim AS notebook-cli
RUN apt-get update \
    && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*

# Only the trusted, portless notebook broker receives the Docker CLI/socket.
# The API and the untrusted runtime images never inherit this stage.
FROM notebook-cli AS notebook-broker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /workspace/backend/dist ./backend/dist
RUN mkdir -p /app/uploads /app/logs && chown -R node:node /app/uploads /app/logs
USER node
HEALTHCHECK NONE
CMD ["node", "backend/dist/notebookWorkerMain.js"]

# Keep the default final target free of Docker tooling.
FROM app-runtime AS runtime
