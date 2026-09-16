# Knowledge / RAG

KFive currently provides an Experimental, bounded retrieval-augmented generation slice for UTF-8 TXT and Markdown sources. It is available in workspace scope or inside an owned Project Room.

## Configuration

RAG requires all of the following:

- MongoDB for source metadata.
- ChromaDB 0.4.24 for chunks and vectors.
- A configured AI provider that supports embeddings.
- A separate `AI_EMBEDDING_MODEL` value.
- A configured chat model for answer generation.

For local Ollama, install an embedding-capable model on the Ollama host and set its exact name. For example:

```bash
ollama pull nomic-embed-text
```

```dotenv
AI_PROVIDER=ollama
AI_DEFAULT_MODEL=phi3
AI_EMBEDDING_MODEL=nomic-embed-text
OLLAMA_BASE_URL=http://host.docker.internal:11434
```

KFive does not substitute the chat model for a missing embedding model and does not silently switch providers. The Knowledge page reports the unavailable dependency when the configured profile cannot be used.

Status skips the provider network probe when the embedding model is missing or embeddings are unsupported. Otherwise provider discovery uses a shared five-second abort deadline. A skipped probe reports `not-configured` or `disabled`, not a claim that the provider is offline. This does not verify that the configured embedding model is installed or actually supports embeddings.

## Current behavior

- Inputs are limited to valid UTF-8 TXT or Markdown, 64 KiB per source, and 64 chunks.
- Ingestion normalizes and chunks text, requests embeddings in bounded batches, and stores only metadata in MongoDB. Source chunks and vectors are stored in ChromaDB.
- Collections are separated by owner, provider, embedding model, vector dimension, and chunking version.
- Every vector operation includes owner and workspace/project scope filters. Query results are also checked against ready, owner-scoped MongoDB records before they are used.
- Retrieved text is treated as untrusted source data in the generation prompt. The UI labels returned excerpts as retrieved sources rather than claiming independently verified citations.
- Archived Project Rooms remain readable and queryable, but cannot ingest or delete project knowledge until restored.
- Project state is rechecked under the shared process-local project mutation lease before creating indexing metadata and publishing ready sources. If a project is archived or deleted during indexing, publication fails and vector cleanup is attempted; failed metadata is retained. This is not distributed fencing or crash recovery.
- Deleting an indexing source returns `409 RAG_SOURCE_BUSY` rather than racing outstanding vector writes. The UI disables deletion for queued/indexing sources and uses refreshed server archive state for mutation controls.
- Valid owner/project/source ObjectIds are normalized before use in case-sensitive vector filters and collection hashes. This prevents mixed-case API identifiers from creating unreachable vectors; it does not migrate historical vectors already stored under inconsistent metadata.
- Changing the provider, embedding model, vector dimension, or chunking profile requires affected sources to be reindexed. KFive returns an explicit mismatch instead of combining incompatible vectors.

## API

All routes require JWT authentication and use the `/api/v1/knowledge` prefix.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/status` | Report provider, embedding-model, and Chroma availability |
| `GET` | `/sources?projectId=...` | List sources in the workspace or selected owned project scope |
| `POST` | `/sources` | Synchronously validate, chunk, embed, and index one source |
| `DELETE` | `/sources/:id` | Delete owned vectors first, then their MongoDB metadata |
| `POST` | `/query` | Retrieve bounded chunks and generate an answer with source references |

## Verification status

Automated tests cover content bounds, chunking, embedding response validation, Chroma 0.4.24 request/response handling, ownership and project scoping, hostile vector metadata rejection, cleanup, profile mismatch, query references, and frontend contract normalization.

On 2026-09-15, the live authenticated status endpoint returned the explicit missing-embedding-model state and available ChromaDB without probing the provider. This request and a persisted repository-report read completed together in 33 ms. Automated regressions verify the skipped probe and provider timeout behavior.

On 2026-09-16, the stack was restarted with existing volumes. A backend-container connection check confirmed that no embedding model was configured and the configured Ollama endpoint was unreachable; the host service was active but listened only on `127.0.0.1:11434`. No listener exposure or model configuration was changed. Lifecycle and mixed-case identifier regressions use controlled providers/vector stores, not a claim of live embedding-provider verification.

The critical ingestion/query live path is not yet verified in this environment because no embedding model is configured. Before changing this feature from Experimental, start a healthy stack with an embedding-capable model and execute: sign in, index a source, ask an answerable and an unanswerable question, inspect returned excerpts, test a second user and project boundary, delete the source, restart services, and verify persistence and deletion.

Known lifecycle gaps include recovery of knowledge belonging to deleted projects, source-list pagination/quotas, and reconciliation after interrupted indexing. Delete project knowledge before deleting its project until recovery is implemented.

## Not yet implemented

PDF/DOCX/OCR ingestion, reranking, document page references, repository ingestion, background indexing jobs, batch ingestion, reindex controls, hybrid search, and persistent conversational RAG memory remain planned.
