# Deployment

KFive has a source-verified local Docker Compose deployment plus an **Experimental** standalone production-Compose foundation for remote/hybrid mode. The latter passed bounded local topology, browser/provider protocol, Hybrid provider outage/recovery, Mongo restart, container recreation, same-host backup/restore, and strict private-CA TLS/proxy checks; it has not run on a remote host or with public DNS/trust and certificate lifecycle, real provider credentials, off-host recovery, or laptop-independent operation. See the [deployment acceptance matrix](DEPLOYMENT_ACCEPTANCE_MATRIX.md).

## Choose a mode

- `KFIVE_MODE=local`: frontend, backend, benchmark worker, MongoDB, Redis, and ChromaDB use the local Compose network. Host Ollama is reached through `OLLAMA_BASE_URL`; Code Lab is an opt-in profile.
- `KFIVE_MODE=hybrid`: the KFive application and data services may run on one host while the explicitly configured AI provider runs elsewhere. A bounded same-host fixture passed the provider protocol/outage contract, not actual network separation. If the provider points to a laptop, AI features depend on that laptop remaining online.
- `KFIVE_MODE=remote`: KFive and its persistence must run on the remote server and use a provider reachable from that server. This mode must not point at development-laptop-only services if independent availability is required.

The mode label does not rewrite endpoints. All service locations and provider credentials come from environment variables; KFive never silently changes provider.

## Local Compose procedure

```bash
cp .env.example .env
# Replace required placeholders with unique secrets and review every endpoint.
docker compose config --quiet
./scripts/kfive-up.sh
./scripts/kfive-status.sh
```

The frontend port defaults to `3000`; set `FRONTEND_PORT=3002` or another unused port when necessary. The backend defaults to host port `5000`. Databases have no published host ports. Normal shutdown preserves named database, vector, upload, queue, and log volumes:

```bash
./scripts/kfive-down.sh
```

Code Lab requires explicit Docker-daemon configuration and `./scripts/kfive-up.sh --with-code-lab`; see [DOCKER.md](DOCKER.md). A Docker socket grants the trusted broker daemon-level authority and is never passed to user runtime containers.

The benchmark worker is portless, receives database/provider configuration but not API JWT signing keys, and reports availability with a short-lived Redis heartbeat. Its default container has no GPU device grant. Model inference can still use host/remote Ollama or a remote provider, but worker-side `nvidia-smi` snapshots remain unavailable until container GPU access is explicitly configured and tested.

## Experimental production Compose procedure

Use the isolated `docker-compose.production.yml` workflow described in [REMOTE_DEPLOYMENT.md](REMOTE_DEPLOYMENT.md). Its launcher requires a mode-0600 file, loopback-only HTTP, HTTPS public/provider values, separate root and application Mongo credentials, and digest-pinned images. Direct `docker compose` invocation bypasses that preflight and is not the supported production procedure.

The separate [production TLS edge](TLS.md) renderer and hardened container contract terminate HTTPS in front of that loopback-only foundation. Local private-CA acceptance passed, but public DNS/certificate lifecycle and a clean remote host remain required.

## Configuration and secrets

Required production secrets must be unique, high-entropy values. Do not commit `.env`, paste secrets into logs, store them in standard project backups, or put credentials inside provider URLs. Keep MongoDB, Redis, and ChromaDB private.

Important endpoint variables include `MONGODB_URL`, `REDIS_URL`, `CHROMA_URL`, `OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, `CUSTOM_LLM_BASE_URL`, `DOCUMENT_PROCESSOR_URL`, and `OCR_SERVICE_URL`. Provider-specific keys are required only for the selected provider. `PUBLIC_BASE_URL` and `CORS_ORIGIN` must match the actual browser origin; production public traffic requires HTTPS.

Browser authentication depends on that exact origin. The frontend requests the explicit cookie transport; the backend sets the host-only `__Host-kfive-refresh` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`, then requires the same exact allowed `Origin` plus the current token-bound CSRF header for refresh and logout. Keep frontend and `/api` on one HTTPS origin, preserve `Set-Cookie` through the edge, and do not rewrite the cookie name, path, or attributes.

