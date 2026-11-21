# Knowledge / RAG

KFive currently provides an Experimental, bounded retrieval-augmented generation slice for UTF-8 TXT/Markdown uploads and completed stored PDF/PNG/JPEG documents. It is available in workspace scope or inside an owned Project Room.

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

- Inputs are limited to valid UTF-8 TXT/Markdown uploads or the persisted extracted text of an owned, completed PDF/PNG/JPEG document, 64 KiB per source, and 64 chunks.
- **Add to Knowledge** sends only the stored document id. The backend derives its owner, project scope, name, media type, text, page count, and OCR marker from MongoDB; client-supplied scope or content is rejected. Repeating the action returns the existing source instead of embedding a duplicate.
- Stored-document sources are independent text/vector snapshots. Deleting the original Document does not delete its Knowledge source, and deleting the source does not delete the original Document.
- PDF/OCR form-feed boundaries produce page references only when their count matches the persisted page count. Otherwise ingestion remains available without fabricated page numbers.
- Ingestion normalizes and chunks text, requests embeddings in bounded batches, and stores metadata plus a private bounded UTF-8 input snapshot in MongoDB while indexing or failed. The snapshot is excluded from default queries and all public history serialization, and removed atomically when the source becomes ready. It remains application-readable to database operators and may be present in backups. Source chunks and vectors are stored in ChromaDB. Snapshot persistence is preparation for durable indexing; queue dispatch and restart recovery are not yet implemented.
- Collections are separated by owner, provider, embedding model, vector dimension, and chunking version.
- Every vector operation includes owner and workspace/project scope filters. Query results are also checked against ready, owner-scoped MongoDB records before they are used.
- Retrieved text is treated as untrusted source data in the generation prompt. The UI labels returned excerpts as retrieved sources rather than claiming independently verified citations.
- Archived Project Rooms remain readable and queryable, but cannot ingest or delete project knowledge until restored.
- Project state is rechecked under the shared process-local project mutation lease before creating indexing metadata and publishing ready sources. If a project is archived or deleted during indexing, publication fails and vector cleanup is attempted; failed metadata is retained. This is not distributed fencing or crash recovery.
- Deleting an indexing source returns `409 RAG_SOURCE_BUSY` rather than racing outstanding vector writes. The UI disables deletion for queued/indexing sources and uses refreshed server archive state for mutation controls.
- Workspace history offers **Sources from deleted projects** (`?scope=orphaned`). Recovery lists only the owner's sources whose parent project no longer exists, in cursor pages of 50 metadata records (legacy callers without a cursor retain a 200-record cap); it exposes neither raw chunks nor vector-store locations. Upload/query are disabled in recovery. Invalid or mixed project/recovery scopes fail closed. Owners can explicitly delete ready/failed recovered sources; vectors are removed before metadata, and failed vector cleanup preserves metadata for retry.
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
| `POST` | `/sources/from-document` | Idempotently index one owned completed stored document; body must contain only `documentId` |
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

On 2026-09-21, a production-Compose API verifier and real browser executed the stored-document path with a two-page raster-only PDF: upload, isolated Poppler/Tesseract OCR, MongoDB persistence, server-authoritative indexing, real Ollama embeddings, Chroma storage/retrieval, Ollama generation, and a page-2 source reference. Repeat ingestion returned the same source, a second owner was denied, and cleanup passed. MongoDB, ChromaDB, the document processor, and backend were then restarted; a fresh browser query returned HTTP 200 and displayed the persisted page-2 excerpt. See [stored-document evidence](../output/verification/document-rag-live.md).

### Reproduce the standalone live API check

Build the backend and start the local Compose dependencies. Install `phi3:latest` and `all-minilm:22m` on host Ollama, listening at loopback port 11434. Then run:

```bash
npm run build:backend
node scripts/verify-rag-live.cjs --allow-live-test
```

