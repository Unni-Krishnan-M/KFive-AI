# Kubernetes

State: **Planned**.

KFive does not currently ship Kubernetes, kind, Traefik, or Argo CD manifests, and no Kubernetes deployment or GitOps sync has been executed. A healthy local Docker Compose stack is not evidence that this deployment mode works.

Before this area can move to Experimental, the repository must add reviewed manifests for the `kfive` and `kfive-observability` namespaces, ConfigMaps and Secrets, persistent volumes/claims, probes, resource requests and limits, and consistent labels. Traefik must route `/`, `/api`, and `/socket.io` with WebSocket support while MongoDB, Redis, and ChromaDB remain private. Argo CD setup must separate infrastructure from application manifests and document safe sync, self-heal, and pruning behavior.

Verification requires a clean kind deployment, persistence across pod restart, liveness/readiness behavior, authenticated browser and WebSocket flows, internal-only databases, and an actual Argo CD sync. GPU workloads must remain disabled or remote unless GPU access is explicitly detected and exercised; host Ollama is an acceptable documented local-mode topology.