The accepted local two-tab Chromium path additionally requires browser Web Locks. Those same-origin tabs serialize refresh, logout, and login/registration replacement, publish a monotonic version-4 state record, and retain a random per-login lineage through refresh so a stale request cannot cross into a replacement account/session. Browsers without Web Locks receive only same-tab serialization and are outside this accepted multi-tab path. Do not treat `localStorage` or Web Locks as an XSS boundary. A tab crash after the successor cookie is installed but before its CSRF/state is persisted fails closed; it is not transparent recovery.

On successful cookie-mode login or registration, the backend also treats the browser's current refresh cookie as a predecessor: a valid signed capability is removed by exact stored hash before the successor is appended or published. Malformed and bad-signature values are overwritten without datastore mutation. On standalone MongoDB, a cross-account replacement is not transactional; a concurrent predecessor rotation can win before the pull, and this mechanism is not all-session or token-family revocation. See [replacement acceptance evidence](../output/verification/production-auth-session-replacement-live.md).

Set `JWT_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN` with the canonical form `<positive integer><s|m|h|d>`; access lifetime must be 1 second–24 hours and refresh lifetime 60 seconds–30 days. The browser cookie has a fixed seven-day maximum age: a shorter refresh JWT can leave an unusable cookie until a correctly authenticated refresh attempt removes the exact stored hash and clears that cookie, while a longer refresh JWT is browser-limited to seven days. This cleanup is request-triggered, not a background sweep; expired sessions that are never presented remain until retention eviction or another explicit lifecycle operation. Production requires distinct high-entropy `JWT_SECRET` and `JWT_REFRESH_SECRET` values. Changing either key invalidates the corresponding outstanding tokens; changing a lifetime affects newly issued tokens only. Logout revokes refresh state but cannot revoke an already issued access JWT before its signed expiry.

Settings UI provider/model changes can be live where the backend contract permits. Process-owned database locations, ports, queue topology, and service URLs require a restart.

## Persistence and migration

Compose named volumes are the current persistence boundary. The Experimental operator workflow in [REMOTE_DEPLOYMENT.md](REMOTE_DEPLOYMENT.md) backs up MongoDB, ChromaDB, Redis persistence, and `backend_uploads` as one offline consistency set and restores only into a different empty same-datastore-image project/prefix. Metadata without matching private files/vectors is incomplete. Backups exclude `.env`, provider/JWT secrets, and logs; inspect restored queues before workers start.

Changing Mongo root or application passwords does not rotate credentials already initialized inside an existing Mongo volume. The production init script creates the database-scoped `readWrite` application user only on first initialization; existing volumes need an authenticated database-side user creation/rotation before switching configuration. Preserve the volume and use a reviewed migration. Recreate only the specific Mongo volume for a confirmed disposable fresh installation; never use a broad volume deletion when other KFive data must survive.

A local-to-remote migration is not yet accepted. The current same-host/same-image drill is a prerequisite, not proof of encrypted transfer, remote storage compatibility, cross-version migration, or DNS cutover.

## Production gaps

Before public deployment, complete and verify:

- Public DNS/trust, certificate issuance/renewal, and external WebSocket/SSE routing on the real remote host; only same-host private-CA routing has passed.
- Remote persistent storage, encrypted/off-host restore drills, and secret management.
- Resource requests/limits, log/metric collection, alerting, and capacity tests.
- Browser/auth/API/provider/database/vector/document/runner end-to-end paths.
- Multi-replica queue, cancellation, quota, and recovery behavior.
- Code Runner and notebook-runtime isolation against the actual Docker daemon.
- Upgrade/rollback procedures and database/data migrations.

See [LOCAL_MODE.md](LOCAL_MODE.md), [HYBRID_MODE.md](HYBRID_MODE.md), [REMOTE_MODE.md](REMOTE_MODE.md), [DOCKER.md](DOCKER.md), and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
