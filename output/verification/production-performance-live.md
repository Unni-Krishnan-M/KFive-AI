# Production authenticated-read performance verification

Date: 2026-10-25  
State: Experimental  
Final live nonce: `343f5e35553b`

## Work board and fixed gate

| Owner | Scope | Acceptance | Evidence | Merge gate |
| --- | --- | --- | --- | --- |
| Primary | Authenticated profile-read burst | 24 warmups excluded; 240 semantic reads at concurrency 12 | Monotonic client timings and response validation | p95 ≤750 ms, p99 ≤1,500 ms, throughput ≥20/s |
| Primary | Metrics/resources/restart | Exact request/duration deltas, bounded memory, declared limits, no OOM, recovery | Private metrics scrape, Docker inspection/stats, real HTTP | Restart readiness/login/profile and unchanged volumes |
| Security reviewer | Containment/cleanup | Private services/helper, scoped rate override, fail-closed ownership | Read-only review and exact absence checks | No unresolved critical/high finding |
| Implementation reviewer | Measurement correctness | Deterministic percentiles/workers/parsers and honest sampled claims | Unit/static tests and live structured result | GO for bounded Experimental claim |
| Evidence reviewer | Claim boundary | No peak, soak, sizing, or remote generalization | Docs/evidence review | Limitations remain explicit |

## TDD and verifier corrections

`scripts/production-performance.test.cjs` first failed because the helper module was absent. The implemented helper tests cover deterministic nearest-rank percentiles, exact finite Prometheus samples, bounded workers, Docker binary byte units, and removal of Docker stats ANSI controls. All four production contract files pass, verifier syntax passes, and `git diff --check` passes.

The first live red run reached the workload but this Docker CLI decorated streaming stats JSON with cursor-control bytes. Strict parsing failed; the exact nonce-owned project, volumes, images, and its temporary secret directory were manually removed. The parser now strips only ANSI control sequences and propagates asynchronous parse errors through cleanup.

Independent review rejected the next run's one pre-burst Docker sample as a peak claim. The final verifier requires a second sample after measurement starts, emits the sample count and `maxSampled*` names, and makes no instantaneous-peak claim. Review also found a collision-cleanup flaw: a failed absence preflight would have entered unconditional cleanup. Destructive cleanup is now authorized only after all project/image absence checks pass; protected-volume comparison and temporary-directory removal remain unconditional. Both verifier images carry and must match the nonce ownership label.

## Final live result

The isolated production-Compose project used local mutable images, internal HTTP, a loopback-only frontend, private API/datastores, and a private read-only/capability-dropped metrics helper. Only its backend received `RATE_LIMIT_MAX_REQUESTS=1000`, and container inspection verified the override.

After 24 excluded warmups, twelve fixed workers issued exactly 240 authenticated `GET /api/v1/user/profile` requests with one keep-alive agent. Every response was HTTP 200, identified the registered user by ID and email, and omitted password and refresh-token fields.

| Measurement | Result |
| --- | ---: |
| p50 | 23.212823 ms |
| p95 | 29.984268 ms |
| p99 | 31.564060 ms |
| Maximum | 34.775131 ms |
| Throughput | 495.474197 requests/second |
| Prometheus success/all-status/duration deltas | 240 / 240 / 240 |
| Process RSS | 131,506,176 → 136,359,936 bytes (+4,853,760) |
| Process heap used | 47,094,640 → 50,505,520 bytes (+3,410,880) |
| Docker stats samples | 2 burst-adjacent samples |
| Maximum sampled container memory | 88,436,899.84 bytes |
| Maximum sampled PIDs | 12 |
| CPU observations | 0.20%, 0.20% (evidence only) |

The backend's 1-GiB memory, 2-CPU, 192-PID, read-only-root, all-capabilities-dropped, and `no-new-privileges` settings were enforced; it remained running and was not OOM-killed. After restart, real loopback readiness reported MongoDB and Redis available, login returned the same user ID, and a profile read succeeded. All five disposable volume identities were unchanged.

Cleanup removed only the exact Compose-labelled containers, networks, and volumes plus the two verifier-labelled images. No final nonce resource remained; the six known `kfive-ai_*` volume identities were unchanged and the development readiness endpoint remained available.

## Claim boundary

This proves one warm-cache, single-user, single-backend, local-Mongo authenticated read burst on this host. It is not an SLO, soak/endurance test, cold-cache test, production sizing, or instantaneous peak-resource measurement. Process memory values are before/after snapshots; Docker values are two burst-adjacent samples; CPU observations are not a capacity threshold.

Writes, uploads, queues, AI inference, streaming, GPU, mixed workloads, multi-user fairness, multiple replicas, default rate-limit behavior, failover, horizontal scaling, immutable registry pulls, TLS, WAN latency, a remote host, and operation without the development laptop remain unverified.
