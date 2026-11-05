# Deployment acceptance matrix

This matrix separates configuration support from executed evidence. A mode is not production-ready merely because the environment parser accepts it.

| Mode | Application and data | AI provider | Accepted path | Outage/recovery | Persistence | State |
| --- | --- | --- | --- | --- | --- | --- |
| Local | Local Compose/kind; private MongoDB, Redis, ChromaDB and volumes | Local Ollama through the bounded host bridge | Core authenticated chat and selected product slices have local live evidence | Bridge/provider and selected service restarts passed in bounded slices | Mongo and feature-specific restart paths passed; full platform matrix remains open | Experimental platform; individual features vary |
| Hybrid | Production Compose application/data on one host | Explicit remote-classified authenticated provider endpoint | Auth/runtime/model discovery and structurally validated chat passed against an independently managed protocol fixture | Provider stop produced 503 discovery and durable `CHAT_PROVIDER_UNAVAILABLE` with no Ollama fallback; same-container recovery passed | Mongo/backend restart retained identity/history and all five volume objects | Experimental |
| Remote | Production Compose foundation expects app/data on the remote host and an authenticated remote provider | Explicit remote provider | Same-host foundation checks plus strict private-CA TLS/API/SSE passed; no public DNS, public CA, clean remote host, or real provider | Local backend/TLS restart passed; real provider/WAN/host failure behavior untested | Same-host backup/restore passed; cross-host/off-host DR untested | Experimental foundation; real remote acceptance Planned |

Hybrid evidence: [production-hybrid-live.md](../output/verification/production-hybrid-live.md). Local TLS evidence: [production-tls-live.md](../output/verification/production-tls-live.md). Production foundation, recovery, authentication, and performance evidence are linked from [Remote deployment](REMOTE_DEPLOYMENT.md).

The Hybrid and TLS fixtures shared one Docker daemon with KFive. Provider egress is useful topology separation, not a security boundary against hostile workloads or host compromise. The TLS fixture proved strict private-CA transport and proxy behavior, not public trust or certificate lifecycle. No current row proves public DNS/TLS, immutable registry delivery to a clean remote host, real provider credentials/governance, multi-replica behavior, or laptop independence.
