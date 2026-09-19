# PDF deletion TDD evidence — 2026-09-17

Journey: remove selected pages into a new PDF, preserving the source and original
order/rotation of retained pages; reject an empty resulting document.

- RED: `npm test --workspace frontend -- src/services/pdfTools.test.ts` ran 15 tests: 3 failed because `deletePdfPages` was absent; 12 existing tests passed.
- GREEN: same command passed all 15 after implementation.
- Regression: frontend 110 tests passed before the additional filename/boundary test; production frontend build and frontend lint both exited zero.
- Coverage attempt: `npm test --workspace frontend -- src/services/pdfTools.test.ts --coverage --coverage.include=src/services/pdfTools.ts` could not run because `@vitest/coverage-v8` is not installed. No coverage threshold claim.
- Independent read-only agent review informed empty-default selection, original-order preservation, command-palette discovery, and explicit non-redaction warning.
- No Git checkpoint commits: existing shared dirty worktree was preserved; this report records RED/GREEN evidence instead.
- Browser follow-up: a production-build preview at `127.0.0.1:3002` generated and downloaded `source-pages-removed.pdf` after selecting `4,2,2`. The browser script first asserted an empty default and waited for rejection of `all` before proceeding. Its process handle was lost on interruption; the saved download was independently reopened successfully with `node scripts/verify-pdf-delete-output.cjs --verify`: two pages, sizes 100×200 and 300×400, rotations 90 and 180; source still four pages. This artifact supports successful completion through download, not a captured browser process exit status.
- Docker rebuild failed during `npm ci` with ETIMEDOUT. A temporary production preview was used instead; no CORS rules were weakened. The normal frontend container was restored afterwards. New Compose deployment and coverage remain pending, so the feature remains Experimental.
- Removed the two exact disposable QA accounts. Generated fixture/download PDFs remain under `output/verification/pdf-delete/` for inspection.
- Added signature and selection-limit regression checks; focused PDF suite passed 17 tests.
- Coverage follow-up: installed exact `@vitest/coverage-v8@1.6.1`, matching the existing Vitest runtime. `npm run test:pdf --workspace frontend` passed all 17 checks and enforced 80% thresholds: 90.25% statements/lines, 85.4% branches, 100% functions for `pdfTools.ts`. This does not measure UI or whole-application coverage. Full frontend regression most recently passed 112 tests across 18 files.
- Deployment follow-up succeeded: `docker compose -f docker-compose.yml -f docker-compose.ollama-host.yml up -d --build --no-deps frontend` exited zero; frontend is running/healthy. Image: `sha256:0602f2ae8d080ebb1a00ca492fe49d0e125357860ab7bee4f797309a358094b7`. Local browser-tested and deployed `FileActionsPage-CkTqiyMV.js` both hash to `aff8b2fcedcf8b5b2f0f4f2641f1cbc35e9b302684d5bea0e182523f04842311`. The download verifier passed again. This supersedes the earlier pending deployment/coverage notes, not the wider platform limitations.
- Build audit reported 33 advisories including three critical. These need dependency-path and runtime-reachability triage; the image serving static assets does not alone establish that every build dependency advisory is exploitable in the browser, nor that any is harmless.
