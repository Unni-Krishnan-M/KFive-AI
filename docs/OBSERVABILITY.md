# Observability

State: **Planned**.

KFive has structured backend logs and request IDs, but it does not currently ship or verify Fluent Bit, Prometheus, Grafana, or their Kubernetes configuration. No scrape target, datasource, dashboard, or log pipeline is claimed as working. Local Compose health checks are not observability proof.

The planned slice must add JSON log collection with service and Kubernetes metadata, local Fluent Bit output, and an explicitly optional Datadog output. Prometheus must scrape bounded application, queue, HTTP, WebSocket, AI, Code Runner, document, RAG, agent, workflow, experiment, CPU/RAM, and GPU metrics. GPU/VRAM/temperature metrics must report a clear unavailable state when no supported device is visible. Grafana provisioning must define datasources and the documented KFive dashboards without embedding credentials.

Verification requires executing log parsing/routing, Prometheus target and metric queries, Grafana datasource checks, dashboard loading, retention/resource review, and restart persistence. Remote outputs must remain opt-in and must not receive secrets or prompt/document contents by default.
