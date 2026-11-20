# Repository importer target-host resource verification

Date: 2026-11-20  
Classification: **Implemented acceptance slice / Experimental Repository Analyzer**

## Work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary agent | Bounded importer framing, connection admission, path-collision indexing, Compose cgroups, live verifier | Two near-maximum imports succeed concurrently; a fixed third is busy; hostile entry-count, compression-ratio, and manifest-count shapes fail; no importer OOM/restart, swap, PID exhaustion, backend parser child, data loss, or protected-volume replacement | Focused tests, rendered Compose, runtime inspection, cgroup sampling, real frontend-proxy/API/MongoDB run below | Focused and full regression, build/lint, production audit, manifest render, independent implementation/security/evidence review, `git diff --check` |
| Independent implementation reviewer (previous checkpoint) | Read-only code and race/error-path review | No unresolved correctness or boundedness finding | Prior review reported GO; resumed source review described below | Prior GO |
| Independent security reviewer (previous checkpoint) | Read-only isolation, verifier safety, cleanup, and disclosure review | No unresolved high/critical finding; no destructive data operation | Prior security re-review reported GO after cleanup fixes | Prior GO |
| Independent evidence reviewer (previous checkpoint) | Read-only claim-to-evidence audit | Feature state and exclusions remain accurate | Two wording findings corrected before interruption; resumed evidence check described below | Corrections checked |

## Review-driven TDD

The initial review found four amplification/control gaps:

1. fragmented Unix-socket frames repeatedly concatenated accumulated buffers;
2. accepted pre-input sockets were not independently capped or expired;
3. every archive path scanned all prior normalized paths for prefix collisions;
4. Compose allowed 512 MiB memory plus another 512 MiB of swap.

Focused RED tests reproduced the frame concatenation, connection admission, path-key scan, and missing swap contracts. The implementation now allocates one exact frame buffer after validating the fixed header, caps total importer connections at four with a two-second input deadline, indexes ancestor/descendant collisions by path depth, and sets `memswap_limit` equal to `mem_limit` in local and production Compose.

The first live attempt then exposed a host-format verifier defect: `cpu.stat` contained the valid dotted key `core_sched.force_idle_usec`. A focused test failed against the narrow parser and passed after admitting bounded cgroup key characters while retaining duplicate and non-negative-value checks. The next attempt exposed seven parallel registrations interacting with the five-request in-flight auth limit. A source contract failed first; registrations were made sequential, and the focused verifier contract passed. Neither failed attempt reached the importer workload, but their original cleanup paths left five and seven temporary users respectively. Before the final run, a separate guarded recovery enumerated only the strict verifier email namespace, required exactly the observed five-label and seven-label nonce families, deleted those exact 12 users and any owner-scoped reports, and proved zero matching reports/users remained. No unrelated record was selected.

Independent security review then found that cleanup passed the complete repository `.env` to its transient Mongo client and deleted each identity before verifying later identities. New RED source contracts require no repository env file and full-set preflight. The final helper derives only the three Mongo initialization values from the already-running Mongo container, passes those three renamed variables plus the bounded evaluation through a narrow child environment, validates every exact ID/email pair before any deletion, and runs the short-lived client read-only/capability-free/no-new-privileges on only the private Mongo network. Security re-review returned GO, and the final live run proved this cleanup path.

## Static and runtime controls

- Importer: non-root `10001:10002`, network `none`, read-only root, one socket volume, no secrets/application data/Docker socket, all capabilities dropped, `no-new-privileges`, private IPC/cgroup namespaces, 32 MiB no-exec tmpfs, zero core dumps, init enabled.
- Runtime inspection: `Memory=536870912`, `MemorySwap=536870912`, `NanoCpus=1000000000`, `PidsLimit=48`, OOM killer enabled. On cgroup v2, `memory.max=536870912`, `memory.swap.max=0`, `pids.max=48`, and `cpu.max=100000 100000`.
- Daemon admission: at most two active parser children, at most four accepted connections, two-second partial-input expiry, exact health/frame magic, exact preallocated request frame, and fail-closed trailing data.
- Archive collision checks are bounded by path depth rather than prior entry count while retaining normalization, case, file/directory, and ancestor collision rejection.

## Live path and result

Command:

```text
node scripts/verify-repository-importer-resources-live.cjs --allow-live-test
```

The opt-in verifier used the real loopback frontend proxy for normal API operations and the separately loopback-bound backend only to hold two multipart bodies concurrently (Nginx deliberately buffers request bodies). It created seven nonce-scoped users, sampled importer and backend cgroups every 5 ms, and exercised:

