# Notebook Mode

State: **Experimental editing and execution**.

KFive provides an authenticated Python/Markdown notebook workspace at `/app/notebooks`. It is a bounded run-and-review surface, not a Jupyter server, terminal, package manager, file browser, IDE, or VS Code clone.

## Available now

- Owner-scoped workspace notebooks with immutable project association and archived-project read-only behavior.
- Create, list, open, edit, save, and confirmed delete with optimistic `expectedRevision` checks.
- Python and Markdown cells with add, remove, reorder, and type controls.
- Explicit whole-notebook Run and Stop controls, dependency-specific availability, polling progress, retained history/detail, verified inline output, metrics/artifact metadata, and confirmed terminal-run deletion.
- MongoDB persistence for immutable run snapshots, status/timeline, executed notebook JSON, bounded metrics, and bounded artifacts. BullMQ carries only an opaque run id and uses attempts-one delivery.
- One active run per owner, 100 retained notebooks and runs per owner, 32 cells, 64 KiB UTF-8 source per cell, 256 KiB per notebook, and a 1–30 second per-cell timeout. The trusted broker also enforces a 310-second wall limit, 768 MiB RAM, one CPU, 128 processes, bounded output, and automatic cleanup by default.

Execution is opt-in through the `notebook` Compose profile. Only the dedicated, portless trusted broker receives Docker-daemon access. It creates a disposable UID-10001 runtime with a read-only root filesystem, no network or IPC namespace sharing, no capabilities, no privilege, no host mounts, no Docker socket, and bounded tmpfs/resources. Input is copied through a strict hash-checked stream into root-owned read-only tmpfs; it is not mounted from the host.

The runtime executes one fixed Python 3.12/nbclient job and exports a bounded candidate envelope. The broker then force-removes that container before starting a separate UID-10002 verifier image. The verifier executes no notebook code, revalidates immutable cell identity/source/tags, rejects undeclared, linked, noncanonical, mismatched, or unsafe files, and recreates only canonical inert text/JSON/PNG/JPEG output, scalar metrics, and allowlisted artifacts. Runtime and verifier image IDs are required to be distinct and are recorded on successful runs.

MongoDB is canonical for run state. The worker uses an expiring global Redis lease and TTL health record, polls canonical cancellation as well as receiving Redis notifications, rejects stale lifecycle transitions, interrupts work on heartbeat/lease loss, and performs a real two-stage isolation canary before advertising availability. Startup also removes only containers carrying KFive's exact notebook runtime/verifier labels.

## Start it

Set the actual numeric group that owns the selected Docker socket; group IDs are host-specific:

```bash
stat -c '%g' /var/run/docker.sock
# Put that value in .env as NOTEBOOK_DOCKER_GID.
./scripts/kfive-up.sh --with-notebook
./scripts/kfive-status.sh --with-notebook
./scripts/kfive-logs.sh --with-notebook notebook-worker
./scripts/kfive-down.sh --with-notebook
```

`NOTEBOOK_REQUIRE_APPARMOR=true` is the fail-closed default and also requires Docker seccomp. The 2026-09-02 CachyOS live test had seccomp but no AppArmor, so it explicitly used `NOTEBOOK_REQUIRE_APPARMOR=false`. That proves the local functional/container lifecycle path under reduced host isolation; it is not a production hardening certification. Keep the default for production-capable hosts.

## Verification evidence

- The host runtime suite has 68 checks: 65 pass and three real-kernel/image checks skip because nbclient/nbformat are image-only.
- The Docker build executes all 68 checks, including real kernel state, supervisor workspace, streamed preload/export, and the complete runtime-to-verifier pipeline.
- The live authenticated path through the frontend proxy passed registration, dependency status, notebook persistence, real Python output, distinct runtime/verifier identities, immutable snapshots, cancellation, history, backend-restart persistence, and cleanup.
- On 2026-09-15 the separately executed repository test-script components passed 617 checks plus the three intentional image-only skips; all lint targets and frontend/backend/Code Runner production builds passed. The notebook image and live lifecycle evidence above dates to 2026-09-02.

## Known limitations

- Python only; Run executes the saved notebook as a whole, not a persistent interactive kernel or individual cell.
- Status uses polling rather than SSE. Artifact metadata is shown, but there is no artifact-download API.
- Runtime dependency versions are constrained but the transitive Python graph and local image tags are not pinned by immutable digest.
- The Redis lease and Mongo compare-and-swap checks are fail-closed for the current one-worker design, but there is no transactionally shared fencing epoch across Redis and Mongo for horizontally scaled notebook workers. Run only one notebook worker.
- No age-based/bulk run retention, remote/Kubernetes notebook proof, multi-tenant penetration test, or production AppArmor-host E2E has been completed.
- Notebook source, outputs, metrics, and artifacts are application-readable persistent data. Do not put secrets in cells.

## Verify the source

```bash
npm test
npm run lint
npm run build
```

The API prefix is `/api/v1/notebooks`. Never invoke the runtime image directly with untrusted input or give a user-code container the Docker socket.
