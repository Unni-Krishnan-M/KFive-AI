# Optional Datadog forwarding live evidence

Date: 2026-09-30  
State: **Experimental**

## Slice and work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
|---|---|---|---|---|
| Primary agent | Opt-in manifests, safe lifecycle, private live verifier, docs | Default remains Loki-only; API key stays external to Git; optional sink uses gzip/auth and retains Loki; existing verification resources are never replaced; cleanup restores default | Static contracts, refusal sentinel, private receiver, Loki query, rendered manifests | Focused tests, syntax, Kustomize renders, live regression, `git diff --check` |
| Read-only review agents | Design, security, testing review | Independent review with no overlapping writes | Unavailable: workspace agent credits were exhausted before this slice | Primary-agent review recorded; no independent-review claim |

## TDD contract

The first focused run failed because `k8s/observability-datadog` and the `--with-datadog` lifecycle did not exist. After implementation, the two focused contracts passed:

```text
✔ keeps Datadog forwarding opt-in and its API key external to Git
✔ creates the opt-in key from private file input and has a private live verifier
tests 2; pass 2; fail 0
```

A later safety assertion was deliberately added red. It required the live verifier to contain an explicit refusal path before it could create or delete any harness resources. After the guard was implemented, the same 2/2 suite passed again.

Static coverage verifies that:

- the ordinary `k8s/observability` render contains an empty optional-output include, Loki output, and no Datadog key dependency;
- `k8s/observability-datadog` keeps Loki and adds the Datadog output with TLS, gzip, bounded retries/storage, and a `kfive-datadog` Secret reference;
- no Secret manifest or key value is committed;
- `--with-datadog` validates the private `.env` value and creates the Secret from file input before applying the optional overlay;
- the verifier uses a private ClusterIP receiver and refuses any pre-existing Secret, Service, or Deployment with its harness names.

The output follows the Fluent Bit Datadog plugin fields documented in the [official Fluent Bit manual](https://docs.fluentbit.io/manual/4.2/data-pipeline/outputs/datadog) and the TLS/API-key/gzip guidance in [Datadog's official Fluent Bit guide](https://docs.datadoghq.com/logs/guide/fluentbit/).

## Pre-existing resource refusal

A fake sentinel Secret was created only for the guard test. Its UID before the verifier was:

```text
4feb5f35-25b7-492c-a0c7-624ccc29c59b
```

`npm run kind:verify:datadog` exited nonzero before applying anything:

```text
Error: Refusing to replace pre-existing Datadog verification resource: secret/kfive-datadog
```

The Secret UID after refusal was still `4feb5f35-25b7-492c-a0c7-624ccc29c59b`. The test sentinel was then deleted explicitly. No real credential was used or printed.

## Disposable-kind live result

With all harness targets absent, `npm run kind:verify:datadog` exited 0:

```json
{
  "marker": "datadog-live-1790717509639",
  "deliveries": 4,
  "credentialAccepted": true,
  "gzip": true,
  "requestPaths": [
    "/api/v2/logs"
  ],
  "lokiDualDelivery": true,
  "receiverExposure": "ClusterIP only",
  "collectorRestoredToDefault": true,
  "externalDatadogContacted": false
}
```

The verifier generated an ephemeral random key in memory, injected it through the same Secret reference used by the real overlay, and never printed it. A tokenless, non-root, read-only receiver accepted only the private cluster path. Fluent Bit delivered an authenticated gzip request to `/api/v2/logs`, while the exact structured request marker was searchable through the existing Grafana-to-Loki datasource path. The Fluent Bit service account remained unable to read the Secret through the Kubernetes API.

Cleanup ran in `finally`: it reapplied the ordinary observability overlay, restarted and waited for Fluent Bit, then deleted the receiver Deployment, Service, and test Secret. The default optional-output ConfigMap was empty again and the DaemonSet had no Datadog environment entries.

The original full default logging regression then passed with marker search, unchanged Loki PVC identity across restart, bounded sink-outage recovery, collector replacement recovery, exact low-cardinality labels, sensitive-value canaries, and the namespace-scoped RBAC used at that time. Its post-change markers were `loki-before-1790717778848`, `loki-outage-1790717801993`, and `loki-after-collector-1790717837924`. The 2026-10-24 addendum below supersedes that collector design with tokenless tag-derived metadata.

## Focused merge gate

- `npm run test:kubernetes`: 4 socket lifecycle + 5 core Kubernetes + 7 observability + 2 Datadog contracts passed.
- `npm run test:observability`: 7 observability + 2 Datadog contracts passed.
- `npm run test:gitops`: passed.
- Bash syntax and Datadog verifier Node syntax passed.
- Base, ordinary observability, and Datadog Kustomize renders passed.
- `npm run kind:verify:datadog`: passed after the intentional refusal test.
- `npm run kind:verify:logs`: passed after restoration to the ordinary profile.
- Socket lifecycle regression: 5/5 passed after the normal-order and Docker-restart recovery fixes.
- Final cleanup and `git diff --check`: passed.

## Acceptance boundary

No packet was sent to Datadog, no real API key or tenant was available, and no external TLS handshake was exercised. This therefore proves the local collector configuration and dual-sink behavior, not Datadog account acceptance, regional routing, quotas, retention, billing, residency, privacy/legal review, or production delivery. The real opt-in endpoint is rendered with TLS and gzip, but external acceptance remains Planned.

The first teardown found the protected socket directory transformed into an empty overflow-owned view and correctly refused it. A new test failed on the unsafe ordering; `kfive-kind-down.sh` now performs normal cleanup before node deletion. Later live testing established the recurring cause as a Docker-daemon restart: in the host namespace Docker recreates the still-mounted path as an empty root-owned mode-0755 directory. The bounded recovery path now requires that exact empty state, the owned kind node, and its exact read-only bind before deleting the node and removing only the orphan with an isolated container. Every other state still aborts.

The disposable cluster and owned bridge are absent. The repository's Docker Compose stack was restored and is healthy; its named MongoDB, Redis, ChromaDB, uploads, logs, and bridge-socket volumes remain present. No Compose volume or user data was deleted.

## 2026-10-24 NetworkPolicy and cleanup addendum

Default-deny policy exposed that Fluent Bit's async resolver could not resolve the private receiver through kindnet. A deliberately failing contract required the optional output to use `net.dns.resolver LEGACY` with IPv4 preference. The rerun then passed with marker `datadog-live-1792822549623` and seven deliveries. The hardened receiver records per-request facts, and the verifier required one request to simultaneously contain the marker, exact ephemeral credential, gzip encoding, and `/api/v2/logs` path; the same marker was searchable in Loki.

The current collector has no Kubernetes API token or RBAC. Cleanup now removes the receiver Deployment, Service, Secret, and both exact temporary NetworkPolicies, then asserts no `DD_*` environment remains and the optional-output ConfigMap is back to the Loki-only baseline. Standard NetworkPolicy cannot allowlist the Datadog hostname, so the opt-in profile permits collector TCP/443 to any destination; this is an explicit Experimental egress limitation, not production destination isolation. See [the NetworkPolicy record](network-policies-live.md).
