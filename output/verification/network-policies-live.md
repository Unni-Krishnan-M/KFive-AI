# Local-kind NetworkPolicy verification

Date: 2026-10-24  
State: **Experimental**

## Work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
|---|---|---|---|---|
| Primary agent | Core and observability policy graph | Default-deny ingress/egress; only declared service flows; no new public service | Rendered manifests plus live allowed/denied matrix | Static contracts, API dry-run, live kind regression |
| Security reviewer | Boundary and cleanup audit | No unintended datastore/telemetry exposure; explicit limitations | Independent read-only findings incorporated below | Critical/high findings fixed before acceptance |
| Verifier reviewer | Harness integrity | Transport failures cannot count as denials; temporary resources are removed | Sentinel probes, canary heartbeats, post-cleanup absence assertions | Full live rerun after review fixes |
| Documentation reviewer | State/evidence consistency | Experimental scope and remaining gaps are explicit | `STATUS.md`, `ROADMAP.md`, security and operator docs | Documentation agrees with live proof |

## Implemented boundary

`k8s/base` and `k8s/observability` now default-deny ingress and egress. Explicit policies allow the loopback edge to frontend/backend/Grafana, frontend to backend, backend to MongoDB/Redis/ChromaDB, Prometheus to backend/prober/Alertmanager, the fixed prober to its three targets, Grafana to Prometheus/Loki, and Fluent Bit to Loki. MongoDB, Redis, ChromaDB, Prometheus, Loki, Alertmanager, and the Datadog verification receiver remain ClusterIP-only.

DNS egress is restricted to UDP/TCP 53 for CoreDNS by namespace/pod selector plus the exact `10.96.0.10/32` Service address. The kind profile pins `serviceSubnet: 10.96.0.0/16` so that address is deterministic. Fluent Bit repeats the same narrow DNS edge because kindnet's local multi-policy path otherwise blocked its output resolver.

The separate Datadog overlay adds only the collector's DNS, private test-receiver TCP/8080, and TCP/443 egress. Kubernetes NetworkPolicy cannot allowlist a DNS name, so enabling this opt-in overlay permits Fluent Bit to reach any destination on TCP/443. Production requires an FQDN-aware CNI rule or controlled egress proxy.

## Test-first chronology and review fixes

- Static contracts initially failed because the policy resources and live verifier were absent; implementation made the core 6/6, observability 11/11, Datadog 2/2, and GitOps 6/6 suites pass.
- The Datadog live verifier initially exposed Fluent Bit async-resolver failures under kindnet. A failing contract required `net.dns.resolver LEGACY` and IPv4 preference for this output; the private receiver then accepted correlated delivery.
- Default deny exposed the alert harness's missing ingress edge. Its exact temporary receiver policy was added and the firing/resolved lifecycle passed.
- Independent review found that the alert verifier deleted its Secret while leaving the patched mount in the Deployment. A failing cleanup contract was added; cleanup now explicitly deletes the mount/volume, waits for rollout, and asserts their absence. The full alert lifecycle passed again.
- Independent review also found that any `kubectl exec` error could count as a denied connection. The verifier now requires an explicit remote `KFive_PROBE_DENIED` sentinel, treats exec/transport errors as failures, checks a live canary heartbeat after every denial pass, preserves cleanup errors, and asserts all canaries are absent.
- Datadog verification now requires one request that simultaneously has the exact `/api/v2/logs` path, ephemeral credential, gzip encoding, and marker. Cleanup asserts all five temporary resources are absent, no `DD_*` environment remains, and the optional output is back to the Loki-only baseline.

## Live acceptance

`npm run kind:verify:network-policies` passed on kindnet:

- default deny was active in `kfive` and `kfive-observability`;
- three healthy canaries (application namespace, observability namespace, and a foreign namespace) were denied access to nine targets: MongoDB 27017, Redis 6379, ChromaDB 8000, backend 5000, frontend 8080, Prometheus 9090, Loki 3100, Grafana 3000, and Alertmanager 9093;
- every denial was repeated three times with a heartbeat after each pass;
- declared edge routes, backend datastore flows, Prometheus backend/prober/Alertmanager flows, Traefik-to-Grafana, and Grafana-to-Prometheus/Loki remained functional;
- application health and independent subsystem probes remained healthy;
- all canaries were removed, and the application Secret UID plus all application/observability PVC UIDs were unchanged.

Post-review live regressions also passed:

- `npm run kind:verify:datadog`: marker `datadog-live-1792822549623`, seven deliveries, one correlated authenticated gzip `/api/v2/logs` request, same-marker Loki search, private receiver, and asserted restoration;
- `npm run kind:verify:logs`: Loki restart persistence, sink-outage recovery, collector replacement recovery, structured parsing, fixed labels, redaction watermarks, and tag-derived metadata without a Kubernetes API token or RBAC;
- `npm run kind:verify:alerts`: fingerprint-correlated firing/resolved delivery across an Alertmanager outage, exact baseline restoration, temporary policy/receiver/Secret removal, unchanged PVC UID, and healthy backend recovery.
- `npm run kind:verify`: frontend, readiness, Socket.IO, provider models, real chat streaming, bridge restart, and Mongo/backend restart persistence passed. The first final run honestly failed because a Docker-daemon restart had stopped the owned bridge and recreated its empty bind source. After exact label/mount/empty-state validation, the UID-1000/mode-0700 identity and hardened bridge were restored; the rerun passed with disposable user `6adc9217846d3ed9df936023`.

Core, observability, Datadog, and GitOps static suites passed. Client-side and API-server dry-run validation passed for `k8s/base`, `k8s/observability`, and `k8s/observability-datadog`.

## Acceptance boundary

This proves the declared graph only on a disposable, single-node kind cluster using kindnet. It is not a production, remote, multi-node, or tenant-isolation claim. Policy selectors are label-based; a principal allowed to create or relabel pods in these namespaces can impersonate an allowed workload. The Traefik port is intentionally reachable by cluster pods and loopback host traffic, so policies protect private service ports rather than hiding the edge. Anonymous local Grafana and unauthenticated internal telemetry remain single-user development choices.

No real Datadog endpoint was contacted. External SaaS delivery, FQDN-constrained egress, remote CNI behavior, production ingress/TLS, controller isolation, portable storage, and backup/restore remain unverified. The next Phase 15 vertical slice is backup/restore.

## Final cleanup and preserved development state

All network-policy canaries, the foreign namespace, Datadog receiver/Secret/policies, and alert receiver/Secret/policy were absent before teardown. Alertmanager's live pod template contained only its baseline config/data/tmp volumes. `npm run kind:down` removed the owned bridge and disposable node; `kind get clusters` reported no clusters and `/tmp/kfive-kind-ollama` was absent.

The Docker daemon restart had also stopped the existing Compose project. The exact existing containers were restarted without recreation or `down -v`; backend and frontend-proxied health returned `status: healthy`, and all six named volumes remained present. Docker still reports exec-based container healthchecks as unhealthy on this host because of the already documented AppArmor profile-application defect; the optional notebook worker also continues to fail its isolation preload for that host limitation. No Compose volume or user data was deleted.
