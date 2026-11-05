# Bounded subsystem and GPU telemetry live evidence

Date: 2026-09-30  
State: **Experimental**

## Agent work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
|---|---|---|---|---|
| Primary agent | Backend exporter, route-label confidentiality fix, Grafana panels, live verifier, docs | Honest MongoDB/Redis state; cached bounded GPU samples; no sensitive/cardinality labels; CPU-only state omits device measurements; real Prometheus/Grafana/browser path | Unit/manifest tests, disposable kind, browser screenshot | Focused tests/build/render, live restart acceptance, security review, `git diff --check` |
| Design audit agent | Read-only topology review | Identify highest-value subsystem follow-up and avoid false GPU claim | Recommended a later tokenless Blackbox Exporter slice for independent MongoDB/Redis/Chroma reachability | No edits; recommendation retained as Planned work |
| Security audit agent | Read-only exporter/exposure review | Find data leakage, cardinality, scrape-path, and unavailable-state risks | Found raw request-path confidentiality defect; required fixed route templates, cached single-flight probing, fixed labels, bounded indices, no fabricated device data | High finding fixed and regression-tested |
| Test audit agent | Read-only layered acceptance design | RED/GREEN contracts plus no-GPU live proof without physical-GPU overclaim | Defined injected present/unavailable tests, panel contracts, private scrape queries, and explicit hardware boundary | Baseline and focused verification reviewed |
| Final review agent | Read-only code/manifest/evidence audit | Find correctness gaps before merge gate | Found API-version loss, numeric overflow, and incomplete cache test; found no additional manifest/verifier/documentation gap | All three findings fixed under RED/GREEN contracts |

## TDD record

The first focused backend test failed at TypeScript compilation because `createMetrics` accepted no dependency/GPU injection and emitted no requested series. After implementation, these contracts passed:

- explicit MongoDB and Redis availability with exactly two fixed dependency labels;
- explicit GPU probe availability/device count and a fixed unavailable reason;
- aggregate and per-index VRAM, utilization, and temperature for a valid injected sample;
- no GPU name, UUID, driver, raw message, error, URL, user/project/run data, or credential in exposition;
- invalid indices/ranges and rejected probes fail closed while `/metrics` remains 200;
- concurrent scrapes share one probe and later scrapes use a 15-second cache;
- a deferred probe proves actual overlap/single-flight, an injected clock proves refresh after expiry, and supported numeric API versions retain allowlisted route templates;
- extreme finite VRAM inputs fail closed before byte conversion can emit `Infinity`;
- unavailable probes omit per-device series rather than publishing false zero measurements.

The security audit exposed a separate failing contract: a secret-like unmatched path appeared in error logs and could previously become a Prometheus label. The regression now proves:

- all 404s use `/not-found`;
- matched routes use source-controlled route templates under exact static mount allowlists;
- unsupported route shapes use `/unknown`;
- raw path/query/authorization canaries are absent from HTTP metrics and ordinary request/error log calls.

The Grafana contract was added red before implementation and then passed with exact panels/queries:

- **Subsystem availability** — `kfive_dependency_available`;
- **GPU probe availability** — `max(kfive_gpu_probe_available) or vector(0)`;
- **GPU VRAM utilization** — available-device ratio only, without a fabricated fallback;
- **GPU temperature** — available per-index samples only.

## Disposable-kind result

A fresh backend image and fresh `kind-kfive` observability cluster were built. `npm run kind:verify:observability` exited 0:

```json
{
  "backendMetrics": "passed",
  "externalMetricsPrivate": "passed",
  "prometheusTarget": "up",
  "subsystemAvailability": {
    "mongodb": 1,
    "redis": 1
  },
  "gpuProbe": {
    "available": 0,
    "devices": 0,
    "reason": "nvidia-smi-not-found",
    "perDeviceSeries": 0
  },
  "grafanaHealth": "passed",
  "datasource": "kfive-prometheus",
  "dashboard": "kfive-overview",
  "prometheusRestartHistoricalSample": {
    "timestamp": 1790718769.631,
    "value": "5"
  },
  "grafanaRestartProvisioning": "passed",
  "grafanaRestartPersistentMarker": "passed"
}
```