The opt-in verifier uses Docker inspection to obtain local database endpoints without printing credentials; it creates a random, isolated Mongo database and model-generated vector collections, binds a temporary API server to loopback, and removes only its fixtures afterward. It never edits `.env`, imports the production server's recovery loops, or changes host listeners. It requires host access to the Compose bridge addresses and real model inference; it is intentionally not part of `npm test`. A forced process termination may leave fixtures: use the printed test database name to identify them, never delete unrelated databases or collections. Model-answer assertions can fail on different model versions even when transport works.

Deleted-project recovery passed a separate live browser/API/MongoDB/ChromaDB proof on 2026-09-16 using explicitly synthetic two-dimensional vectors, not model-generated embeddings. Recovery excluded an existing project; archived-source deletion returned 409. After confirmed project deletion, recovery listed the source; a second user saw no recovery record and received 404 attempting deletion. A full stop/start preserved both metadata and vectors. Browser-confirmed source deletion removed its Mongo record and vector while preserving another owner's control record/vector in the same fixture collection. All disposable accounts, project, sources, and the empty test collection were cleaned up. This proves recovery/cleanup, not ingestion, retrieval quality, or answer generation.

The 2026-09-21 stored-document focused gate passed 49 backend tests, 17 frontend tests, frontend/backend production builds, image builds, the live API verifier, and the browser/restart check. The standalone TXT verifier writes checkpoint/cleanup evidence to `output/verification/rag-live-<run-id>.json`; only a `passed` status proves both its checks and cleanup completed. A `running` artifact after interruption is not a successful test.

Cursor pagination is verified; the legacy list remains capped at 200 records. Source quota admission is implemented as described below; cross-replica project coordination remains incomplete. Default synchronous indexing still lacks crash reconciliation; the opt-in worker checkpoint below describes the new recovery boundary. Recovery cannot delete sources still marked indexing; do not manually delete their metadata while a writer could still be active.

## Not yet implemented

DOCX ingestion, repository ingestion, reranking, batch ingestion, reindex controls, hybrid search, persistent conversational RAG memory, and remote/Kubernetes verification remain planned. Background indexing/recovery is opt-in and experimental as described below. Stored PDF/OCR ingestion and conservative page references are implemented only within the bounded synchronous slice described above.

### Pagination acceptance — 2026-11-21

`GET /sources?cursor=` starts a descending ObjectId traversal; subsequent requests pass `pagination.nextCursor` until null. Ownership and workspace/project/recovery filters apply to every page. Browser/API acceptance covers 388 seeded records, scope isolation, tied timestamps, deletion/insertion during traversal, and API restart. See [evidence](../output/verification/knowledge-pagination-live.md). This is traversal rather than a transactionally frozen snapshot.

### RAG worker checkpoint — 2026-11-21

Opt-in `RAG_BACKGROUND_INDEXING_ENABLED=true` now persists queued ingestion and runs a bounded Mongo-backed polling worker inside the API process. Server-time claims, heartbeat renewal, generation-specific vector IDs, fenced publication, bounded exhausted-attempt terminalization, and shutdown draining are integrated. Default remains synchronous. Existing unclaimed synchronous records are not taken over.

Backend build/lint and 91 focused tests pass; frontend build passes. Isolated real-Mongo acceptance with synthetic embedding/vector adapters passes two-worker claim contention, abandoned-claim discovery, expired-worker publication rejection, replacement-vector preservation, snapshot removal, and attempt exhaustion. The live test caught and fixed a private-field candidate projection bug. [Evidence](../output/verification/rag-worker-live.json).

This does not complete durable RAG acceptance. Real Ollama/Chroma crash/restart/browser acceptance, stale-generation vector garbage collection/retrieval saturation, atomic source quotas, and distributed project coordination remain. Provider errors currently terminalize rather than retry; expired abandoned claims retry at most three times. Source fixtures were deleted exactly. Docker initially reported a zombie-process removal failure; after the container exited, retry removed its exact container record successfully. No existing application volumes were modified.

