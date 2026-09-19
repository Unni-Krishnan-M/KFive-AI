# PWA private-response cache regression

Journey: an authenticated user's API responses must not be persisted in a
shared service-worker cache or reused for another user. The static app shell
must remain available offline. Derived from security review, not an external plan.

Changes: `frontend/vite.config.ts` removes the API runtime cache and excludes
API/socket navigations from the static shell fallback. A same-origin imported
worker script deletes only the legacy `api-cache` on activation. Storage failure
logs a generic warning and does not prevent the safer worker taking over.
It does not clear unrelated caches, localStorage, or user project data.

## Executed evidence

- `npm test --workspace frontend -- src/config/pwaSecurity.test.ts`: RED before
  implementation (5 failed, 1 passed), GREEN afterward (6 passed). The first
  policy-only RED run showed 2 failed, 1 passed. An initial duplicate `--run`
  invocation failed CLI parsing and is not RED evidence.
- Tests inspect PWA plugin options and execute the actual cleanup script in an
  isolated JS context. Both successful deletion and rejected cache deletion are
  covered; the sole cache deletion argument is `api-cache`.
- `npm run build --workspace frontend`: passed after correcting a test-only
  TypeScript project-reference import. Generated 41 precache entries. Existing
  ChatPage chunk-size warning remains.
- `npm run lint --workspace frontend`: passed.
- Generated `frontend/dist/sw.js` was checked with Node assertions: same-origin
  cleanup import present; static precache and NavigationRoute present; no
  NetworkFirst or api-cache runtime strategy. Distributed cleanup script is
  byte-identical to its source.
- Focused V8 coverage command with `--coverage.include=vite.config.ts`
  `--coverage.exclude=src/**` and all four thresholds at 80 reported 100% for
  the configuration file. Without the explicit exclude override, the runner
  excludes config files and reports no files; that empty report is not evidence.

## Limitations

Configuration coverage is not whole-frontend coverage. The cleanup script's
branches are behaviorally tested via VM, not included in that coverage number.
Browser service-worker activation/cache migration and deployment remain to be
verified. Existing API cache persists until the upgraded worker activates;
if browser storage deletion fails, the warning asks the user to clear site data.
No git checkpoint commits were made, per the parent task's explicit no-commit
instruction. TDD and security-review skills guided this scoped change.
