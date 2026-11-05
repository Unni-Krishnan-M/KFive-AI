# Hybrid Mode

Hybrid mode is **Experimental**. Set `KFIVE_MODE=hybrid`, keep application persistence on the selected KFive host, point the configured AI adapter at an authenticated external endpoint, and set exact public/CORS origins. The mode label reports topology; it does not rewrite endpoints or add failover.

A same-host production-Compose acceptance cell passed authenticated runtime/model discovery, structurally validated streaming chat, remote-provider outage without local fallback, same-container recovery, and Mongo/backend restart persistence. The provider fixture was independently managed and joined only provider egress, but it shared the Docker daemon; this proves the protocol/dependency contract, not a remote-host security boundary. See [the matrix](DEPLOYMENT_ACCEPTANCE_MATRIX.md) and [evidence](../output/verification/production-hybrid-live.md).

When the configured provider is unavailable, model discovery fails and chat persists a safe `CHAT_PROVIDER_UNAVAILABLE` terminal result. KFive does not silently switch to Ollama or another provider. Operators must monitor provider health/errors, understand prompt/output data handling and cost, and define an explicit recovery procedure.

If the provider points to a laptop-hosted service, AI features still depend on that laptop remaining online. Real HTTPS provider credentials, WAN behavior, provider governance, a separate remote host, cross-host persistence, and laptop independence remain unverified.
