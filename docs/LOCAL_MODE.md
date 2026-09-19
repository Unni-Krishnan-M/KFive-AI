# Local Mode

Local mode sets `KFIVE_MODE=local`. Copy `.env.example` to `.env`, replace required secrets, ensure Docker Compose v2 is available, and optionally run host Ollama at the configured `OLLAMA_BASE_URL`.

Use `./scripts/kfive-up.sh` and `./scripts/kfive-down.sh`. Normal shutdown preserves named MongoDB, Redis, ChromaDB, upload, and log volumes. See `STATUS.md` for tested local slices and remaining gaps.

For host Ollama bound only to localhost on native Linux, use
`./scripts/kfive-up.sh --with-host-ollama` and the same flag on shutdown.
The [host bridge](OLLAMA_HOST_BRIDGE.md) provides a restricted Unix socket without
opening a TCP listener. Its deployed backend listing, embeddings and streaming
path and local browser TXT RAG have been verified; this does not prove GPU use,
PDF/OCR ingestion, or the entire local platform.
After building, add `--no-build` to reuse local images during startup.