### RAG real recovery acceptance — 2026-11-21

The opt-in background worker now passes production native-API acceptance with real host Ollama (`all-minilm:22m` embeddings and `phi3:latest` generation), isolated MongoDB/Redis/Chroma, and real Chrome. A response-delay proxy allows a real Chroma upsert to finish, then SIGKILL interrupts the API before publication. Restart waits for the natural 30-second lease expiry, claims attempt 2, and publishes only its generation. Private retry content is removed on publication. Chrome upload displays queued/indexing with deletion disabled, auto-refreshes to ready, and retains ready state after reload. All three datastores and the API restart with the source and vectors intact. Cross-owner read/delete rejection and owner deletion of both current/abandoned vectors pass.

Retrieval now constrains Chroma ranking to the published generation of each ready source, preventing stale vectors from consuming its result window. Live acceptance seeds 100 obsolete vectors and still retrieves the valid source for a real Phi3 answer. A separately reproduced startup bug is fixed: valid AI timeouts longer than 120 seconds no longer violate the Chroma client's maximum; its timeout is capped independently.

Evidence: [live report](../output/verification/rag-recovery-live.json) and [browser screenshot](../output/verification/rag-recovery-browser.png). Exact test accounts, vectors, temporary containers, and network were removed; existing volume identities were preserved. Non-root Chroma uses stdout logging in the verifier. Backend build/lint, all 84 backend suites / 601 tests, and 16 frontend Knowledge tests pass.

This is a native local topology, not remote/Kubernetes or distributed project acceptance. Background indexing stays opt-in. Automatic stale-vector garbage collection (including late writes during deletion), atomic source quotas, legacy synchronous-orphan reconciliation, provider retry policy, and broader worker scheduling remain pending. Full master-platform completion remains active.

Reproduce this acceptance after backend/frontend builds with `KFIVE_PLAYWRIGHT_MODULE=/absolute/path/to/installed/playwright npm run verify:rag-recovery`. It requires Docker access, Chrome, and the already installed Ollama models named above; the verifier creates isolated datastores, runs the compiled production server, and removes only its labeled fixture containers/network.

## Atomic Knowledge source quota — 2026-11-21

Admission now stores a private integer slot on the same source document. A unique partial `{ ownerId, quotaSlot }` index bounds new sources to 200 per owner across all statuses and scopes. Concurrent slot conflicts retry only another free slot; document deduplication and ambiguous database failures do not silently consume extra capacity. Deletion releases capacity atomically with source removal. Missing or incompatible enforcing indexes fail closed.

Legacy sources are preserved and reserve capacity without rewriting their data. Owners already over 200 keep their records and cannot add another. Before rollout, drain every old API writer: legacy writes without slots must not continue concurrently with the new admission algorithm. The additive migration does not delete or rewrite source data. With the target `MONGODB_URL` supplied through the approved environment, inspect using `node scripts/migrations/20261121-rag-quota-index.cjs`; add `--apply` to create the enforcing index, then inspect again before starting updated writers. This migration has been verified only in the isolated acceptance database, not applied to existing application data here.

[Live quota evidence](../output/verification/rag-quota-live.json) proves eight-process contention, 196 preserved legacy records plus exactly four admitted sources, rejection beyond 200, an independent owner's separate allowance, deletion/readmission, a writer killed after insertion, duplicate-document behavior, fail-closed missing index, and Mongo restart persistence. Fixture accounts/container/network were removed and existing volume identities preserved. Current backend build/lint and 80 focused RAG/Knowledge tests pass.

The quota bounds source metadata/input count, not Chroma storage left by abandoned attempts. Automatic stale-vector garbage collection and late writes after deletion remain unfinished. Background recovery remains opt-in; remote/Kubernetes and distributed project coordination remain unverified.
