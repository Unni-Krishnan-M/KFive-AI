# Local Mode

Local mode sets `KFIVE_MODE=local`. Copy `.env.example` to `.env`, replace required secrets, ensure Docker Compose v2 is available, and optionally run host Ollama at the configured `OLLAMA_BASE_URL`.

Use `./scripts/kfive-up.sh` and `./scripts/kfive-down.sh`. Normal shutdown preserves named MongoDB, Redis, ChromaDB, upload, and log volumes. Full local runtime/persistence verification is still pending in an environment with Docker socket access.
