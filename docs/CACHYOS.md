# CachyOS / Arch Linux

This is the target-host checklist for KFive's local mode. Commands are written for the repository's Bash scripts even when the interactive user shell is fish.

## Host prerequisites

- Docker Engine with the Compose v2 plugin.
- A user account permitted to access the selected Docker daemon.
- `curl`, `openssl`, and standard core utilities used by the lifecycle scripts.
- Ollama installed as a host service when `AI_PROVIDER=ollama` and local inference is desired.
- NVIDIA drivers and `nvidia-smi` for host GPU observation. Container GPU access is separate and must be tested; KFive does not assume it from host visibility.

Do not enable every heavy component at OS boot. The default Compose stack excludes Code Lab, notebook training, observability, and other optional workers unless explicitly selected.

## First configuration

From fish or Bash:

```bash
cp .env.example .env
openssl rand -hex 32
```

Generate separate values for `MONGO_ROOT_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, and `JWT_REFRESH_SECRET`. Paste only the secret values into `.env`; do not paste shell prompts, public Ollama keys, quotes copied from documentation, or reuse one value for every purpose. Restrict the file:

```bash
chmod 600 .env
docker compose config --quiet
```

If port 3000 is occupied, change these values together in `.env` (replace `3002` consistently):

```dotenv
FRONTEND_PORT=3002
PUBLIC_BASE_URL=http://localhost:3002
CORS_ORIGIN=http://localhost:3002,http://127.0.0.1:3002
```

`PUBLIC_BASE_URL` must identify the public browser origin and that origin must appear in `CORS_ORIGIN`; the backend now rejects inconsistent startup configuration. Add every hostname that users will actually enter in the browser, but do not use a wildcard. Do not stop or overwrite an unrelated application merely to make KFive use its default port.

## Ollama

Arch packages commonly run Ollama through `ollama.service`. If the service is already active on port 11434, do not start a second `ollama serve` process. Verify it with:

```bash
systemctl is-active ollama.service
curl --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:11434/api/tags
```

For backend containers to reach host Ollama, configure the service listener deliberately and keep host firewall exposure restricted. On the packaged systemd service, run:

```bash
sudo SYSTEMD_EDITOR=nano systemctl edit ollama.service
```

Paste these two lines into the editor, then save with `Ctrl+O`, `Enter` and exit with `Ctrl+X`:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Apply and verify the override:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama.service
systemctl show ollama.service --property=Environment --no-pager
ss -ltn '( sport = :11434 )'
```

The listener must no longer be limited to `127.0.0.1:11434` for Docker access. Compose maps `host.docker.internal` through the Linux host gateway, so the application default is `OLLAMA_BASE_URL=http://host.docker.internal:11434`. Binding Ollama beyond loopback changes its network exposure; restrict port 11434 to trusted local/container networks and do not expose it publicly without an authenticated gateway.

The Ollama SSH key generated in its service account home identifies Ollama operations; it is not a KFive JWT, MongoDB, or Redis secret.

## Start and stop

```bash
./scripts/kfive-up.sh
./scripts/kfive-status.sh
./scripts/kfive-logs.sh backend
./scripts/kfive-down.sh
```

Normal down preserves data. `kfive-reset.sh` requires explicit destructive flags and confirmation. Back up data before any volume operation.

## NVIDIA and Code Lab

Host GPU verification:

```bash
nvidia-smi
```

This proves only that the host driver works. A GPU-enabled container or kind node needs its own runtime/device-plugin setup and an executed probe. Ollama may remain on the host, which avoids silently assuming GPU passthrough for the default KFive containers.

The default benchmark worker intentionally has no GPU device mapping. It can call host Ollama through `host.docker.internal`, but its own GPU snapshot will report unavailable. Do not interpret host Ollama GPU use as verified GPU access inside the worker container.

Observed on 2026-09-09: the installed override still sets `OLLAMA_HOST=127.0.0.1:11434`, and the host service was inactive during final verification. The successful 2026-09-07 Benchmark proof therefore used a removed temporary internal CPU-only Ollama service and does not replace the listener/firewall procedure above. KFive's `.env` was restored to `OLLAMA_BASE_URL=http://host.docker.internal:11434`; provider features should report an explicit timeout/unavailable state until the host listener is intentionally configured and started.

Code Lab is CPU-limited by default and opt-in. Before enabling it, inspect the Docker socket group numerically:

```bash
stat -c '%g' /var/run/docker.sock
```

Set the reported value as `CODE_RUNNER_DOCKER_GID`, review [DOCKER.md](DOCKER.md), pull the allowlisted runtime images, and use `./scripts/kfive-up.sh --with-code-lab`. Prefer a dedicated/rootless daemon for stronger separation.

## Known target-host recovery issue

If MongoDB reports `Authentication failed` after secrets were changed, the existing volume still contains the original initialized credential. Environment changes do not rewrite database users. Recover with the original credential and rotate inside MongoDB, or—for a confirmed fresh disposable install only—stop services and recreate exactly the Mongo volume. Do not delete all Compose volumes because Redis, ChromaDB, uploads, and other persistent data are separate and valuable.

See [DEPLOYMENT.md](DEPLOYMENT.md) and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for current verified boundaries.
