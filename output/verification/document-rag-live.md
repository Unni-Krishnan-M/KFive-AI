# Stored document to RAG verification — 2026-09-21

Status: **passed for the bounded Experimental slice described below**.

## Verified path

- A real two-page raster-only PDF was uploaded through the production frontend/API.
- The isolated document processor rendered the PDF and Tesseract produced page-separated OCR text.
- `POST /api/v1/knowledge/sources/from-document` accepted only the stored `documentId`; the backend derived the owner, project scope, filename, media type, text, page count, and OCR provenance from MongoDB.
- Ollama `all-minilm:22m` produced embeddings, ChromaDB stored two page-aware chunks, and MongoDB stored the source metadata.
- A real query retrieved `ORCHID PAGE TWO 92126` with a page-2 reference and used `phi3:latest` for generation.
- Repeating ingestion returned HTTP 200 with the same source id and did not embed a duplicate. A second authenticated owner received 404.
- MongoDB, ChromaDB, the document processor, and backend were restarted. All became healthy; the real browser then received HTTP 200 from a fresh query and displayed the persisted page-2 excerpt/reference.
- The browser deleted the Knowledge source through the UI (vectors first, metadata second). The temporary Document was then deleted through its authenticated API because the Documents UI does not yet expose deletion. The generated fixture file was removed.

Live verifier result:

```text
documentId: 6ab0d432ba326dc9d8a733cc
sourceId:   6ab0d433ba326dc9d8a733d3
pageReference: 2
PASS: scanned PDF -> OCR -> stored document -> Ollama embeddings -> Chroma -> page-aware RAG query -> cleanup.
```

Browser persistence fixture document: `6ab0d650ba326dc9d8a7348e` (deleted after the restart check).

## Focused regression results

```text
Backend:  4 suites passed, 49 tests passed
Frontend: 2 files passed, 17 tests passed
Backend production build: passed
Frontend production build: passed
Backend/frontend Docker image builds: passed
```

The backend regression set covers chunk/page attribution, owner-scoped stored-document ingestion, authoritative scope derivation, exact request shape, not-ready/unsupported/oversize rejection, idempotency, and rejection of forged vector provenance. The frontend set covers Knowledge normalization/page references and the one-field document-ingestion transport contract.

## Boundaries

This does not make all of RAG or Document Studio complete. Indexing is synchronous, each stored source is capped at 64 KiB and 64 chunks, page references are emitted only when form-feed page boundaries match the persisted page count, and interrupted indexing has no durable recovery worker. DOCX-to-RAG, repository RAG, reranking, batch/reindex controls, remote/Kubernetes operation, and searchable PDF output remain unverified or Planned. A Knowledge source is an independent text/vector snapshot; deleting its originating Document does not implicitly delete that source.
