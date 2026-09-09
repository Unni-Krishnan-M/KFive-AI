# Dataset Lab

The Phase 11 Dataset Lab source slice is implemented and **Experimental**. It provides authenticated, owner-scoped CSV/JSON ingestion, deterministic tabular analysis, private downloads, and explicit derived cleaning copies in workspace or owned Project Room scope. It is not a notebook, experiment runner, benchmark system, Python environment, AI analysis path, or shared GPU job queue.

## Current behavior

- An upload creates an immutable original in the persistent backend uploads volume and owner/project-scoped metadata in MongoDB. Internal storage paths and generated filenames are never returned by the API.
- CSV and JSON inputs are analyzed deterministically for schema and inferred types, missing cells, duplicate rows, numeric summaries, bounded category counts, IQR outlier signals, and bounded numeric correlations.
- Analysis includes at most 50 preview rows, with each previewed string limited to 500 characters. Preview and category values are untrusted uploaded data, not verified facts.
- A derived copy is created only from explicit choices to trim strings, drop duplicate rows, drop rows containing missing values, and escape spreadsheet-formula prefixes in CSV output. Formula escaping is not accepted for JSON. Derivation never overwrites or mutates its parent, and a derived copy may be used as another source under the separate 10 MiB derived-input/output ceiling. JSON derivation preserves scalar types.
- A parent dataset with derived children cannot be deleted until those children are deleted. This makes the derivation relationship explicit and prevents dangling history.
- Originals and derived copies download only through authenticated owner-scoped endpoints as private attachments. Cross-owner and missing records use the same not-found behavior.
- Workspace lists contain only records without a project association; project lists contain only that owned project's records. The two scopes are intentionally disjoint.
- Project association is validated by the server and is immutable. Active projects allow upload, derivation, and deletion. Archived-project datasets remain readable and downloadable but cannot be created, derived, or deleted until the project is restored.

No file is sent to an AI provider. Dataset parsing and analysis run in the Node backend; no Python, shell, user code, network tool, Chroma operation, or model invocation is involved.

## Limits

- 5 MiB per uploaded CSV or JSON file.
- 10 MiB per derived input/output because serialization and CSV formula escaping can expand the 5 MiB source.
- 10,000 data rows and 100 columns.
- 16 KiB of UTF-8 data per cell.
- 50 preview rows and 500 characters per previewed string.
- Bounded category evidence and correlations; these are descriptive statistics, not causal claims or model-quality guarantees.
- At most 100 retained dataset records per owner, including originals and derived copies.

The 100-record retention check is count-then-create and is not an atomic multi-replica quota. Upload rate limiting, resource admission, and project mutation leases are also process-local. Concurrent requests or multiple backend replicas can exceed the intended limits, so this Experimental slice assumes one backend process. Project state is rechecked while publishing or deleting a dataset, which closes in-process archive/delete races but is not distributed coordination.

## API

All routes require JWT authentication and use the `/api/v1/datasets` prefix.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/status?projectId=...` | Report scope, availability, supported formats, and limits |
| `GET` | `/?projectId=...` | List bounded owner-scoped dataset summaries |
| `POST` | `/` | Upload and analyze one multipart CSV or JSON original |
| `GET` | `/:id` | Read one owner-scoped analysis and bounded preview |
| `GET` | `/:id/download` | Download the immutable original or derived copy as a private attachment |
| `POST` | `/:id/derive` | Create a new derived copy using only the explicit supported cleaning choices |
| `DELETE` | `/:id` | Delete an eligible dataset and its private file; reject parents with children and archived-project records |

## Security, storage, and privacy

Dataset content is untrusted. File/media/UTF-8/schema checks and byte, row, column, cell, preview, admission, and rate limits reduce malformed-input and denial-of-service risk, but parsing still occurs in the backend process. A timeout cannot reliably preempt every synchronous CPU or allocation spike. Do not expose this as a production multi-tenant importer until adversarial CPU/RAM/disk measurements pass and deployment-wide admission controls exist.

CSV cells beginning with spreadsheet formula characters can execute when opened in spreadsheet software. Formula escaping is an explicit derived-copy option; it does not rewrite the immutable original and does not make arbitrary spreadsheet content safe. Prefer an escaped derived CSV for spreadsheet use, retain the warning, and treat downloads as untrusted files.

Original and derived bytes live in the persistent backend uploads volume. MongoDB retains filenames, checksums, analysis, preview values, category values, relationships, and owner/project metadata in application-readable form. Authentication and private attachment headers do not provide application-level encryption, secure erasure, malware scanning, regulated-data controls, or protection from database, filesystem, host, or backup administrators. Deletion cannot guarantee removal from snapshots or backups. Do not upload secrets or regulated datasets without deployment-appropriate encryption, access controls, backup retention, and deletion policy.

## Target-host verification

Passed on the production Compose stack on 2026-09-05:

- A real user created a Project Room, selected a local CSV in the UI, uploaded/analyzed it, and saw exact row/column/missing/duplicate evidence.
- The UI downloaded the immutable 38-byte original with the exact input SHA-256. All four transforms produced a distinct 21-byte child whose downloaded bytes were exactly `name,value\nAda,'=2+3\n`; lineage, generation, transform flags, and the unchanged parent hash were verified.
- Parent deletion was rejected while the child existed. Workspace and project lists remained disjoint before and after restarting MongoDB, backend, and frontend.
- All three downloads survived restart with exact byte counts and SHA-256 values plus private/no-store, `nosniff`, digest, and attachment headers.
- Archiving through the real project path kept reads/downloads available, made current UI controls read-only even when initial page context was stale, and returned `PROJECT_ARCHIVED` for direct upload/derive/delete attempts. Restore re-enabled deletion.
- A second real user saw an empty workspace list, received `PROJECT_NOT_FOUND` for forged project status/list requests, and received `DATASET_NOT_FOUND` for direct detail/download/derive/delete attempts against all three first-user records.
- UI cleanup deleted child, parent, and workspace records in dependency order; all detail/download rechecks returned `404`, both lists returned zero, and the temporary project was deleted. The shared confirmation component's accessible dialog name, modal state, and description linkage were then browser-verified.

Still required before production certification:

- Browser-upload the JSON path and exercise preview truncation plus each transform independently.
- Exercise malformed UTF-8, malformed/ragged CSV, unsafe JSON shapes/keys, hostile formulas, exact byte/row/column/cell limits, admission/rate limits, owner quota, disk-full behavior, partial-write cleanup, filesystem containment, and hostile CPU/RAM behavior on the target host.
- Add deployment-wide admission/quota coordination and prove multi-replica behavior.

Dataset experiments, target selection, ML task recommendations, train/test helpers, model training, Python transformations, arbitrary cleaning expressions, joins, charts, AI-generated analysis, and a durable shared GPU queue remain **Planned**. Notebook execution is a separate Experimental opt-in slice and does not execute Dataset Lab files.