- two concurrent deterministic ZIPs, each 9,699,328 compressed bytes, 2,000 entries, 20 selected manifests, 7,949,346 declared bytes, and a maximum 402-byte path;
- one fixed third upload rejected as `429 REPOSITORY_ANALYZER_BUSY` while the first two were admitted;
- exact rejection of 2,001 entries, a greater-than-100:1 compression-ratio shape, and 21 selected manifests;
- a valid recovery canary, saved-report reads, deletion, readiness, log non-disclosure, exact MongoDB cleanup, and protected-volume identity comparison.

Observed result:

| Measure | Result |
| --- | ---: |
| Successful concurrent near-maximum analyses | 2 |
| Samples | 213 |
| Maximum sampled importer memory | 198,205,440 bytes |
| Post-run importer cgroup lifetime `memory.peak` | 198,434,816 bytes |
| Maximum sampled / cgroup-peak PIDs | 26 / 26 |
| Maximum importer parser children | 2 |
| Backend parser children | 0 in every sample |
| Swap used | 0 bytes in every sample |
| CPU usage delta | 526,459 microseconds |
| Throttled-period delta | 3 |
| OOM / OOM-kill / memory-max event delta | 0 / 0 / 0 |
| PID-max event delta | 0 |
| Importer restart or OOM kill | none |
| Temporary users / remaining reports / remaining users | 7 / 0 / 0 |

All six protected persistent-volume identities and the importer socket-volume identity were unchanged. The existing Compose data volumes were never removed or recreated. The notebook worker remained intentionally stopped. The sampled maximum is attributable to the workload interval; `memory.peak` and `pids.peak` are post-run cgroup lifetime counters and are recorded separately. Before the final run, external cgroup drift changed `memory.swap.max` from `0` to `max` without a container restart; the verifier refused to continue, only the stateless importer was recreated, and both direct inspection and the final verifier reconfirmed `memory.swap.max=0`. The working tree was externally relocated intact from `/home/u26kris05/KFive-AI` to `/home/u26kris05/Projects/KFive-AI` during the run; Git HEAD and every dirty change were verified before work resumed.

## Boundary

This proves a deterministic local target-host acceptance set under the enforced Compose cgroup. It does not prove exhaustive native-allocation safety, arbitrary hostile ZIP safety, long-duration soak behavior, production capacity or latency, multi-host/distributed quotas, Kubernetes importer isolation, or complete semantic re-analysis of importer responses. Repository Analyzer remains **Experimental**.

## Final gates

The interrupted development checkpoint reported full backend regression passing **83/83 suites, 579/579 tests** and frontend regression passing **23/23 files, 162/162 tests**. These are carried-forward results, not new executions in the resumed session. The resource implementation and test sources are unchanged during this closeout; the existing documentation edits were preserved.

The resumed session on 2026-11-20 completed the outstanding executable gates:

| Gate | Result |
| --- | --- |
| `npm run build` | PASS: frontend, backend, and code-runner builds; Vite retains its non-failing warning about chunks larger than 500 kB |
| `npm run lint` | PASS: frontend, backend, and code-runner checks |
| `node --test scripts/repository-importer-compose.test.cjs scripts/repository-importer-resource.test.cjs scripts/production-compose.test.cjs` | PASS: all three test files, zero failures |
| `docker compose --env-file .env.example -f docker-compose.yml config --quiet` | PASS |
| `docker compose --env-file .env.production.example -f docker-compose.production.yml config --quiet` | PASS; template rendering only, not a production deployment |
| `npm audit --omit=dev --json` | Zero critical/high, six moderate dependency findings; audit exits 1 because moderate findings remain |
| `git diff --check` | PASS |

The six moderate dependency entries are `@tailwindcss/typography`, `postcss-selector-parser`, `bullmq`, `uuid`, `react-router`, and `react-router-dom`. They remain follow-up work; this is not a clean dependency audit. No dependency upgrades were made during closeout.

Resumed primary-agent review checked exact frame allocation and admission/deadline bounds, the ancestor/descendant collision index, full-set identity preflight before cleanup, the narrow Mongo credential environment, and the evidence's workload and sampling limits. The previous evidence review's two findings are resolved in the text above: both failed-run user families and their guarded cleanup are disclosed, and hostile rejection claims name only entry count, compression ratio, and manifest count. No new independent review was performed in the resumed session; earlier review outcomes are explicitly historical. The live workload, cleanup, and volume measurements above also remain the earlier completed run, not a repeated live test.

This closes the interrupted Compose resource-acceptance checkpoint. Dedicated Kubernetes importer isolation is the next roadmap slice and remains pending.
