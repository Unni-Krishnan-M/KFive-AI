# Dependency and frontend security follow-up — 2026-09-17

Scope: frontend workspace dependencies, service-worker cache policy, and root development launcher dependencies.
This is not a full platform penetration test or a clean dependency bill of health.

## Root tooling follow-up

- Updated the locked `concurrently -> shell-quote` dependency from 1.8.3 to
  1.10.0. This addresses the root audit's critical quoting advisory
  [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)
  and the parser advisory
  [GHSA-395f-4hp3-45gv](https://github.com/advisories/GHSA-395f-4hp3-45gv).
  This is development-launcher tooling, not proof of an exploitable backend path.
- `npm ls shell-quote` confirms the actual launcher resolves 1.10.0.
  Three regression tests passed: rejected control-character operator tokens,
  ordinary quoted-argument round trips, and two harmless launched commands.
  Run `npm run test:tooling-security`; this also participates in root `npm test`.
- Repeated full-root `npm audit --json`: **39 findings — 0 critical, 18 high,
  19 moderate, 2 low**, versus 40 findings including one critical before this
  update. Audit exits 1 because remaining findings are unresolved. These counts
  are distinct from the frontend-scoped audit and historical container build.
- This lockfile/tooling update has not been rebuilt into container images;
  it does not change the deployed application's functionality.
- Full root `npm test` exited successfully: 3 tooling, 120 frontend, 486 backend,
  25 code-runner, 65 notebook-runtime and 11 bridge tests passed; 3 notebook
  integration cases were skipped because runtime-image dependencies are absent
  on the host. Backend Jest reported a worker teardown warning despite passing.
  Root lint and frontend/backend/code-runner production builds passed. Frontend
  build retains a large Chat chunk warning. These checks are not substitutes for
  live container/browser E2E.
- Teardown diagnostic: `npm run test --workspace backend -- --runInBand
  --detectOpenHandles` passed all 72 suites / 486 tests with no open-handle
  report when temporary local sockets were permitted. The initial sandboxed
  diagnostic had one `listen EPERM` failure; it was rerun with the required
  permission, not patched around. The earlier parallel worker warning was not
  reproduced in the serial diagnostic and is not claimed fixed.

## Verified changes

- Shared runtime HTTP client: pinned both application workspaces to Axios 1.18.0
  from installed 1.16.0, following the
  [maintainer release notes](https://github.com/axios/axios/releases/tag/v1.18.0).
  Repeat root audit reports **38 findings: 0 critical, 17 high, 19 moderate,
  2 low**, with no Axios finding. This supersedes the earlier 39-finding source
  audit, not the dependency versions inside existing containers.
- Added a real loopback HTTP regression for provider bearer authorization,
  SSE completion, and active-stream cancellation using Axios's HTTP adapter.
  All 21 provider tests passed. Frontend tests use real Axios interceptors with
  a controlled adapter to verify multipart data preservation and 401 refresh /
  retry credentials. Fixed the Vitest `@` alias to match application resolution;
  all 122 frontend tests passed. The initial new test failures were test setup
  errors (missing alias and wrong cancellation-code expectation), not product
  regressions. No browser/network upload E2E or container deployment is claimed
  for this dependency update yet.
- Final Axios-update verification: full backend passed **73 suites / 487 tests**;
  frontend/backend/code-runner production builds and root lint passed. The
  frontend large-chunk warning remains. Reproduce with `npm run test --workspace
  frontend`, `npm run test --workspace backend -- --runInBand`, `npm run build`
  and `npm run lint`; backend transport fixtures require local socket permission.

- Vitest and coverage-v8 upgraded together from 1.6.1 to exact 3.2.6. The registry
  audit reported the former pair as critical via
  [GHSA-5xrq-8626-4rwp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp).
  KFive tests use Node mode, not an exposed Vitest UI/API server. Tooling exposure
  and static frontend runtime exposure are distinct.
- Scoped root override makes Refractor resolve Prism 1.30.0 rather than its nested
  1.27.0. A regression failed on the old nested version and passes on the new one;
  JavaScript, Python and markup syntax-tree text reconstruction also passes.
  [Prism advisory](https://github.com/advisories/GHSA-x7hr-w5r2-h6wg).
  This does not prove every wrapped Refractor grammar immune to denial of service.
- Removed service-worker runtime caching of remote `https://api.*` responses.
  Static precaching remains; API and Socket.IO paths cannot receive the cached
  navigation shell. The activation migration deletes only the legacy `api-cache`.
- Fixed `.gitignore` to include only the new public cleanup script without
  exposing unrelated ignored public artifacts.

## Executed verification

- Full frontend: 120 tests across 20 files passed with Vitest 3.2.6.
- Frontend lint and production build passed.
- PDF coverage gate: 88.29% statements/lines, 85.4% branches, 100% functions.
  Changed instrumentation from Vitest 1 explains why older recorded percentages
  must not be treated as the current coverage result.
- Actual production-preview browser worker activation on isolated localhost:3003:
  synthetic legacy API cache removed, unrelated sentinel cache preserved, static
  precache present. Sentinel and worker registrations cleaned up; preview stopped.
  Browser console showed a favicon 404, not a migration failure.
- `npm ls prismjs vitest --workspace frontend` succeeds and confirms the intended
  nested resolution and matching test/coverage versions.
- Repeat frontend audit: **29 findings — 0 critical, 17 high, 10 moderate, 2 low**.
  Prior scoped audit: 32 findings including 2 critical. Counts can change as the
  registry advisory database changes; this is not the earlier build's root count.

## Remaining work

### Axios deployment follow-up

Executed `docker compose -f docker-compose.yml -f docker-compose.ollama-host.yml
up -d --build backend frontend` successfully. Existing databases/volumes were
preserved; all six baseline containers reached healthy status. Backend image
`sha256:f8034b3fd26f666a6e0177f7cdeec19559315566db2569703d86dd706be5d9f8`
resolves Axios 1.18.0; frontend image
`sha256:ed2121d31715ec3b711d59edb5cdbc2a39f5cd50fd9285cba4fdbec03c9aa0bf`
serves worker artifacts byte-identical to the local build. Readiness returned
HTTP 200 with MongoDB/Redis available. Provider and Chroma readiness were
explicitly not checked by that endpoint; Code Runner, Document Processor and
OCR were not configured.

Isolated read-only Playwright smoke loaded the landing page and followed Sign in
to the rendered login form at `http://127.0.0.1:3002`. Console inspection returned
zero errors and zero warnings; a verbose password-autocomplete advisory remains.
No credentials were submitted and no user records were modified. This supersedes
the pending-container-deployment note above, but authenticated Chat/upload browser
regressions, mobile/visual baselines and accessibility verification remain pending.
The installed CLI lacked its documented `network` command; do not infer complete
network success from this smoke check.

These security changes were subsequently deployed through a successful
frontend-only Compose build. `node scripts/verify-service-worker-deployment.cjs`
verified HTTP 200, JavaScript MIME type, and byte-for-byte equivalence of both
served worker artifacts with the tested local build. Image:
`sha256:86c37bc809b7996e9e1ce838f4cce81cbee445037a3733e33e5a0a60d7131f4a`.
Existing browser caches are not migrated until users activate the new worker.
Storage errors leave a generic console warning and require explicit site-data
cleanup; unrelated caches are never removed by the migration.

Remaining findings include Axios, Socket.IO parser/ws, Router, Vite/esbuild,
Vitest mocker, and several build dependencies. Upgrade them in tested groups;
do not apply a blanket forced major upgrade. Backend and full-root audit counts
were not measured in the scoped audit above. The subsequent container build's
broader install audit reported 30 findings including one critical; do not apply
the frontend-scoped zero-critical count to the whole repository. Browser Chat rendering and auth/upload
regression checks after deployment remain outstanding.
