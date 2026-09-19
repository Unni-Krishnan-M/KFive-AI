# PDF reorder TDD evidence — 2026-09-17

Source: master specification's Reorder Pages requirement. Journey: choose a PDF,
specify every page once in a new order, download a new PDF without changing the
source. Missing or repeated pages must be rejected rather than silently extracted.

## RED / GREEN

`npm run test --workspace frontend -- src/services/pdfTools.test.ts` executed
20 tests: the three new reorder tests failed because `reorderPdfPages` did not
exist; all 17 existing tests passed. This was the missing implementation signal.

After implementation, `npm run test:pdf --workspace frontend` passed all 20.
Generated output was reopened with pdf-lib: page order/dimensions and rotations
matched the requested permutation, input bytes were unchanged, incomplete and
duplicate/overlapping selections failed, and all/invalid/oversized selections
and safe output naming behaved as expected.

Coverage: 88.05% lines/statements, 85.71% branches, 100% functions for pdfTools.ts,
passing enforced 80% thresholds. Full frontend regression passed 125 tests.
Frontend production build and lint passed; the existing large Chat chunk warning remains.

## Limits

Experimental until browser selection, validation recovery and actual download /
independent reopen are executed. Not deployed in this slice. This is a structural
transformation, not PDF sanitization; no thumbnail/drag-reordering claim.
Git checkpoints were not created because `.git` is read-only and the worktree
contains pre-existing changes; this report preserves the observed RED/GREEN evidence.

## Browser follow-up — 2026-09-18

The production build was served by an isolated preview at 127.0.0.1:3003.
Synthetic browser-only auth state unlocked the local utility; API requests were
blocked. This is not authentication or backend integration verification.

Using the actual Choose PDF control, selected the generated four-page source.
The browser rejected `1,2` (missing pages) and `1,2,3,4,1` (duplicate page), then
recovered with `4,2,1,3`, displayed PDF ready, and downloaded
`source-reordered.pdf` through the Blob link. Download failure was null.

`node scripts/verify-pdf-reorder-output.cjs --verify` independently reopened the
saved download and passed: four pages, exact requested order, dimensions and
rotations preserved, source geometry unchanged. Unit tests separately prove
byte-level input immutability. Fixture generation uses exclusive creation so
reruns cannot overwrite an existing source.

Browser-tested FileActionsPage-B3K-F_Lu.js SHA-256:
`f921a132a4869bcb4e343003ee26eea8b969b8e00155748e63880a5d05a137b7`.
This supersedes the pending-browser note above. Container deployment remains
pending; no visual baseline, mobile, accessibility, PDF sanitization, thumbnails
or drag-reorder claim is made.

## Deployment follow-up — 2026-09-18

Frontend-only Compose rebuild and startup passed. Image:
`sha256:80c7d90cf77c047ce23ba5a094baafe15e815e840747fba73c5dbe864a1f3459`.
Container inspection reports running/healthy. The deployed PDF bundle SHA-256
equals the browser-tested digest above. `node scripts/verify-service-worker-deployment.cjs`
passed both artifact comparisons. Frontend-proxied readiness reports ready with
MongoDB/Redis available; it does not check AI/Chroma and reports code/document/OCR
services unconfigured. No database volumes were reset or removed.

Repeated PDF verification: 20 tests passed; 88.05% lines/statements, 85.71% branches,
100% functions. The narrow expression-based reorder operation is Implemented;
the wider platform is not complete. Build retained a large Chat chunk warning and
its scoped install audit reported 28 dependency findings (16 high, 10 moderate,
2 low), so no clean-security claim is implied.
