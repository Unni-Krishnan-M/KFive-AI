# Local kind observability verification — 2026-09-23

State: **Experimental** bounded slice; not full Phase 13 completion.

## Executed results

- Backend metrics regression: `backend/src/app.test.ts` passed 5/5; backend production build passed.
- Rendered manifest regressions: observability 4/4 and Kubernetes 5/5 passed.
- `./scripts/kfive-kind-up.sh --with-observability` exited 0 with Prometheus and Grafana rollouts ready.
- `scripts/verify-observability-live.cjs --allow-live-test` passed after the full lifecycle run:
  - backend `/metrics` returned bounded Prometheus HTTP/process metrics inside the cluster;
  - public `/metrics` returned frontend HTML and did not expose Prometheus text;
  - `up{job="kfive-backend"}` was `1`;
  - Grafana health, datasource `kfive-prometheus`, and dashboard `kfive-overview` passed;
  - Prometheus restart preserved the exact historical sample `10` at timestamp `1790178618.283`;
  - Grafana restart preserved a non-provisioned marker on `grafana-data`, then reprovisioned datasource/dashboard queries passed;
  - both persistent claims were Bound and the running deployments used the pinned Prometheus `v3.14.0` and Grafana `13.2.2` specifications.
- Real Chromium navigation through Traefik loaded `KFive Overview - KFive - Dashboards - Grafana`. It rendered **Backend request rate** and **Backend resident memory**, found zero `No data` panels, and both `/api/ds/query` requests returned HTTP 200. Anonymous Grafana also emitted an expected 401 for the optional user-star endpoint; it did not prevent dashboard rendering or data queries.
- Fluent Bit `5.1.2` live verification passed with namespace-scoped pod-only RBAC. It could not read Secrets or observability-namespace pods, had no Service, parsed the backend marker `fluent-bit-before-1790194863012` under `structured`, attached `kfive` pod/container/label metadata, correlated the Traefik request path, excluded its own namespace, and collected `fluent-bit-after-1790194867460` after its pod was replaced.

## Security and scope

Prometheus remains private. Grafana is exposed only on the loopback kind NodePort and anonymous access is Viewer-only; basic authentication, signup, plugin administration, plugin auto-update, and update reporting are disabled. Containers run non-root with read-only roots, dropped capabilities, resource limits, probes, and no service-account token.

Only backend HTTP/process metrics, one two-panel dashboard, and local stdout log processing are present. Fluent Bit's read-only host log mounts remain a collector trust boundary and its ephemeral state/stdout output are not durable searchable storage. There is no NetworkPolicy, Datadog output, GPU or broader subsystem metric coverage, alerting, TLS, remote-cluster proof, or Argo CD verification.

## Superseded scope note — 2026-10-24

The statements above accurately describe the original 2026-09-23 run. Later slices added Loki, alerting, broader subsystem/GPU metrics, optional Datadog forwarding, Argo CD, and default-deny local-kind NetworkPolicies. Fluent Bit is now tag-derived and tokenless with no Role/RoleBinding. Current policy evidence is in [network-policies-live.md](network-policies-live.md); TLS and remote-cluster proof remain absent.
