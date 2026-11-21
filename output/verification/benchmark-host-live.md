# Benchmark native host and contract acceptance

Dates: 2026-11-20–21 (Asia/Kolkata). Feature state: **Experimental**, with the local acceptance slices below verified.

## Real host inference

The compiled production application and production Benchmark worker ran as separate native processes. Only the acceptance launcher's loopback listener and startup/reconciliation wrapper differ from the production entry point. MongoDB 7 and Redis 7.2 ran in nonce-owned, non-root Docker containers on a private internal network, with disposable bind directories, read-only roots, dropped capabilities, bounded memory/PIDs, and no published datastore ports. Existing application volumes were not mounted.

The provider was the already-installed host Ollama at `127.0.0.1:11434`, using `phi3:latest`, digest `4f222292793889a9a40a020799cfd28d53f3e01af25d48e06c5e708610fc47e9`. No model pull or listener change occurred. [Machine-readable host result](benchmark-host-live.json).

| Measurement | First compatible run | Second compatible run |
| --- | ---: | ---: |
| Completed/passed calls | 6/6 | 6/6 |
| Wall duration | 7,556 ms | 3,107 ms |
| Sum of provider-reported durations | 7,378 ms | 2,967 ms |
| Median TTFT | 49 ms | 18.5 ms |
| Median call duration | 651 ms | 253 ms |
| Reported output tokens | 382 | 382 |

These measurements include warmup/caching and uncontrolled host load. They are acceptance observations, not a hardware comparison or performance guarantee.

Both successful-run samples contained sanitized NVIDIA RTX 5070 Laptop GPU metrics. Independently, Ollama reported the matching Phi3 digest with 3,810,346,925 bytes allocated in VRAM, and `nvidia-smi` reported the Ollama compute process using 3,648/3,661 MiB. This establishes observed host GPU offload; GPU snapshots do not attribute utilization to individual calls. Neither public nor persisted Benchmark snapshots contained UUID fields.

Passed behavior:

- SSE transport disconnect/reconnect preserves the durable run and monotonic revisions.
- Second-user list, detail/export-data, stream, cancel, and delete requests cannot expose or mutate the owner's records.
- Queued cancellation with the worker stopped executes zero calls.
- MongoDB, Redis, API, and worker restart preserves completed detail exactly and executes an existing queued run successfully.
- Running cancellation becomes terminal through persisted state and worker Pub/Sub.
- SIGKILL during an observed in-flight call, natural lease expiry, reconciliation, and API/worker restart produce `interrupted` without adding a call-start or completed result. The uncertain call is not retried.
- Exact fixture container/network cleanup passes, and every pre-existing Docker volume retains its creation/mount identity.

## Live bounds and concurrency with a synthetic provider

[Machine-readable contract result](benchmark-contract-live.json). This mode uses a loopback Ollama-protocol fault fixture with the real compiled application, production worker, Redis, and MongoDB. It does **not** establish external-provider or GPU behavior.

- Six exact 16-KiB UTF-8 responses persist correctly (96 KiB total).
- One additional two-byte character terminates the run as `output_limit` after one provider call; no overflowing output is persisted and the provider connection closes.
- The unmodified 180-second timeout fires at 180,229 ms, records zero completed calls, and closes the held provider connection.
- Running cancellation closes the held provider connection without starting another call.
- Two owners with two actual worker processes complete twelve calls with provider-observed peak concurrency one.
- With 94 terminal fixture records seeded alongside five real owner records, authenticated APIs admit record 100, reject record 101 without persistence, expose four pages of 25 unique records, and allow deletion/readmission. The other owner sees only its own record.
- Two concurrent starts with free retention capacity admit exactly one durable queued run; the loser receives `429 BENCHMARK_BUSY`.
- Fixture cleanup and preservation of existing volume identities pass.

The per-call limit and six-call suite imply at most 96 KiB of valid output. The 128-KiB run limit is defensive and cannot be independently reached through valid calls. Healthy two-worker serialization is not evidence of stale-worker fencing after lease loss or an atomic multi-replica retention quota.

## Browser acceptance and regression

Installed Chrome/Playwright exercises the production frontend build through a loopback proxy and real disposable-user login, cookie refresh, API calls, and Socket.IO. Two real Phi3 runs supply comparison data. The test checks the comparison meters against canonical aggregates and the downloaded JSON against canonical call indexes, output text, and byte counts. It checks comparison rendering at 1440, 768, and 375 pixels.

Visual inspection found that the comparison selector extended beyond its card at 375 pixels even though the document itself did not scroll horizontally. The added card-overflow assertion reproduced the failure. The selector now has bounded width and uses the available card width on mobile. The assertion is retained in `scripts/benchmark-browser-acceptance.cjs`.

The [final browser result](benchmark-browser-live.json) and comparison screenshots at [1440](benchmark-comparison-1440.png), [768](benchmark-comparison-768.png), and [375 pixels](benchmark-comparison-375.png) pass after the fix. There is no prior visual baseline or full accessibility audit, so no visual-regression or accessibility certification is claimed.

## Verification and remaining scope

Backend build, seven Benchmark suites/40 tests, frontend build, six Benchmark model tests, backend/frontend lint, tooling-security, script syntax, and whitespace checks pass. Frontend build retains its existing large-chunk and stale Browserslist warnings.

Commands: `npm run verify:benchmark-host`, `npm run verify:benchmark-contract`, and the optional installed-Playwright `--browser` path documented in [BENCHMARKS.md](../../docs/BENCHMARKS.md).

Still pending: the Compose bridge/container-GPU path, an explicitly approved external provider, provider-log correlation under controlled load, browser transport loss during active inference, safe checkpoint takeover, stale-worker fencing/heartbeat loss, atomic multi-replica quotas, and remote/Kubernetes acceptance. Native SSE disconnect is not browser-network-loss proof; connection closure against the cooperative fixture does not prove cancellation of external provider computation or billing. No external endpoint/key was configured in the checked repository environment. Notebook's separate AppArmor-host failure remains unresolved.
