# Restart-persistent searchable local logging — 2026-09-28

State: **Experimental**. This record proves bounded search, pod-restart persistence, and short sink-outage recovery in a disposable single-node local-kind profile. It does not prove production durability.

## Implemented boundary

- Loki `3.7.8` runs as one private, tokenless, non-root, read-only-root Deployment with dropped capabilities, RuntimeDefault seccomp, probes, CPU/RAM Kubernetes resource bounds, and no Ingress, NodePort, host port, or Traefik route.
- The host image resolved to `grafana/loki@sha256:1107dd5274e0ada47e42472b7a7e71f3b2a2fe878878108f3e2f9e51528f0193`; the live kind container image ID ended in `sha256:d4c372aa4d66c81e2dd6ad5784e6706001833e4d5707ec9c5bd3dd5bb5b1094c` after the platform-specific import.
- TSDB v13 and filesystem storage use the protected `loki-data` 2 GiB RWO claim. The compactor has 24-hour retention enabled with filesystem delete-request storage. Ingestion rate/burst, per-stream rate, line size, query range/lookback/parallelism, and returned entries are bounded. Analytics and automatic service/log-level discovery are disabled.
- In the original 2026-09-28 run, Fluent Bit `5.1.2` sent only `kfive` namespace records to Loki through a pod-only Role confined to `kfive`, with Secret and observability-pod access denied. Indexed stream labels were exactly `container`, `job`, and `namespace`; structured application/Kubernetes data remained JSON line content. The superseding 2026-10-24 regression below removed this Role entirely.
- Grafana `13.2.2` provisions Loki as non-default read-only datasource `kfive-loki`. The **KFive application logs** panel requests at most 100 backend lines and refreshes every 10 seconds. Grafana has a 192 MiB request and 768 MiB limit for this profile.

## Test-first chronology

The initial manifest contracts failed because Loki, its PVC, datasource, Fluent Bit output, and lifecycle preload/rollout were absent. After implementation, observability contracts passed 5/5. The final audit added a sixth contract for ingestion-watermark ordering and aligned Fluent Bit's accepted line size with Loki's 64 KiB limit; the final suite passed 6/6.

Live verification then exposed three defects that static rendering did not:

1. Loki 3.7 added `detected_level` automatically, violating the fixed-label contract. A failing contract now requires `discover_log_levels: false` and `discover_service_name: []`.
2. The sensitive-data canary found Traefik's raw `RequestPath` included `?token=...`. A failing Kubernetes contract now requires `--accesslog.fields.names.RequestPath=drop`; backend request logs retain the normalized path.
3. A 1,000-line logs query refreshed every five seconds OOM-killed Grafana at 512 MiB. Contracts now require a 100-line backend query, a 10-second refresh, and explicit 192/768 MiB Grafana request/limit. The final sustained browser run had zero restarts.

## Clean-cluster live acceptance

Commands:

```bash
npm run kind:up:observability
npm run kind:verify:logs
npm run kind:verify:observability
npm run kind:verify
```

Logging verifier result:

The watermark-strengthened gate below was rerun successfully on 2026-09-29 before disposable-cluster teardown.

```json
{
  "image": "grafana/loki:3.7.8",
  "imageId": "docker.io/library/import-2026-09-28@sha256:d4c372aa4d66c81e2dd6ad5784e6706001833e4d5707ec9c5bd3dd5bb5b1094c",
  "serviceExposure": "ClusterIP only",
  "grafanaDatasource": "kfive-loki",
  "firstMarker": "loki-before-1790620844161",
  "lokiRestartPersistence": true,
  "pvcUidUnchanged": true,
  "bufferedSinkOutageMarker": "loki-outage-1790620866976",
  "collectorRestartMarker": "loki-after-collector-1790620892907",
  "structuredJson": true,
  "boundedLabels": ["container", "job", "namespace"],
  "sensitiveHeaderAndQueryMarkerAbsent": true,
  "redactionIngestionWatermarks": ["backend", "traefik"],
  "rbac": "namespace-scoped"
}
```

