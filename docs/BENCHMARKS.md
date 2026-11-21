# Model Benchmarks

The Phase 11 Model Benchmarks source slice is implemented and **Experimental**. It runs a fixed, versioned, provider-neutral chat-inference suite through a dedicated BullMQ worker, streams reconnectable progress, and retains owner/project-scoped canonical state in MongoDB. It is not an ML training experiment, model-quality leaderboard, load test, hardware certification, or general GPU scheduler.

## Fixed suite

`chat-core-v1` contains three benign chat prompts and executes each prompt twice, sequentially, for exactly six provider calls. Every call uses `maxOutputTokens: 128`, `temperature: 0`, and `topP: 1`. A run uses the explicitly requested model on the currently configured provider. KFive validates that the model is listed and chat-capable; it never pulls a model, routes to another model, or falls back to another provider.

The fixed prompts test successful bounded inference, not answer correctness. A passed call means the configured provider produced a completed response within the operational bounds. Scores from different provider implementations, model revisions, quantizations, machines, temperatures, background loads, or network conditions are not directly equivalent.

## Recorded measurements

- Per-call wall duration and output byte count.
- Time to first text token when the streaming provider exposes a text event.
- Provider-reported token usage only; KFive does not estimate missing token counts.
- Aggregate medians, pass count, and total wall duration.
- Output tokens per second only when all six calls report output-token usage; it is calculated over total run wall time and therefore includes orchestration and provider overhead.
- Sanitized GPU status before and after the run when the benchmark worker can probe NVIDIA status. GPU UUIDs and other stable hardware identifiers are not stored or returned. The default Compose worker is not granted container GPU access, so its samples correctly remain unavailable until GPU access is explicitly configured and verified.

GPU samples are snapshots, not per-process attribution. They can include unrelated workloads and do not prove that the selected provider used the GPU. A missing snapshot is reported as unavailable rather than silently treated as zero use.

## Limits and lifecycle

- Six sequential calls per run.
- 16 KiB output per call and 128 KiB across a run.
- 180-second total run timeout.
- One benchmark globally through a renewable fenced Redis lease, and one active run per owner through a partial unique MongoDB index.
- 100 retained runs per owner.
- 25 history records per page, at most ten pages.
- 50 bounded audit timeline events.

Runs move through `queued`, `running`, `cancel-requested`, and a terminal state: `succeeded`, `failed`, `cancelled`, `timed_out`, `output_limit`, or `interrupted`. Queued cancellation terminalizes immediately even if the worker is offline. Running cancellation is Mongo-first and Pub/Sub only wakes the active worker; a provider that ignores abort may continue consuming remote resources or incur charges. Browser disconnect does not cancel a durable run; the browser reconnects from the last Mongo revision.

MongoDB is canonical and BullMQ carries only the opaque run id. The worker makes one provider call at a time and checkpoints before the next call. Delivery is attempts-one, and recovery never retries an uncertain in-flight provider call: such a run becomes `interrupted`. Retained completed/failed BullMQ jobs are removed before legitimate redispatch, while active/waiting jobs remain deduplicated by deterministic id. A 30-second reconciler requeues safe active records and handles deleted projects. The Redis lease uses a monotonically increasing fence plus a unique owner token, and every worker mutation uses both plus Mongo revision compare-and-swap.

Active projects allow new benchmarks. Final project validation and run creation share the project mutation lease with archive/delete inside an API process; this is not a distributed transaction across replicas. The 100-run retention count is likewise not an atomic multi-replica quota. Archived project history remains readable but cannot be deleted until the project is restored. Deleted-project terminal history is eligible for cleanup. Workspace and project records remain owner-scoped, and workspace history explicitly excludes every project-bound run.

## API

