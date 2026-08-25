# Models and AI Providers

KFive selects one provider explicitly through `AI_PROVIDER`; it never silently falls back. Supported adapter values are `ollama`, `openai`, `anthropic`, `openai-compatible`, and `custom`.

Common controls are `AI_DEFAULT_MODEL`, `AI_MAX_OUTPUT_TOKENS`, and `AI_TIMEOUT_MS`. Settings reports the active provider, capabilities, connection state, and model list without returning credentials. Provider or endpoint changes currently require a backend restart.

## Capability notes

- Ollama supports chat, streaming, model listing, JSON-mode output, and embeddings through the configured host.
- OpenAI uses its OpenAI-compatible Chat Completions, models, and embeddings endpoints in the current adapter.
- Anthropic uses the Messages and Models APIs. Embeddings and schema output are explicitly reported unsupported by the current adapter.
- `openai-compatible` and `custom` use `/models`, `/chat/completions`, and optionally `/embeddings`. Embeddings and structured output remain disabled unless their corresponding capability environment variables are explicitly enabled.

No cloud-provider call is made by the default test suite. External smoke tests must be opt-in so normal builds cannot create billable requests.

## Model management and routing

The Models page lists provider-reported models and measured GPU state. Ollama supports streamed pulls and deletion. Deletion requires a short-lived, one-use confirmation scoped to the user, provider, and exact model. Cloud and compatible providers return an explicit unsupported response for install/delete operations; KFive never changes providers to satisfy a management request.

Smart routing accepts an explicit task type and reports its selected provider, model, and reasons. It uses only available metadata: user preference, configured default, task/name hints, reported context and capabilities, and measured free VRAM when available. It does not fabricate benchmark results. Historical benchmark scoring will be added only after benchmark persistence exists.
