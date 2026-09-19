# Linux host Ollama bridge

Experimental. Local deployed backend model listing, real embeddings, and streamed
chat were verified on 2026-09-16. On 2026-09-17 the local browser TXT ingestion,
cited query, unknown-answer, reload and deletion path passed; see
[verification evidence](../output/verification/rag-browser-2026-09-17.md).
Remote deployment and GPU use remain separate gates.
This opt-in Compose layer lets KFive reach host Ollama while Ollama continues
listening on `127.0.0.1:11434`. It does not start Ollama, install models, enable
GPU access, change your provider, or expose a new TCP listener.

## Start and stop

Set `AI_PROVIDER=ollama` in `.env`. Keep your desired model and embedding-model
configuration explicit. Check host Ollama first:

For example, if already installed, set `AI_EMBEDDING_MODEL=all-minilm:22m` for
embeddings and keep a separate chat model such as `AI_DEFAULT_MODEL=phi3:latest`.
The bridge never downloads or selects a model automatically.

```bash
curl --fail http://127.0.0.1:11434/api/tags
./scripts/kfive-up.sh --with-host-ollama
./scripts/kfive-status.sh --with-host-ollama
./scripts/kfive-logs.sh --with-host-ollama ollama-bridge
./scripts/kfive-down.sh --with-host-ollama
```

Use the same flags on shutdown as startup (including `--with-notebook` and
`--with-code-lab` when used). Plain Compose without this override does not manage
the bridge service. Shutdown preserves databases, documents, models, and volumes.
No boot service is installed; the bridge has `restart: "no"`.

After a successful build, restart using existing local images without rebuilding:
`./scripts/kfive-up.sh --with-host-ollama --no-build`. This also skips notebook
runtime builds when notebook mode is selected; all required images must already
exist. Source changes are not included until a subsequent build.

The equivalent explicit Compose selection is:

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama-host.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.ollama-host.yml up --build -d
```

Do not print full Compose configuration into shared logs: it contains resolved
secrets. The startup script rejects a non-Ollama provider instead of silently
switching it. Direct Compose bypasses that script preflight.

## Security boundary

Only the lightweight bridge uses Linux host networking to reach loopback Ollama.
Backend and workers retain their normal container networks. A dedicated named
volume carries `/run/ollama-bridge/ollama.sock`; consumers mount it read-only.
The bridge image initializes the directory for UID/GID `1000:1000`, and runs
non-root with a read-only root filesystem, all capabilities dropped,
`no-new-privileges`, 64 processes, 96 MiB RAM, and 0.5 CPU.

`KFIVE_OLLAMA_HOST_URL` defaults to `http://127.0.0.1:11434`. Only a loopback
upstream is permitted by the bridge. The application uses `OLLAMA_SOCKET_PATH`
from this override rather than a publicly reachable Ollama URL. The bridge
has no Docker socket, home-directory mount, or published ports. Untrusted
Code Lab/notebook runtime containers do not mount the socket.

Host networking remains a meaningful privilege: compromise of the bridge could
reach host-network services. The socket is a trusted application capability;
a read-only volume mount does not make requests read-only. Do not mount it in
user programs or unrelated containers. Ollama's own GPU configuration and resource
limits remain host responsibilities; this bridge does not prove GPU inference.

## Verification and troubleshooting

Check bridge health, then test the provider through KFive Settings, list models,
and run an actual chat. For RAG, configure an installed embedding model and verify
ingestion plus a cited answer. Health alone does not prove inference or GPU use.

If the bridge fails, inspect its logs and confirm Ollama's loopback API responds.
Do not work around failure by exposing unauthenticated Ollama on `0.0.0.0`.
This option is for native Linux Docker, not Docker Desktop or remote deployments.
To switch back, stop with the bridge flag before starting without it; existing
user data remains intact. Keep remote/hybrid providers configured explicitly.
