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

1. Run the standard host-Ollama path after deliberately exposing its listener only to the Docker bridge, and separately exercise an opted-in remote provider.
2. Produce a second successful compatible run and verify browser comparison behavior; compare recorded wall/TTFT values with provider logs.
3. Verify target NVIDIA GPU snapshots without UUID exposure and independently prove whether the selected provider used that GPU.
4. Exercise live timeout/output bounds, browser disconnect/reconnect, and provider-side cancellation behavior.
5. Restart the API and worker during queued, checkpointed, and in-flight work; prove safe redispatch, no duplicate completed call, and interruption rather than retry for uncertain work.
6. Verify a second user cannot list, read, cancel, delete, or export another owner's run.
7. Test the 100-run retention boundary, concurrent start races, multi-replica fencing, worker heartbeat/lease loss, remote-provider billing, and persistence across complete MongoDB/Redis/API/worker restart.

Isolated model training, dataset-to-training lineage, ML metrics/artifacts, recommendations, and a general shared GPU queue spanning AI features remain **Planned**. Notebook execution is a separate Experimental queue/worker and does not share this benchmark lease.
