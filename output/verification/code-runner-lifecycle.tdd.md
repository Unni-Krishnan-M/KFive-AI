# Code runner lifecycle evidence — 2026-09-19

Journey: submitted stdin reaches a disposable runtime, and broker restart does
not permanently abandon recently created containers. Docker patterns and TDD
skills guided isolation review and regression-first changes; a read-only
subagent independently identified stdin and startup-only reaper gaps.

Changed: executor create flags, executor regression, new ReaperLoop and its
tests, main lifecycle wiring, live Python verifier, Code Lab documentation.

- RED: executor regression failed because create lacked `--interactive`;
  24 tests passed and one failed before the fix.
- RED: new scheduler tests could not compile because ReaperLoop did not exist.
- GREEN: `npm test --workspace @kfive/code-runner` passed all seven test files
  (TypeScript compilation included).
- Coverage: `node --test --experimental-test-coverage
  services/code-runner/dist/test/reaperLoop.test.js`: 100% lines/functions,
  93.33% branches. Earlier whole-runner coverage was 82.95% lines, 69.47%
  branches, 64.06% functions: the full coverage gate is NOT satisfied.
- LIVE FAIL: `node scripts/verify-code-runner-live.cjs --allow-live-test`
  reproduced `container rootfs is marked read-only` during source copy.
  Cleanup assertion passed before the execution-success assertion failed.
  Python image digest: sha256:c4634f578a412db396771b61b064c6e546c9d6414c7fb5b1b05d5871f1885f7b.

No Code Lab enablement or deployment performed. No user volumes deleted.
No checkpoint commits: existing dirty worktree preserved and .git read-only.
Next: redesign source delivery without writable rootfs/host mounts; rerun live
stdin, isolation, resource-limit, cancellation and crash/restart scenarios,
then authenticated queue/history/browser end-to-end verification.
