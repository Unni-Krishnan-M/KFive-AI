# Isolated PDF text extraction verification

Verified on 2026-09-20 against the production Compose frontend/backend/MongoDB path and the isolated Document Processor.

- Processor tests: 4 passed, including real Poppler extraction, signature/size/page/encryption/time/output bounds, temporary cleanup, and HTTP contract.
- Backend focused regressions: 26 passed across document adapter, route safety, project context/lease behavior, and runtime dependency status.
- Frontend proxy regression: 1 passed. Backend API and Socket.IO targets use Docker DNS re-resolution after container replacement.
- Production builds: backend and frontend passed; backend, frontend, and document-processor images built successfully.
- Live API: authenticated PDF upload returned 201, real Poppler output and page count persisted in MongoDB, list omitted content/storage fields, owner detail returned the marker, unauthenticated detail returned 401, and deletion returned 200.
- Live browser: `pdf-extraction-source.pdf` displayed `KFive browser extraction persistence 20260920` and one page. The same authenticated UI record survived processor/backend restart, frontend replacement, backend replacement, and a full page reload.
- Runtime isolation: processor user `node`, read-only root filesystem, 384 MiB memory, 32 PID limit, no host port, no persistent mount, empty temporary extraction state, and an internal-only network containing only backend and processor.
- Restart proxy regression: the first backend recreation exposed a stale Nginx address and produced 502. After the dynamic Docker-DNS proxy fix, backend replacement without frontend restart reached the API and the complete extraction verifier passed again.

This evidence covers plain PDF text extraction only. It does not prove OCR, scanned-PDF extraction, conversion, compression, batch jobs, document AI, or PDF-to-RAG.
