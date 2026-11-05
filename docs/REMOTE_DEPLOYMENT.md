# Remote deployment

## State and verified boundary

The Phase 14 production-Compose foundation is **Experimental**. Local acceptance passed browser/API remote-provider protocol, a Hybrid provider outage/no-fallback/recovery cell, restart/recreation persistence, fresh-volume recovery of MongoDB/Redis/ChromaDB/uploads, and a strict private-CA TLS/proxy cell. The fixtures used local images on one Docker host. This does not prove a real provider, registry pull, remote server, public DNS or public certificate trust/lifecycle, off-host disaster recovery, failover, or independence from the development laptop. See the [deployment acceptance matrix](DEPLOYMENT_ACCEPTANCE_MATRIX.md).

The production topology contains frontend, backend, benchmark worker, MongoDB, Redis, and ChromaDB. Only frontend publishes loopback HTTP. Code Lab, Notebook, Document Processor/OCR, host Ollama, Kubernetes, and observability require separate explicitly accepted deployment slices.

## Prepare configuration

1. Build and publish reviewed backend/frontend images, and select reviewed MongoDB, Redis, and ChromaDB images. Record every immutable `@sha256:` reference.
2. Copy `.env.production.example` to a host-private path named `.env.production`, set mode `0600`, and replace every placeholder.
3. Set `PUBLIC_BASE_URL` to the final HTTPS origin and include that exact origin in `CORS_ORIGIN`.
4. Select `remote` or `hybrid` mode and configure an authenticated HTTPS OpenAI, Anthropic, OpenAI-compatible, or custom endpoint. Provider traffic can contain prompts and generated output and may create cost.
5. Generate distinct random JWT secrets, set canonical bounded lifetimes (`JWT_EXPIRES_IN` is 1 second–24 hours; `JWT_REFRESH_EXPIRES_IN` is 60 seconds–30 days; units are `s`, `m`, `h`, or `d`), distinct Mongo root/application users and URL-safe passwords, and a Redis password. The Mongo initialization script grants only `readWrite` on `MONGO_DATABASE` to the application user; root remains an initialization/administration credential. Do not commit or send this file to build context, logs, tickets, or chat.

Validate and start:

```bash
chmod 600 .env.production
node scripts/production-environment.cjs --env-file .env.production
docker compose --env-file .env.production -f docker-compose.production.yml config --quiet
npm run production:up -- .env.production
```

The startup command validates a deliberately simple non-interpolating environment grammar, pulls the digest-pinned images, starts with health gates, and prints service state. It never removes volumes. Direct `docker compose` invocation bypasses preflight and is not supported for production. A failure must be investigated on the target daemon; bypassing health gates is not a production acceptance.

## TLS and network boundary

The manifest defaults to `127.0.0.1:8080` because its inner frontend provides HTTP only. Use the validated operator-managed container edge in [Production TLS edge](TLS.md): it publishes public HTTP/HTTPS, attaches only to the edge network, forwards to `frontend:8080`, and leaves every internal service private. The outer proxy discards client-supplied forwarding headers, sets `X-Forwarded-For` from its peer and `X-Forwarded-Proto: https`; the frontend appends the second hop and the backend trusts exactly two hops (`TRUST_PROXY_HOPS=2`). A same-host private-CA cell passed this contract, including spoof-resistant rate limiting and SSE. DNS, public certificate issuance/renewal, firewall policy, public-browser/WAN validation, and host supervision remain operator-owned and unverified.

MongoDB, Redis, ChromaDB, the backend, benchmark worker, and provider endpoint publish no host ports. Do not attach databases to the edge network. Provider egress is intentionally separate from the internal application and data networks, but Compose networks are not a hostile multi-tenant or host-compromise boundary.

