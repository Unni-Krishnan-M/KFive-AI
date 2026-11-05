# Independent subsystem probes live verification

Date: 2026-09-30  
State: **Experimental**  
Environment: disposable single-node `kind-kfive`, loopback Traefik on `127.0.0.1:8088`

## Agent work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
|---|---|---|---|---|
| Primary | Fixed-target prober, manifests, lifecycle verifier, docs | Three bounded private series; isolated Chroma failure fires; recovery clears; PVC and application recover | Unit/manifest/live/browser results below | All focused/static/live gates pass |
| Design audit | Cardinality, topology, dashboard/rule fit | No generic target surface; one meaning per series; no panel overlap | Independent audit requested; no result became available before final verification | Primary review plus executable contracts |
| Security audit | SSRF, data exposure, pod/service hardening | Fixed destinations only; no raw diagnostics/credentials; ClusterIP; hardened tokenless pod | Independent audit requested; no result became available before final verification | Security contracts and live public-denial check |
| Test audit | Failure isolation, cleanup and recovery | Chroma-only outage; unconditional restore; alert recovery; PVC identity | Independent audit requested; no result became available before final verification | Repeatable live lifecycle and final clean teardown |

## Implemented boundary

- `services/subsystem-prober/server.cjs` uses only built-in Node modules and has three frozen destinations: MongoDB TCP, Redis TCP, and the ChromaDB v1 heartbeat.
- Callers cannot supply a URL, host, port, path, protocol, label, or redirect destination. The only application routes are exact `GET /health` and `GET /metrics`.
- Probes time out after two seconds and collection is cached/single-flight for four seconds. One failed probe does not reject the other results.
- Metrics contain exactly three `kfive_subsystem_probe_success{dependency,probe}` series with fixed labels and binary values. Connection errors, response bodies, addresses, credentials, owners, projects, runs, and user data are not exported.
- The pod has no service-account token or RBAC, runs non-root with a read-only root filesystem, drops all capabilities, uses runtime-default seccomp, and has CPU/memory limits and probes. Its Service is ClusterIP-only.
- Prometheus scrapes the fixed `/metrics` endpoint with no probe parameters. `KFiveSubsystemUnavailable` evaluates failed series for 30 seconds and the dashboard shows their recovered state.

The official Prometheus Blackbox Exporter was considered but not introduced. The current upstream release had unresolved published security-fix concerns on the verification date, and a generic target-driven probe would add unnecessary SSRF and configuration surface for three known services. This local fixed-target implementation is intentionally narrower.

## TDD and static verification

The first unit run failed because `services/subsystem-prober/server.cjs` did not exist. The first manifest contract failed because the `subsystem-prober` Service did not exist. After implementation:

- service unit contract: pass; fixed targets, independent fail-closed collection, and exactly three non-sensitive series
- observability manifest contracts: 10/10 pass
- Node syntax for the live verifier: pass
- observability Kustomize render: pass
- `git diff --check`: pass before live verification

Final aggregate results are recorded after the post-live regression below.

## Disposable-kind lifecycle

The local image was built as `kfive-ai-subsystem-prober:latest`, loaded through `kind:up:observability`, and rolled out with the rest of the opt-in observability profile. The verifier refused execution without `--allow-live-test`, required context `kind-kfive`, a one-replica ChromaDB baseline, and a private prober Service.

The live run:

1. observed MongoDB TCP, Redis TCP, and ChromaDB HTTP at `1`, the prober target up, and the rule inactive;
2. confirmed `/subsystem-prober/metrics` reached frontend HTML rather than the private exporter;
3. scaled only `statefulset/chromadb` to zero;
4. observed `{chromadb: 0, mongodb: 1, redis: 1}` and `KFiveSubsystemUnavailable` firing only for `dependency="chromadb"`;
5. restored ChromaDB in `finally`, waited for rollout, observed all three probes at `1` and the rule inactive with no residual alert series;
6. confirmed the exact ChromaDB PVC UID was unchanged and `/api/v1/health` returned 200.

Result:

```json
{
  "probes": {
    "mongodb": "tcp/available",
    "redis": "tcp/available",
    "chromadb": "http/available"
  },
  "alert": "KFiveSubsystemUnavailable",
  "firingDependency": "chromadb",
  "firingObservedAt": "2026-09-30T10:46:19.940Z",
  "recovered": true,
  "chromaRestored": true,
  "chromaPvcUidUnchanged": true,
  "proberExposure": "ClusterIP only",
  "publicMetricsDenied": true
}
```

## Browser verification

An isolated real Chromium session opened the actual loopback Traefik route at `http://kfive.local:8088/grafana/d/kfive-overview/kfive-overview` with only a browser-scoped host resolver mapping. It rendered:

- **Independent subsystem probes**
- `mongodb` — **Available**
- `redis` — **Available**
- `chromadb` — **Available**
- **Firing alerts** — `0`

All observed Prometheus and Loki datasource POSTs returned 200. The sole console error was Grafana's known optional anonymous-user `/api/user/stars` request returning 401; dashboard, datasource, and panel requests succeeded. Visual inspection found the probe and alert panels readable with no overlap. No prior pixel baseline exists, so pixel-level visual regression is inconclusive.

Screenshot: [subsystem-probes-dashboard-live-2026-09-30.png](../playwright/subsystem-probes-dashboard-live-2026-09-30.png)

## Final regression

- `npm run kind:verify:observability`: pass after adding the prober; Prometheus historical sample, Grafana provisioning, and non-provisioned PVC marker survived restarts.
- `npm run kind:verify:probes`: pass again after those restarts; Chroma-only firing/recovery and PVC identity reconfirmed.
- `npm run test:kubernetes`: pass — socket lifecycle 5/5, core manifests 5/5, subsystem prober file pass, observability manifests 10/10, Datadog manifests 2/2.
- `npm run test:observability`: pass — subsystem prober 3/3, observability manifests 10/10, Datadog manifests 2/2.
- `npm run build:backend`: pass.
- Node syntax for the prober and live verifier: pass.
- base, observability, and Datadog Kustomize renders: pass.
- `git diff --check`: pass.

The disposable cluster was then removed successfully. `kind get clusters` reported no clusters and `/tmp/kfive-kind-ollama` was absent. The existing Compose stack was restarted without orphan removal or volume recreation: backend, frontend, MongoDB, Redis, and ChromaDB reported healthy; the portless benchmark worker reported running. All six named persistent volumes remained present: `backend_logs`, `backend_uploads`, `chromadb_data`, `mongodb_data`, `ollama_bridge_socket`, and `redis_data` (under the `kfive-ai_` Compose prefix).

## Limits

This proves shallow reachability in the disposable local-kind topology. A successful TCP connect is not an authenticated MongoDB/Redis operation, and the Chroma heartbeat is not vector correctness, persistence, latency, or capacity proof. The prober has no NetworkPolicy isolation yet. It does not cover the AI provider, queues, workers, kube-state metrics, deep datastore metrics, remote clusters, TLS, SLOs, or real paging. The feature and overall observability platform therefore remain **Experimental**.

Superseding note (2026-10-24): default-deny local-kind policy now permits the prober only to MongoDB, Redis, and ChromaDB and permits its metrics only to Prometheus. This remains label-based single-node kindnet evidence, not authenticated datastore, tenant-isolation, or remote-CNI proof. See [network-policies-live.md](network-policies-live.md).
