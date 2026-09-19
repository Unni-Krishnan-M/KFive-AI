FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS test
WORKDIR /app
COPY server.cjs server.test.cjs healthcheck.cjs ./
RUN node --test server.test.cjs

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
RUN mkdir -p /run/ollama-bridge && chown 1000:1000 /run/ollama-bridge && chmod 0770 /run/ollama-bridge
COPY --from=test /app/server.cjs /app/healthcheck.cjs ./
USER 1000:1000
CMD ["node", "server.cjs"]