All routes require JWT authentication and use `/api/v1/benchmarks`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/status?projectId=...` | Report feature availability, operational limits, exact workspace/project scope, and fresh project status |
| `GET` | `/suites` | List the immutable supported suite |
| `GET` | `/runs?page=1&projectId=...` | List bounded owner/scope history |
| `GET` | `/runs/:runId` | Read one owner-scoped detailed run |
| `POST` | `/runs/stream` | Start a run with `{ model, suiteId: "chat-core-v1", projectId? }` and stream SSE progress |
| `POST` | `/runs/:runId/cancel` | Request cancellation or return an idempotent terminal response |
| `DELETE` | `/runs/:runId` | Delete an eligible terminal record |

The stream uses monotonic Mongo revision ids with named `run`, `call-start`, `call-completed`, `completed`, and safe `error` events, followed by `data: [DONE]` on stream completion. `Last-Event-ID` resumes from canonical history. Provider output is JSON-escaped and rendered as inert text by the UI. Closing the transport never cancels the durable run; only the explicit authenticated cancel endpoint does.

## Privacy and cost

Suite prompts are sent to the configured provider six times. A remote/cloud provider can retain request metadata and charge for every call, including work that continues after cancellation. The provider/model snapshot, raw generated outputs, usage metadata, timings, sanitized GPU samples, and timeline remain application-readable in MongoDB and may persist in backups. Do not treat benchmark history as encrypted or securely erased.

## Executed verification

On 2026-09-07, a disposable authenticated browser session against the production Compose frontend queued `chat-core-v1` with listed `phi3:latest`. A temporary internal, CPU-only Ollama service was used because the packaged host service was still loopback-only. The dedicated worker completed all six sequential calls through Redis and persisted canonical MongoDB state in 85.26 seconds: 6/6 passed, all call indexes were ordered from 0 through 5, median TTFT was 288.5 ms, median duration was 7.101 seconds, and provider-reported output throughput was 4.48 tokens/second. The browser rendered the full results and 16-event timeline. Its downloaded JSON contained no execution/lease/owner internals and had SHA-256 `5cb45e272ac236dfbd7fe303201580477b21a3de088362bd6a164f1c9a0bf6bb`.

The same exercise verified a running workspace cancellation at 0/6, a project cancellation at 2/6 with two retained completed calls, completed-run persistence across backend and worker restart, disjoint workspace/project history, and fresh archived-project read-only behavior. The worker correctly reported `nvidia-smi-not-found` because it had no GPU grant. The temporary provider container was removed and `.env` was restored to `http://host.docker.internal:11434`; this evidence does not prove standard host-listener reachability, GPU use, or remote-provider behavior.

## Remaining target-host verification checklist

Before changing this slice from Experimental:

1. Verify the Compose worker-to-host bridge and container GPU grant separately from the now-verified native host worker. Exercise an explicitly approved external provider and its billing/cancellation behavior.
2. Correlate call timings with provider logs under controlled load. Two compatible real runs and browser comparison/export now pass; provider-reported total durations are captured alongside wall time, but no hardware-performance claim is made.
3. Exercise safe checkpoint takeover, stale-worker fencing, and heartbeat/lease loss across replicas. Native queued/datastore restart, in-flight SIGKILL interruption without retry, and healthy two-worker serialization now pass.
4. Verify browser transport loss during active inference beyond the completed native SSE reconnect check, and external-provider behavior when cancellation is ignored.
5. Replace the count-then-create retention check with an atomic multi-replica quota before claiming that boundary across replicas. Local 99/100/101 admission, deterministic pagination, deletion/readmission, and concurrent active-owner admission now pass.

## Native host and contract acceptance — 2026-11-20–21

The native API/worker path reaches the existing loopback-only host Ollama without changing its listener. Two real `phi3:latest` runs pass all six calls; sanitized worker GPU snapshots, Ollama's matching model digest/VRAM allocation, and NVIDIA's Ollama compute-process entry are recorded together. This establishes observed host GPU offload, not per-call attribution or container GPU access. Real Chromium login, comparison values, six-call export, and desktop/tablet/mobile comparison rendering are checked against the built frontend. Second-user rejection, queued cancellation, complete MongoDB/Redis/API/worker restart, and uncertain in-flight crash interruption also pass.

A separate local Ollama-protocol fault fixture uses the same compiled API, production worker, MongoDB, and Redis. It verifies six exact 16-KiB UTF-8 responses, rejection of one additional character without persisting overflowing output, the unmodified 180-second timeout, provider-connection closure on cancellation, two-worker serialization, and retention/admission boundaries. Terminal records are seeded only to establish the 99-record precondition; admission, rejection, pagination, deletion, and readmission use authenticated APIs. The six-call/per-call bounds make the maximum valid run output 96 KiB, so the 128-KiB total bound is defensive and cannot independently be reached through valid calls.

Both harness modes create only nonce-owned disposable datastores/networks and verify cleanup plus preservation of existing volume identities. See [evidence and limitations](../output/verification/benchmark-host-live.md).

```bash
npm run build:backend
npm run verify:benchmark-host
npm run verify:benchmark-contract

# Optional browser path: build the frontend and point to an already installed Playwright module.
npm run build:frontend
KFIVE_PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
  node scripts/verify-benchmark-host-live.cjs --allow-live-test --browser
```

The browser check uses installed Chrome and local disposable accounts. It does not install browser dependencies, use production credentials, or weaken authentication. Its screenshots have no visual baseline; they are interaction evidence rather than a visual-regression or accessibility certification.

Isolated model training, dataset-to-training lineage, ML metrics/artifacts, recommendations, and a general shared GPU queue spanning AI features remain **Planned**. Notebook execution is a separate Experimental queue/worker and does not share this benchmark lease.