The verifier queried metrics internally and through Grafana's Prometheus datasource proxy, confirmed that public `/metrics` still resolves to frontend HTML, restarted Prometheus and retained the exact historical sample, restarted Grafana and retained both provisioning and a non-provisioned PVC marker, then rechecked the target and telemetry.

## Browser QA

A real isolated headless Chrome session used a browser-only `kfive.local → 127.0.0.1` resolver rule and rendered the loopback-only Grafana route. The dashboard visibly showed:

- MongoDB: **Available**;
- Redis: **Available**;
- GPU probe: **Unavailable**;
- GPU VRAM utilization: **No data**;
- GPU temperature: **No data**.

All Prometheus and Loki datasource POSTs returned 200 over multiple refreshes. The sole console error was the already documented anonymous Viewer request to `/grafana/api/user/stars` returning 401. The screenshot is [subsystem-gpu-dashboard-live-2026-09-30.png](../playwright/subsystem-gpu-dashboard-live-2026-09-30.png). There is no visual-regression baseline, so pixel-regression comparison is inconclusive; functional rendering and network acceptance passed.

## Acceptance boundary

The backend process in kind intentionally has no GPU device mapping and no `nvidia-smi`; the host's hardware state is irrelevant to this proof. Available GPU serialization is covered by injected tests, while the live path proves honest unavailability. This is not physical GPU, container runtime, DCGM, device-plugin, VRAM/utilization/temperature-under-load, scheduling, or multi-GPU production acceptance.

MongoDB/Redis metrics describe the backend process's current connections. They are not independent network probes and disappear if the backend target disappears. Independent MongoDB/Redis/Chroma reachability, queue depth/latency, worker/provider activity, datastore performance, alerts, and remote topology remain Planned. The design audit's tokenless Blackbox Exporter proposal is the next independent subsystem-reachability candidate.

Prometheus and Grafana remain private ClusterIP services, but they are unauthenticated inside the cluster and Grafana has anonymous Viewer access. Until NetworkPolicies and tenant isolation exist, every emitted metric must remain non-sensitive aggregate telemetry.

Superseding note (2026-10-24): default-deny local-kind policies now restrict Prometheus/Grafana to the declared scrape and datasource graph. The services remain unauthenticated, Grafana remains anonymous Viewer-only, selectors are label-based, and tenant isolation plus remote/multi-node CNI acceptance remain unverified. See [network-policies-live.md](network-policies-live.md).

## Final regression and lifecycle gate

After the independent review fixes, the complete backend suite passed: **76 suites / 517 tests**. The focused metrics/application regression passed 10 tests, the backend TypeScript build passed, and the then-current manifest/render/syntax/diff gates passed. The later Alertmanager slice expanded the final counts to **5 socket + 5 core + 9 observability + 2 Datadog + 1 GitOps** contracts.

The final Loki regression also passed after the route-confidentiality change. It retained pre-restart history, delivered a marker buffered during a Loki outage, resumed after collector replacement, preserved the Loki PVC identity, parsed structured JSON, exposed only `container`, `job`, and `namespace` stream labels, and found neither the authorization nor query canary after later backend and Traefik ingestion watermarks.

The first teardown attempt safely refused an anomalous empty `/tmp/kfive-kind-ollama` directory with Docker overflow ownership left by an earlier manual recovery. Read-only inspection proved it had no contents, no bridge container, and was the exact read-only bind source of the disposable `kfive-control-plane`. The node was then deleted, only that exact empty orphan was removed, and the path was confirmed absent. No kind cluster remains. The existing Compose project was restored from its named volumes; backend, frontend, MongoDB, Redis, and ChromaDB are healthy and the benchmark worker is running. All six named KFive volumes remain present. No persistent volume or user data was deleted.