The browser auth contract is same-origin: serve the frontend and `/api` from the exact HTTPS `PUBLIC_BASE_URL`/allowed CORS origin and preserve backend `Set-Cookie` responses. Browser refresh uses the host-only `__Host-kfive-refresh` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`) plus exact-Origin and rotating token-bound CSRF checks. A split frontend/API origin or TLS termination that drops these headers is outside the accepted contract.

The only accepted multi-tab browser cell is local two-tab Chromium with Web Locks. It serializes auth mutations and uses a random per-login lineage to prevent stale requests from crossing session replacement. No-Web-Locks browsers, broader browser/tab matrices, tab crashes, and remote-browser behavior remain unverified. Because access/CSRF/coordination state remains browser-readable, this is not protection from same-origin XSS or a malicious service worker.

Successful cookie-mode login/registration replacement now revokes the exact refresh session presented by the browser before storing or publishing its successor. The local disposable cell proved same-account login and cross-account registration replacement, replay rejection, unrelated-session preservation, and successor usability. This is not an atomic cross-account transaction on standalone MongoDB, all-session logout, token-family reuse detection, or remote/multi-replica acceptance.

Access and refresh JWTs have separate required types and signing keys. The browser refresh cookie expires after a fixed seven days, even when the configured refresh JWT lifetime differs; a shorter correctly presented JWT is removed hash-exactly and its cookie cleared after rejection, while a longer JWT remains browser-limited by the cookie. This is lazy presented-session cleanup, not background expiration. Logout revokes the current refresh session, not an already issued access JWT; size the bounded access lifetime for that residual window and treat key rotation as a separately planned operational event.

## Persistence, upgrade, and migration

The stable volume names are `${KFIVE_VOLUME_PREFIX}_mongodb_data`, `_redis_data`, `_chromadb_data`, `_backend_uploads`, and `_backend_logs`. Container or network recreation without `-v` preserves them. Never use `docker compose down -v` for a real deployment.

### Offline application backup and restore

From a trusted Docker host, with the validated stack running, create a new private bundle:

```bash
npm run production:backup -- --allow-maintenance-backup \
  --env-file /secure/kfive.production.env \
  --output /secure/kfive-backups/2026-10-24
```

Backup verifies the exact running project/images/mounts, refuses source volumes above 7 GiB, stops frontend/API/worker writers, refuses any active BullMQ job, logically dumps MongoDB, forces and quiesces Redis, quiesces ChromaDB, archives Redis/Chroma/uploads, writes the manifest last, and attempts to restart every exact stopped container. Keep enough private destination space for the artifacts plus restore staging. The directory is mode 0700 and files 0600. Secrets and logs are excluded. The checksum manifest is not a signature or encryption; protect the plaintext bundle with external authenticated encryption and off-host policy.

Restore requires a different, empty Compose project and volume prefix, the same datastore image references/database name, and no pre-existing destination containers, networks, or volumes:

```bash
npm run production:restore -- --allow-new-volume-restore \
  --env-file /secure/kfive.restore.env \
  --backup /secure/kfive-backups/2026-10-24
```

Artifacts are copied from no-follow descriptors into private staging, checksum/type/path/member/size limits are enforced, and each new volume is post-verified with a unique ownership token before writing. On failure, only those token-owned new resources are rolled back. Successful restore leaves the initialized Mongo container stopped. Inspect restored Redis/BullMQ queue state before starting workers; stale jobs may replay.

This is offline, same-host/same-datastore-image application recovery. It is not hot backup, cross-version migration, Kubernetes/observability recovery, signed/encrypted retention, or remote DR. Before upgrades, prove a restore into an isolated project, pin new digests, review migrations, and rehearse rollback separately. Copying live database directories is not accepted. Cross-host migration and laptop-independence remain Planned.

The Mongo application user is created only when the official image initializes an empty database volume. For an existing Mongo volume, create or rotate the database-scoped user through an authenticated administrative procedure before changing the production environment; changing environment text alone does not change stored database users.

## Security and operating limits

- Keep `.env.production` mode `0600`; access to Docker or the host can reveal environment variables and Redis command arguments. Use platform secret management when a future application `_FILE`/secret-provider contract is implemented.
- Run a single API backend and benchmark worker for the currently documented process-local Agent/Workflow execution limits. Horizontal failover and cancellation are not accepted.
- Patch by publishing new reviewed digests; never replace an immutable digest in place or deploy mutable tags.
- Monitor disk, volume capacity, database health, provider errors/cost, queue backlog, certificate expiry, and backup restoration. The local-kind observability profile is not a production remote-monitoring deployment.
- Do not expose databases, internal services, Docker sockets, or privileged workers. The omitted Code Lab and Notebook brokers require their own daemon-isolation design.
- Treat prompts, outputs, uploaded files, logs, exports, database contents, and backups as sensitive application-readable data.

## Remaining acceptance before remote use

Local disposable runs now prove a bounded single-user authenticated Mongo-read burst floor, a same-host Hybrid provider outage/recovery contract, and strict private-CA TLS/proxy behavior; see `output/verification/production-performance-live.md`, `output/verification/production-hybrid-live.md`, and `output/verification/production-tls-live.md`. A production claim still requires a clean target host with functional healthcheck isolation, registry pulls by exact digest, public DNS/trust and certificate lifecycle, a real authenticated provider, remote persistence/restoration, upgrade/rollback rehearsal, operational monitoring/alert delivery, sustained/mixed and multi-user performance review, and proof after the development laptop is offline. Until those checks pass, this file is deployment guidance for the Experimental foundation, not a production certification.
