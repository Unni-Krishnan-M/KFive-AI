# Hybrid Mode

Hybrid mode is a configuration foundation, not yet an executed deployment. Set `KFIVE_MODE=hybrid`, point database/service/provider URLs at the intended local or remote hosts, and set exact public/CORS origins. If AI points to a laptop-hosted Ollama instance, AI features will be unavailable whenever that laptop is offline; no provider fallback occurs.
