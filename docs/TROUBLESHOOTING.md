# Troubleshooting

- “Invalid environment configuration”: read the full list of missing/provider-specific variables; do not substitute example production secrets.
- AI unavailable: verify the configured provider, endpoint, credentials, and selected model. KFive does not fall back to another provider. Compatible/custom servers must implement the OpenAI-compatible `/models` and `/chat/completions` protocol.
- Readiness 503: inspect `/api/v1/readiness`; it names unavailable dependencies.
- Docker permission denied: ensure the current user can access the Docker daemon. Do not expose the Docker socket to KFive application containers.
- GPU unavailable: run `nvidia-smi` on the host and independently verify container GPU access before enabling GPU workloads.
- Docker data: `docker compose down` preserves volumes. The reset script requires both `--delete-data` and interactive `DELETE` confirmation.
- MongoDB remains unhealthy with `Authentication failed`: environment variables do not replace credentials inside an existing database volume. Preserve important data and recover with the original credentials. For a confirmed fresh installation only, stop Compose and recreate just `kfive-ai_mongodb_data`; never use `docker compose down -v` when the other persistent volumes must be retained.
