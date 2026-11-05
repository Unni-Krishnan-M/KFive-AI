# Code Lab source delivery — 2026-09-19

User journey: execute Python/JavaScript snippets with real stdin in disposable,
read-only, resource-limited containers without mounting host files.

Docker/TDD skills guided the fix. A read-only review agent checked the delivery
design; a documentation agent updated Code Lab guidance. Existing dirty changes
were preserved; no checkpoint commits because .git is read-only.

## Changes and evidence

- `runtimeRegistry.ts`: fixed interpreter bootstraps decode base64 argv chunks
  (at most 32 KiB each). Native stdin is unchanged. Python creates the actual
  `__main__` module; Node provides CommonJS main-module semantics.
- `executor.ts`: removed host temporary source and docker cp; retained all
  container restrictions. Source now appears in host argv and Docker metadata;
  documentation explicitly warns against submitting secrets.
- Source-delivery unit test first failed compilation for the missing new API.
  Live Python stdin first failed with `container rootfs is marked read-only`.
  Python and Node main-module assertions each reproduced compatibility errors
  before their corresponding fixes.
- `npm test --workspace @kfive/code-runner`: 29 tests passed; later Node output
  groups the same suite as eight passing files. Compilation included.
- `npm run lint --workspace @kfive/code-runner`: passed.
- `node scripts/verify-code-runner-live.cjs --allow-live-test`: eleven scenarios
  passed, including memory/PID enforcement, timeout, output limit, cancellation,
  behavioral isolation, and runtime semantics. Each inspected actual Docker
  configuration and asserted executor cleanup before verifier fallback cleanup.
- `node --test --experimental-test-coverage services/code-runner/dist/test/*.test.js`:
  83.72% lines, 70.66% branches, 68.92% functions. Whole-runner 80% coverage gate
  is not met. Tests do not imply public multi-tenant execution safety.

Images used:

- Python: sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b
- Node: sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

No saved runs or persistent volumes modified; no Code Lab profile enabled.
Remaining: authenticated API/queue/history/browser path; crash/restart testing;
create-abort cleanup race; immutable image configuration; additional languages.