The verifier queried through Grafana's datasource proxy rather than exposing Loki. Before asserting that the authorization/query canary was absent, it required later unique backend and Traefik records to be searchable, proving both relevant log files had advanced past the sensitive request. It found an exact structured backend marker, restarted Loki, required a new pod UID and unchanged PVC UID, and found the historical marker again. It then scaled Loki to zero, emitted another marker while Fluent Bit stayed up, restored Loki, and found the buffered marker. After replacing Fluent Bit, a third marker arrived and the original historical marker remained searchable. Traefik public `/loki/...` resolved to frontend HTML rather than the Loki API.

The existing metrics gate passed backend metric privacy, Prometheus target health, identical historical data after Prometheus restart, and Grafana datasource/dashboard plus non-provisioned PVC-marker persistence after Grafana restart. The final authenticated core gate passed frontend, readiness, Socket.IO, model discovery, real Phi3 streaming, bridge restart, and Mongo/backend restart persistence; its disposable user id was `6aba813e7337ebb1aec57689` and the verifier removed its fixture.

## Browser acceptance

A real headless Google Chrome session used a browser-only resolver mapping for `kfive.local`. It rendered **Backend request rate**, **Backend resident memory**, and **KFive application logs**. The log panel displayed current structured backend records after more than four 10-second refresh cycles. The final Grafana pod restart count stayed zero. The only console error was the known anonymous Viewer request to `/grafana/api/user/stars` returning 401; there were no final datasource or panel errors.

Screenshot: [bounded live logs panel](../playwright/loki-dashboard-live-2026-09-28.png).

There is no committed visual baseline, so visual-regression comparison is inconclusive; functional rendering is verified.

## Focused merge gate

- Observability manifests: 6/6.
- Kubernetes manifests: 5/5; socket lifecycle: 3/3.
- GitOps contracts: 6/6.
- Base and observability Kustomize renders: passed.
- Bash/Node syntax and `git diff --check`: passed.
- Clean live logging, metrics persistence, authenticated core, and browser paths: passed.

After the final 2026-09-29 watermark-strengthened rerun, `npm run kind:down` removed the disposable cluster and its helper paths/containers. No kind clusters remained. The existing Compose volumes (`kfive-ai_backend_logs`, `kfive-ai_backend_uploads`, `kfive-ai_chromadb_data`, `kfive-ai_mongodb_data`, `kfive-ai_ollama_bridge_socket`, and `kfive-ai_redis_data`) remained present and were not modified or deleted.

## Limits

The filesystem store is single-replica and tied to a local-path PVC. Kind deletion, node/PV loss, disk exhaustion, backup/restore, remote object storage, multi-replica operation, and disaster recovery were not tested. Retention deletion is asynchronous and is not secure erasure; the 2 GiB claim is a capacity boundary, not a usage-aware eviction policy. Loki has no tenant authentication, and anonymous loopback Grafana Viewers can read every retained `kfive` log. NetworkPolicies, TLS, authenticated remote access, comprehensive redaction, tenant separation, Datadog, alerting, broader metrics, and remote-cluster acceptance remain Planned.

## 2026-10-24 superseding regression

The collector no longer uses the pod-only Role described in the original run. It now uses `Use_Tag_For_Meta On`, disables Kubernetes labels/annotations, derives bounded identity from the log tag, uses the default ServiceAccount with `automountServiceAccountToken: false`, and has no Role or RoleBinding. Under the new default-deny policies, `npm run kind:verify:logs` passed again with markers `loki-before-1792821731797`, `loki-outage-1792821754139`, and `loki-after-collector-1792821780470`; Loki restart persistence, unchanged PVC UID, sink-outage recovery, collector replacement recovery, structured JSON, fixed labels, and redaction watermarks all passed. The verifier reported `kubernetesMetadata: "tag-derived; no API token or RBAC"`.

Local-kind NetworkPolicies are therefore no longer a missing item for this profile; their separate kindnet evidence is in [network-policies-live.md](network-policies-live.md). TLS, authenticated tenant isolation, remote/multi-node CNI acceptance, backup/restore, and production durability remain unverified.
