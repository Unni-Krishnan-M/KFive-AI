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

## Current behavior

- Inputs are limited to valid UTF-8 TXT or Markdown, 64 KiB per source, and 64 chunks.
- Ingestion normalizes and chunks text, requests embeddings in bounded batches, and stores only metadata in MongoDB. Source chunks and vectors are stored in ChromaDB.
- Collections are separated by owner, provider, embedding model, vector dimension, and chunking version.
- Every vector operation includes owner and workspace/project scope filters. Query results are also checked against ready, owner-scoped MongoDB records before they are used.
- Retrieved text is treated as untrusted source data in the generation prompt. The UI labels returned excerpts as retrieved sources rather than claiming independently verified citations.
- Archived Project Rooms remain readable and queryable, but cannot ingest or delete project knowledge until restored.
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

The critical live path is not yet verified in this environment. Before changing this feature from Experimental, start a healthy stack with an embedding-capable model and execute: sign in, index a source, ask an answerable and an unanswerable question, inspect returned excerpts, test a second user and project boundary, delete the source, restart services, and verify persistence and deletion.

## Not yet implemented

PDF/DOCX/OCR ingestion, reranking, document page references, repository ingestion, background indexing jobs, batch ingestion, reindex controls, hybrid search, and persistent conversational RAG memory remain planned.
