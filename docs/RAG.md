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
- Workspace history offers **Sources from deleted projects** (`?scope=orphaned`). Recovery lists only the owner's sources whose parent project no longer exists, up to 200 metadata records; it exposes neither raw chunks nor vector-store locations. Upload/query are disabled in recovery. Invalid or mixed project/recovery scopes fail closed. Owners can explicitly delete ready/failed recovered sources; vectors are removed before metadata, and failed vector cleanup preserves metadata for retry.
- Valid owner/project/source ObjectIds are normalized before use in case-sensitive vector filters and collection hashes. This prevents mixed-case API identifiers from creating unreachable vectors; it does not migrate historical vectors already stored under inconsistent metadata.
- Changing the provider, embedding model, vector dimension, or chunking profile requires affected sources to be reindexed. KFive returns an explicit mismatch instead of combining incompatible vectors.

## API

All routes require JWT authentication and use the `/api/v1/knowledge` prefix.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/status` | Report provider, embedding-model, and Chroma availability |
| `GET` | `/sources?projectId=...` | List sources in the workspace or selected owned project scope |
| `GET` | `/sources?scope=orphaned` | List owner metadata for deleted-project sources; mutually exclusive with `projectId` |
| `POST` | `/sources` | Synchronously validate, chunk, embed, and index one source |
| `DELETE` | `/sources/:id` | Delete owned vectors first, then their MongoDB metadata |
| `POST` | `/query` | Retrieve bounded chunks and generate an answer with source references |

## Verification status

Automated tests cover content bounds, chunking, embedding response validation, Chroma 0.4.24 request/response handling, ownership and project scoping, hostile vector metadata rejection, cleanup, profile mismatch, query references, and frontend contract normalization.

On 2026-09-15, the live authenticated status endpoint returned the explicit missing-embedding-model state and available ChromaDB without probing the provider. This request and a persisted repository-report read completed together in 33 ms. Automated regressions verify the skipped probe and provider timeout behavior.

On 2026-09-16, the stack was restarted with existing volumes. A backend-container connection check confirmed that no embedding model was configured and the configured Ollama endpoint was unreachable; the host service was active but listened only on `127.0.0.1:11434`. No listener exposure or model configuration was changed. Lifecycle and mixed-case identifier regressions use controlled providers/vector stores, not a claim of live embedding-provider verification.

On 2026-09-16, a standalone loopback API integration test executed real host Ollama calls with installed `all-minilm:22m` and `phi3:latest`, real MongoDB, and real ChromaDB. Ingestion produced a ready source with 384-dimensional embeddings. An answerable question returned the exact fixture fact and `[S1]`; an unanswerable question reported missing information. Source IDs/snippets, owner/project isolation, archived deletion rejection, Mongo reconnect/server reopen persistence, deleted-project recovery, and vector/metadata deletion passed. The isolated test database and vector collections were removed. The embedding model remains installed on the host.

That standalone test did not change deployment configuration. Subsequently, on
2026-09-17, the opt-in host Ollama bridge and explicit embedding configuration
enabled the real local browser path: TXT ingestion, a correctly cited answer,
unknown response for missing information, reload persistence, and deletion all
passed. [Browser evidence](../output/verification/rag-browser-2026-09-17.md) records
the results and fixture cleanup. GPU verification, process-crash recovery and
remote deployment remain unproven; RAG remains Experimental.

### Reproduce the standalone live API check

Build the backend and start the local Compose dependencies. Install `phi3:latest` and `all-minilm:22m` on host Ollama, listening at loopback port 11434. Then run:

```bash
npm run build:backend
node scripts/verify-rag-live.cjs --allow-live-test
```

The opt-in verifier uses Docker inspection to obtain local database endpoints without printing credentials; it creates a random, isolated Mongo database and model-generated vector collections, binds a temporary API server to loopback, and removes only its fixtures afterward. It never edits `.env`, imports the production server's recovery loops, or changes host listeners. It requires host access to the Compose bridge addresses and real model inference; it is intentionally not part of `npm test`. A forced process termination may leave fixtures: use the printed test database name to identify them, never delete unrelated databases or collections. Model-answer assertions can fail on different model versions even when transport works.

Deleted-project recovery passed a separate live browser/API/MongoDB/ChromaDB proof on 2026-09-16 using explicitly synthetic two-dimensional vectors, not model-generated embeddings. Recovery excluded an existing project; archived-source deletion returned 409. After confirmed project deletion, recovery listed the source; a second user saw no recovery record and received 404 attempting deletion. A full stop/start preserved both metadata and vectors. Browser-confirmed source deletion removed its Mongo record and vector while preserving another owner's control record/vector in the same fixture collection. All disposable accounts, project, sources, and the empty test collection were cleaned up. This proves recovery/cleanup, not ingestion, retrieval quality, or answer generation.

Latest automated gates passed 468 backend tests and 107 frontend tests, all lint targets, and frontend/backend production builds. The standalone verifier writes checkpoint/cleanup evidence to `output/verification/rag-live-<run-id>.json`; only a `passed` status proves both its checks and cleanup completed. A `running` artifact after interruption is not a successful test.

Known lifecycle gaps remain: 200-record lists have no pagination or source quota, indexing interrupted by a crash lacks reconciliation, and process-local project leases do not coordinate replicas. Recovery cannot delete sources still marked indexing; do not manually delete their metadata while a writer could still be active.

## Not yet implemented

PDF/DOCX/OCR ingestion, reranking, document page references, repository ingestion, background indexing jobs, batch ingestion, reindex controls, hybrid search, and persistent conversational RAG memory remain planned.
