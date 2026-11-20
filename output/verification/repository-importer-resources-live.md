# Repository importer target-host resource verification

Date: 2026-11-20  
Classification: **Implemented acceptance slice / Experimental Repository Analyzer**

## Work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary agent | Bounded importer framing, connection admission, path-collision indexing, Compose cgroups, live verifier | Two near-maximum imports succeed concurrently; a fixed third is busy; hostile entry, expansion, and manifest shapes fail; no importer OOM/restart, swap, PID exhaustion, backend parser child, data loss, or protected-volume replacement | Focused tests, rendered Compose, runtime inspection, cgroup sampling, real frontend-proxy/API/MongoDB run below | Focused and full regression, build/lint, production audit, manifest render, independent implementation/security/evidence review, `git diff --check` |
| Independent implementation reviewer | Read-only code and race/error-path review | No unresolved correctness or boundedness finding | Final review recorded in this file | GO |
| Independent security reviewer | Read-only isolation, verifier safety, cleanup, and disclosure review | No unresolved high/critical finding; no destructive data operation | Final review recorded in this file | GO |
| Independent evidence reviewer | Read-only claim-to-evidence audit | Feature state and exclusions remain accurate | Final review recorded in this file | GO |

## Review-driven TDD

The initial review found four amplification/control gaps:

1. fragmented Unix-socket frames repeatedly concatenated accumulated buffers;
2. accepted pre-input sockets were not independently capped or expired;
3. every archive path scanned all prior normalized paths for prefix collisions;
4. Compose allowed 512 MiB memory plus another 512 MiB of swap.

Focused RED tests reproduced the frame concatenation, connection admission, path-key scan, and missing swap contracts. The implementation now allocates one exact frame buffer after validating the fixed header, caps total importer connections at four with a two-second input deadline, indexes ancestor/descendant collisions by path depth, and sets `memswap_limit` equal to `mem_limit` in local and production Compose.

The first live attempt then exposed a host-format verifier defect: `cpu.stat` contained the valid dotted key `core_sched.force_idle_usec`. A focused test failed against the narrow parser and passed after admitting bounded cgroup key characters while retaining duplicate and non-negative-value checks. The next attempt exposed seven parallel registrations interacting with the five-request in-flight auth limit. A source contract failed first; registrations were made sequential, and the focused verifier contract passed. Neither failed attempt reached the importer workload, and guarded nonce-scoped cleanup ran.

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
- exact rejection of 2,001 entries, an excessive expansion/compression-ratio shape, and 21 selected manifests;
- a valid recovery canary, saved-report reads, deletion, readiness, log non-disclosure, exact MongoDB cleanup, and protected-volume identity comparison.

Observed result:

| Measure | Result |
| --- | ---: |
| Successful concurrent near-maximum analyses | 2 |
| Samples | 307 |
| Maximum sampled importer memory | 178,499,584 bytes |
| Importer cgroup `memory.peak` | 179,580,928 bytes |
| Maximum sampled / cgroup-peak PIDs | 26 / 26 |
| Maximum importer parser children | 2 |
| Backend parser children | 0 in every sample |
| Swap used | 0 bytes in every sample |
| CPU usage delta | 731,681 microseconds |
| Throttled-period delta | 5 |
| OOM / OOM-kill / memory-max event delta | 0 / 0 / 0 |
| PID-max event delta | 0 |
| Importer restart or OOM kill | none |
| Temporary users / remaining reports / remaining users | 7 / 0 / 0 |

All six protected persistent-volume identities and the importer socket-volume identity were unchanged. The existing Compose data volumes were never removed or recreated. The notebook worker remained intentionally stopped. The working tree was externally relocated intact from `/home/u26kris05/KFive-AI` to `/home/u26kris05/Projects/KFive-AI` during the run; Git HEAD and every dirty change were verified before work resumed.

## Boundary

This proves a deterministic local target-host acceptance set under the enforced Compose cgroup. It does not prove exhaustive native-allocation safety, arbitrary hostile ZIP safety, long-duration soak behavior, production capacity or latency, multi-host/distributed quotas, Kubernetes importer isolation, or complete semantic re-analysis of importer responses. Repository Analyzer remains **Experimental**.

## Final gates

Pending at evidence creation: full backend/frontend regression, builds/lint, production lockfile audit, final Compose render/contracts, independent reviews, and `git diff --check`. Their exact final results are appended only after execution.
