FROM node:22-bookworm-slim AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY services/code-runner/package.json services/code-runner/package.json
RUN npm ci --workspace @kfive/code-runner --include-workspace-root
COPY services/code-runner services/code-runner
RUN npm run build --workspace @kfive/code-runner \
    && npm prune --omit=dev

FROM docker:27-cli AS docker-cli

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/services/code-runner/package.json ./services/code-runner/package.json
COPY --from=build --chown=node:node /workspace/services/code-runner/dist ./services/code-runner/dist

USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "services/code-runner/dist/src/healthcheck.js"]
CMD ["node", "services/code-runner/dist/src/main.js"]
