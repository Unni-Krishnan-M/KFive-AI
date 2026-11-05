# Docker

The repaired Compose file uses multi-stage non-root frontend/backend images, internal-only databases, health-gated dependencies, and named persistent volumes. Browser API/WebSocket traffic is proxied same-origin by the frontend Nginx container.

The default stack also runs a dedicated portless Model Benchmarks worker from the backend image. Its inherited HTTP healthcheck is disabled because it serves no HTTP; API status uses a credential-free Redis TTL heartbeat instead. The worker has a read-only root filesystem, bounded CPU/RAM/PIDs, no API JWT signing keys, no Docker socket, and no GPU grant. BullMQ transports opaque run ids, while MongoDB remains canonical and a fenced Redis lease limits benchmark execution.

The default stack deliberately excludes the Code Lab runner:

```bash
cp .env.example .env
# Replace every required placeholder.
docker compose config --quiet
./scripts/kfive-up.sh
```

## Experimental production Compose foundation

Phase 14 has a standalone, deliberately smaller production topology. It does not inherit the development Compose file and does not enable Code Lab, Notebook, Document processing, host Ollama, or observability automatically.

```bash
cp .env.production.example .env.production
chmod 600 .env.production
# Replace every placeholder and image digest.
npm run production:up -- .env.production
```

Preflight treats the file as data rather than sourcing it. It requires HTTPS public/provider URLs, exact HTTPS CORS origins, an authenticated remote provider, distinct strong JWT keys, URL-safe datastore passwords, five immutable image digests, and the exact two-hop production proxy contract. Only `127.0.0.1:8080` is published by default. Put a separately secured TLS reverse proxy in front of that loopback listener; it must replace client forwarding headers and pass the HTTPS scheme. Do not change the bind address to a public interface as a substitute for TLS.

Named volumes use `KFIVE_VOLUME_PREFIX` and survive normal Compose down/recreation. The Experimental maintenance workflow backs up MongoDB, Redis, ChromaDB, and uploads together and restores only into a distinct empty same-datastore-image project; logs remain a separate retention choice. It does not prove cross-host migration or remote DR, so do not infer those from local recovery. Full instructions and limits are in [Remote deployment](REMOTE_DEPLOYMENT.md).

## Opt-in Code Lab profile

Host-loopback Ollama has a separate opt-in [Unix-socket bridge](OLLAMA_HOST_BRIDGE.md):
`./scripts/kfive-up.sh --with-host-ollama`. Add `--no-build` to reuse previously
built local images; omit it when deploying source changes.

Code Lab runs a trusted broker that creates one disposable, restricted runtime container per code run. It is available only through the `code-lab` Compose profile and is never started by the default command.

Before enabling it, configure the broker's Docker endpoint in `.env`. For the standard system daemon:

```bash
CODE_RUNNER_DOCKER_SOCKET=/var/run/docker.sock
# Use the actual numeric group owning that socket:
stat -c '%g' /var/run/docker.sock
CODE_RUNNER_DOCKER_GID=PASTE_THE_REPORTED_NUMBER_HERE
CODE_RUNNER_CONCURRENCY=2
```

The startup script reads only these named `.env` entries (it does not execute or source the file), verifies that the socket is accessible, and rejects a non-numeric or mismatched group ID. Example GIDs are never portable between hosts.

The worker deliberately uses `--pull never`. Review and fetch the two runtime images before startup; `kfive-up.sh` refuses to enable Code Lab when either is absent and prints the required commands.

```bash
docker pull python:3.12-alpine
docker pull node:22-alpine
./scripts/kfive-up.sh --with-code-lab
./scripts/kfive-status.sh --with-code-lab
./scripts/kfive-logs.sh --with-code-lab code-runner
./scripts/kfive-down.sh --with-code-lab
```

The broker has no published port, runs as a non-root user with a read-only filesystem and restricted capabilities, and receives only its Redis URL, concurrency, `/tmp`, and the configured Docker socket. Runtime containers never receive the socket, backend source, uploads, a home directory, or any host mount.

Before accepting queue jobs, the broker lists containers with the exact `com.kfive.code-run=true` label and removes only validated labeled containers older than two minutes. It does not invoke Docker prune or touch recent/unlabeled containers.

Mounting a Docker socket gives the trusted broker control of that daemon and is effectively host-level authority. Prefer a dedicated runner host or a dedicated/rootless Docker daemon with only Code Lab runtime images. A rootless socket commonly lives below `/run/user/<uid>/docker.sock`; set both the socket path and its actual owning group ID rather than copying the system-daemon defaults.

The upstream runtime tags are mutable. Pin and verify image digests before non-development use.

## Opt-in Document Processor and OCR

PDF text extraction and OCR are excluded from default startup so native processing consumes no baseline resources. Enable the isolated processor and matching backend configuration with:

```bash
./scripts/kfive-up.sh --with-documents
./scripts/kfive-status.sh --with-documents
./scripts/kfive-logs.sh --with-documents document-processor
./scripts/kfive-down.sh --with-documents
```

The processor exposes fixed internal `/extract` and `/ocr` contracts and has no host port or persistent mount. It runs as non-root with a read-only root filesystem, a 128 MiB tmpfs, dropped capabilities, `no-new-privileges`, 1 CPU, 512 MiB RAM, 64 PIDs, and an internal-only network shared only with the backend. `DOCUMENT_PROCESSOR_URL` and `OCR_SERVICE_URL` are independently configurable; local Compose points both at this service. Combine `--with-documents` with `--with-host-ollama`, `--with-code-lab`, or `--with-notebook` when those opt-in services are also needed.

## Opt-in Notebook profile

Notebook execution is also excluded from normal startup. Its dedicated portless broker receives the configured Docker socket, while the UID-10001 runtime and distinct UID-10002 verifier never receive the socket or any host mount. The startup script validates the socket/group, requires Docker seccomp, requires AppArmor by default, builds both image targets, rejects identical resolved image IDs, and starts the worker only through the `notebook` profile. The worker must complete a real runtime/removal/verifier canary before it publishes an availability heartbeat.

```bash
stat -c '%g' /var/run/docker.sock
# Set NOTEBOOK_DOCKER_GID to that numeric value in .env.
./scripts/kfive-up.sh --with-notebook
./scripts/kfive-status.sh --with-notebook
./scripts/kfive-logs.sh --with-notebook notebook-worker
./scripts/kfive-down.sh --with-notebook
```

`NOTEBOOK_REQUIRE_APPARMOR=false` is an explicit reduced-isolation development override. It was required for the verified CachyOS host because Docker reported seccomp but not AppArmor. Do not treat that functional result as production isolation proof. See [Notebook Mode](NOTEBOOKS.md) and [Security](../SECURITY.md).

## Configuration-only verification

```bash
docker compose --env-file .env.example config --quiet
env CODE_RUNNER_MODE=container docker compose --env-file .env.example --profile code-lab config --quiet
env NOTEBOOK_EXECUTION_ENABLED=true NOTEBOOK_DOCKER_GID=999 docker compose --env-file .env.example --profile notebook config --quiet
```

Compose configuration validation does not prove that images build, services become healthy, or isolation works. Live Docker and host-isolation verification must still be executed on the target daemon before Code Lab is treated as production-ready.
