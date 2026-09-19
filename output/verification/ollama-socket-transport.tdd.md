# Ollama Unix socket transport: TDD evidence

Journey: use the configured local Ollama bridge from the existing provider without opening a host TCP listener, leaking requests to environment proxies, or following redirects outside the bridge. Preserve the existing TCP path.

## RED

Command (backend): `npm test -- --runInBand src/config/environment.test.ts src/services/ai/factory.test.ts src/services/ai/providers/ollamaProvider.test.ts`

Before implementation, configuration tests had 12 failures and 14 passes. Factory/provider test compilation rejected the newly exercised missing socket properties. Runtime status tests separately failed twice because socket location and transport metadata were absent.

## GREEN

- Same three focused suites: 41 tests passed, including a real temporary Unix socket HTTP exchange and a rejected 302 response. Socket listener needed execution outside the sandbox after an EPERM result.
- Including runtime status and its API route: 5 suites / 46 tests passed.
- Full backend `npm test -- --runInBand`: 72 suites / 486 tests passed, 27.026 seconds.
- Backend `npm run build` and `npm run lint`: both exit 0.
- `git diff --check`: exit 0.

Tests prove path normalization/control/byte-limit validation, rejection for non-Ollama providers, factory propagation, fixed HTTP origin with proxy/redirect escape disabled, normal TCP origin preservation, real socket model listing, and runtime status without filesystem-path exposure.

## Coverage and boundaries

Focused coverage command added `--coverage` and collectCoverageFrom for environment.ts, factory.ts, ollamaProvider.ts, runtimeStatus.ts. Result: 73.92% statements, 66.66% branches, 67.74% functions, 75.92% lines across these entire existing files. This is below the skill's 80% target; older factory fallback and provider error/stream branches remain uncovered by this focused selection. Do not present this as full coverage.

This report does not prove browser inference, Compose bridge connectivity, GPU inference, or model quality. Those require separate live evidence. No checkpoint commits were made: the shared dirty worktree is preserved for the parent task's review.
