# Deployment

KFive currently has a source-verified local Docker Compose deployment and configuration abstractions for local, hybrid, and remote modes. Production remote ingress/TLS, Kubernetes, GitOps, and complete target-host persistence tests are still **Planned** or unverified; this document does not present them as finished.

## Choose a mode

- `KFIVE_MODE=local`: frontend, backend, benchmark worker, MongoDB, Redis, and ChromaDB use the local Compose network. Host Ollama is reached through `OLLAMA_BASE_URL`; Code Lab is an opt-in profile.
- `KFIVE_MODE=hybrid`: the KFive application and data services may run on one host while the explicitly configured AI provider runs elsewhere. If `OLLAMA_BASE_URL` points to a laptop, AI features depend on that laptop remaining online.
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

## Configuration and secrets

Required production secrets must be unique, high-entropy values. Do not commit `.env`, paste secrets into logs, store them in standard project backups, or put credentials inside provider URLs. Keep MongoDB, Redis, and ChromaDB private.

Important endpoint variables include `MONGODB_URL`, `REDIS_URL`, `CHROMA_URL`, `OLLAMA_BASE_URL`, `OPENAI_BASE_URL`, `CUSTOM_LLM_BASE_URL`, `DOCUMENT_PROCESSOR_URL`, and `OCR_SERVICE_URL`. Provider-specific keys are required only for the selected provider. `PUBLIC_BASE_URL` and `CORS_ORIGIN` must match the actual browser origin; production public traffic requires HTTPS.

Settings UI provider/model changes can be live where the backend contract permits. Process-owned database locations, ports, queue topology, and service URLs require a restart.

## Persistence and migration

Compose named volumes are the current persistence boundary. Back up MongoDB, ChromaDB, Redis/AOF where operationally required, and `backend_uploads` as one consistent set. Metadata without matching private files/vectors is not a complete backup. Standard backups must exclude `.env` and plaintext provider/JWT secrets.

Changing `MONGO_ROOT_PASSWORD` does not rotate credentials already initialized inside an existing Mongo volume. Preserve the volume and use the original credential or an authenticated database-side rotation. Recreate only the specific Mongo volume for a confirmed disposable fresh installation; never use a broad volume deletion when other KFive data must survive.

A local-to-remote migration is not yet automated. The safe intended process is maintenance mode, consistent backup, encrypted transfer, restore into private remote storage, configure remote URLs/secrets, validate ownership/counts/checksums, then execute restart/persistence and second-user isolation tests before DNS cutover.

## Production gaps

Before public deployment, complete and verify:

- TLS ingress and WebSocket/SSE routing with a real domain.
- Remote persistent storage, backup/restore, restore drills, and secret management.
- Resource requests/limits, log/metric collection, alerting, and capacity tests.
- Browser/auth/API/provider/database/vector/document/runner end-to-end paths.
- Multi-replica queue, cancellation, quota, and recovery behavior.
- Code Runner and notebook-runtime isolation against the actual Docker daemon.
- Upgrade/rollback procedures and database/data migrations.

See [LOCAL_MODE.md](LOCAL_MODE.md), [HYBRID_MODE.md](HYBRID_MODE.md), [REMOTE_MODE.md](REMOTE_MODE.md), [DOCKER.md](DOCKER.md), and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
