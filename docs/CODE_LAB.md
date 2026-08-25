# Code Lab

Code Lab is a focused online compiler and AI coding playground. It is intentionally not an IDE or VS Code clone.

## Current state

The source implementation is **Experimental** and disabled by default. It includes a validated, owner-scoped Code Run API, a dedicated Redis queue, a separate runner worker/core, and a browser playground for Python and JavaScript. Unit tests exercise request validation, state transitions, output limits, cancellation orchestration, hardened Docker arguments, and cleanup with injected adapters.

Real untrusted-code execution is not considered implemented until the host-Docker isolation suite below has passed. Do not enable Code Lab on a public deployment based only on unit tests.

## Trust boundary

```text
Browser
  -> authenticated /api/v1/code API
  -> MongoDB CodeRun record + Redis code-runs queue
  -> dedicated code-runner worker
  -> one disposable runtime container per run
```

- The backend never starts an interpreter/compiler or executes submitted code.
- Runtime image, command, filename, resource limits, Docker flags, and network policy are server-owned allowlist values.
- Only the trusted runner broker controls Docker. User runtime containers do not receive a Docker socket, host mount, device, GPU, published port, or KFive secret.
- Runtime containers are non-root, read-only, networkless, IPC-isolated, capability-free, and constrained by CPU, memory, PID, file, output, and time limits.
- Source is copied under a fixed filename through a broker-created temporary workspace and removed after the run.
- The runner is a separately started component and has no public HTTP port.
- On startup, the broker reaps only validated containers carrying its exact label and older than two minutes; it never performs a daemon-wide prune.

A Docker daemon socket gives the broker control over that daemon. For production, use a dedicated runner host or rootless/dedicated Docker daemon rather than the KFive application daemon.

## Explicit local enablement

Code Lab is behind the `code-lab` Compose profile. Normal `./scripts/kfive-up.sh` startup forces the backend runner mode to `disabled` and does not start the broker. To opt in:

1. Set `CODE_RUNNER_DOCKER_SOCKET` to the dedicated/rootless daemon socket (or `/var/run/docker.sock` for development), and set `CODE_RUNNER_DOCKER_GID` to that socket's numeric group ID. `stat -c '%g' /path/to/docker.sock` prints it.
2. Review and pre-pull `python:3.12-alpine` and `node:22-alpine`. Runs use `--pull never`; the startup script refuses to enable Code Lab if either image is absent.
3. Start, inspect, and stop the profile explicitly:

```bash
./scripts/kfive-up.sh --with-code-lab
./scripts/kfive-status.sh --with-code-lab
./scripts/kfive-logs.sh --with-code-lab code-runner
./scripts/kfive-down.sh --with-code-lab
```

The opt-in script sets `CODE_RUNNER_MODE=container` for the backend and enables the broker together, avoiding a UI that advertises execution without a worker. Its health check reads the numeric Redis heartbeat and emits no Redis URL or connection error, preventing password leakage through health output.

The Compose controls constrain the broker itself, but the socket still grants daemon-level control. A dedicated or rootless runner daemon is strongly recommended; never expose the broker publicly or mount the socket into a user runtime container.

## Initial runtimes and limits

The initial allowlist is Python 3.12 and JavaScript on Node.js 22. The conservative default run limits are 64 KiB source, 16 KiB stdin, 1 MiB combined captured output, five seconds, 256 MiB RAM, one CPU, and 32 processes. Network is disabled.

The runtime registry currently uses mutable upstream image tags. Pinning tested image digests is required before Code Lab can be enabled outside development.

## API

All endpoints require authentication.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/code/runtimes` | Report enabled state, allowlisted runtimes, and server limits |
| `POST` | `/api/v1/code/runs` | Validate, persist, and queue a run; returns `202` |
| `GET` | `/api/v1/code/runs` | List owner-scoped run history, optionally filtered by project |
| `GET` | `/api/v1/code/runs/:id` | Read one owner-scoped run |
| `POST` | `/api/v1/code/runs/:id/cancel` | Idempotently cancel/request cancellation |

Create payloads accept only `language`, `source`, optional `stdin`, and optional owner-validated `projectId`. Unknown fields are rejected.

## Data handling

Run source and stdin are stored in MongoDB for history. The first queue implementation also carries source/stdin in Redis until the job is removed according to queue retention. Do not submit secrets. A later privacy/retention control should allow disabling stdin/source history and move queue payload retrieval behind an internal authenticated API.

## Mandatory host-Docker verification

Before changing Code Lab from disabled/Experimental, execute and record all of these against the actual target daemon:

- normal stdout and stdin;
- stderr and non-zero exit code;
- timeout and explicit cancellation;
- output flood termination/truncation;
- memory exhaustion and PID/process pressure;
- denied network access;
- denied host-home/host-file access;
- absent Docker socket, devices, GPU, and KFive environment secrets;
- non-root UID and read-only root filesystem;
- queue concurrency and history persistence;
- container removal after success, failure, timeout, output limit, OOM, and cancellation;
- stale-container cleanup after broker interruption;
- inspection of the actual container configuration;
- runtime digest/version reporting.

Docker/kernel containers are not equivalent to hardened multi-tenant virtual machines. Do not offer anonymous public execution without a stronger isolation and abuse-control review.

## Planned expansion

TypeScript, C, C++, Java, Go, and Rust require separately built and tested runtime images. Compiled languages need distinct fixed compile and execute stages with separate limits. User-selected dependency installation and arbitrary shell commands are out of scope.
