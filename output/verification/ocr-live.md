# OCR live verification — 2026-09-21

State: **Experimental**. This evidence covers the bounded local ingestion slice, not all OCR or Document Studio requirements.

## TDD and focused regressions

RED failures were observed before implementation for missing OCR functions/route, missing image-dimension bounds, missing health capability, missing graceful-shutdown export, and the frontend upload timeout remaining at 30 seconds.

GREEN results:

- Document Processor: 11/11 Node tests passed. Coverage: 96.80% lines, 80.95% branches, 88.89% functions.
- Backend: 4 focused suites, 30/30 tests passed (`documentProcessor`, document safety, project context, runtime dependency reporting). These include PDF dispatch with OCR-only configuration and explicit OCR-unavailable behavior when native PDF extraction is empty.
- Frontend API transport/Nginx: 4/4 tests passed, including the bounded 90-second document-upload timeout, 52 MiB multipart proxy allowance, and bounded 95-second proxy read/send timeouts.
- Backend and frontend production builds passed.
- Document Processor, backend, and frontend production images built successfully.

## Real production paths

`node scripts/verify-ocr-live.cjs --allow-live-test` passed against the deployed Compose stack through port 3002:

```text
1,681,857-byte PNG -> Nginx/API -> isolated OCR service -> Tesseract -> MongoDB -> owner detail
JPEG -> Nginx/API -> isolated OCR service -> Tesseract -> MongoDB -> owner detail
raster-only PDF -> API -> OCR service -> Poppler page raster -> Tesseract -> MongoDB
second user -> owner document detail: 404
test documents -> deleted
```

Result marker: `KFIVE OCR 92026`. PNG document `6ab0c881f1e56633ecc36143`; JPEG document `6ab0c881f1e56633ecc36147`; scanned-PDF document `6ab0c881f1e56633ecc3614b`. All three fixtures were deleted after their owner/cross-owner assertions.

The real production UI at `http://127.0.0.1:3002/app/documents` registered a dedicated account, uploaded a generated PNG through the file control, received HTTP 201, showed the document as Ready, and displayed `OCR text (1 page)` with exact marker `KFIVE BROWSER OCR 92126`. After restarting only `backend` and `document-processor`, both became healthy; the still-authenticated browser reloaded, reopened the same record, and displayed the same marker. This verifies Browser/API -> OCR processor -> Tesseract -> MongoDB -> detail/history and restart persistence. The browser record/account are retained as evidence.

## Runtime boundary inspected

- UID/GID: `1000:1000` (`node`), not root.
- Read-only root filesystem: true.
- Limits: 512 MiB RAM, 1 CPU, 64 PIDs, 128 MiB temporary filesystem.
- Published ports: none.
- Network: internal-only `document-processor-network` shared with backend.
- Tesseract: 5.3.0 with fixed English configuration.
- `/tmp` contained no job files after verification.
- Deployed Nginx syntax/config inspection confirmed `client_max_body_size 52m` and bounded 95-second upstream read/send timeouts. The >1 MiB multipart upload passed through this proxy. A controlled synthetic 65-second pause probe was inconclusive and is not counted as evidence.

## Limits not claimed

OCR is English-only, synchronous, and one job at a time. Limits are 25 MiB input, 25 scanned-PDF pages, 25 million image pixels and 10,000 pixels per side, and 1 MiB text. Searchable PDF output, progress/cancel, durable queues, crash recovery, batch OCR, structured extraction, OCR-to-RAG/document AI, remote authentication/TLS, Kubernetes, and multi-replica operation are not verified or implemented by this slice.
