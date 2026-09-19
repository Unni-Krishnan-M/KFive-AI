# Duplicate Pages TDD — 2026-09-18

Journey derived from the master specification: select source pages, insert one
extra copy immediately after each original, and download a new PDF without
changing the source. Repeated selections must not multiply copies. Result must
remain within the existing 500-page limit.

## Evidence

- RED: `npm run test --workspace frontend -- src/services/pdfTools.test.ts`
  executed 24 cases: four new tests failed because `duplicatePdfPages` did not
  exist; the existing 20 passed.
- GREEN: `npm run test:pdf --workspace frontend` passed all 24. Generated PDFs
  were reopened to check page ordering/rotations, independent duplicate page
  dictionaries and unchanged input bytes. Tests cover `all`, repeated selections,
  invalid/oversized expressions, safe filename, exactly 500 output pages, and
  rejection before page copying when the result would exceed 500.
- Coverage: 87.97% lines/statements, 85.89% branches, 100% functions for pdfTools.ts;
  enforced 80% thresholds passed.
- Full frontend regression passed 129 tests across 21 files. Production build
  and lint passed. Existing large Chat chunk warning remains.

The source UI and command palette expose the operation, with adjacent-copy and
output-limit guidance. Browser download E2E and deployment remain pending, so
the operation is Experimental. This is not sanitization or secure redaction.
Git checkpoints were not created: `.git` is read-only and the dirty worktree
contains prior work; observed RED/GREEN evidence is preserved here.

## Browser follow-up — 2026-09-18

Production preview at 127.0.0.1:3003 used synthetic browser-only session state,
with API requests blocked. No production credentials or user PDFs were used.
Selected the generated four-page reorder fixture via Choose PDF. Page `9` was
rejected; changing to `3,1,1` recovered and displayed six output pages.
Clicked the actual Blob link and saved `source-duplicated.pdf`; download failure
was null. `node scripts/verify-pdf-duplicate-output.cjs` independently reopened
the saved file and passed: page order `1,1,2,3,3,4`, original dimensions and
rotations, unchanged source geometry. Unit tests prove byte-level input
immutability and independent copied page dictionaries separately.

Tested FileActionsPage-BeZREdpH.js SHA-256:
`c6b2fe4ffd1fc43c1c5cc52f87cc560b400aee7eee8d8a7665af133b17fa4aab`.
This supersedes the pending-browser note, not pending deployment. Authentication,
backend persistence, visual baselines, mobile/accessibility and sanitization were
not verified by this local-PDF test.

## Deployment — 2026-09-18

Frontend-only Compose build and startup passed. Image:
`sha256:e921f037529c3cba8c1b06f578185488c150dab0497adf756f18c683e6a39f26`.
Container running/healthy; deployed FileActionsPage-BeZREdpH.js matches the
browser-tested hash above. Served worker artifacts match the tested local build.
Frontend-proxied readiness reports ready/MongoDB available/Redis available;
it does not verify AI or Chroma and reports code/document/OCR unconfigured.
The stack was restored from stopped state with existing volumes, not reset.

Repeated PDF coverage: 24 passing tests; 87.97% lines/statements, 85.89% branches,
100% functions. Duplicate Pages is Implemented for the documented browser-local
workflow, not a claim that the full Document Studio specification is complete.
