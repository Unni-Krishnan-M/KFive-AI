# Private Alertmanager notification delivery — 2026-09-30

State: **Experimental**. This proves local Alertmanager outage recovery and authenticated firing/resolved webhook delivery to a transient private receiver. It is not production paging or on-call acceptance.

## Agent work board

| Owner | Scope | Acceptance criteria | Evidence | Merge gate |
|---|---|---|---|---|
| Primary agent | Manifests, lifecycle, verifier, docs | Private null-routed baseline; exact Prometheus target; authenticated correlated firing/resolved delivery; unconditional restoration | Static contracts and disposable-kind output below | Focused tests, restart gate, security review, render/syntax/diff checks |
| Design audit agent | Read-only topology review | Smallest useful notification slice without accidental egress | Recommended pinned private Alertmanager plus authenticated transient harness | Implemented; no files edited by agent |
| Security audit agent | Read-only threat review | Bound exposure, credentials, SSRF, RBAC, payloads, retention, and cleanup | Required null baseline, exact internal target, Secret-backed bearer file, no tokens/RBAC/routes, bounded state | Controls implemented; NetworkPolicy/real receiver remain explicit gaps |
| Test audit agent | Read-only acceptance review | Prove baseline/refusal, active target, fire/resolved correlation, recovery, cleanup, PVC identity | Defined static builders and live lifecycle assertions | Contracts implemented and live-verified |

## TDD and implementation

The ninth observability contract first failed because Prometheus had no `alerting.alertmanagers` configuration. It now proves:

- Prometheus targets exactly `alertmanager:9093`;
- Alertmanager 0.29.0 is ClusterIP-only with no Traefik/Ingress route, gossip listener, API token, or RBAC;
- non-root/read-only/seccomp/capability/resource/probe controls, 24-hour retention, and a protected 512 MiB claim;
- a Secret-free committed configuration with bounded grouping and a quoted null receiver;
- exact image preload and rollout lifecycle;
- pure transient-config/resource builders with one fixed alert matcher, exact cluster-local webhook URL, `send_resolved: true`, `max_alerts: 1`, bearer credential file, bounded hardened receiver, and cleanup assertions.

The transient receiver retains at most 20 reduced event summaries and four alerts per payload, rejects bodies over 64 KiB, never stores the authorization header or full alert body, and requires its random bearer credential for POST and inspection. The credential exists only in a transient Secret and is never printed.

## Live acceptance

A fresh `kind-kfive` observability cluster loaded the pinned image and all workloads became Ready. The first complete run proved delivery but showed that the test route's five-minute group interval delayed the resolved notification exactly five minutes. The committed baseline remained unchanged; the transient-only interval was reduced to five seconds and the final post-restart run returned:

```json
{
  "rule": "KFiveBackendUnavailable",
  "alertmanager": "active/private",
  "receiverAuthentication": "bearer-file",
  "firingObservedAt": "2026-09-30T04:50:50.863Z",
  "resolvedObservedAt": "2026-09-30T04:51:06.260Z",
  "correlatedFingerprint": true,
  "outageRecovery": true,
  "sendResolved": true,
  "baselineRestored": true,
  "receiverRemoved": true,
  "pvcUidUnchanged": true,
  "backendRestored": true,
  "prometheusExposure": "ClusterIP only",
  "alertmanagerExposure": "ClusterIP only"
}
```

The verifier required the exact rendered null baseline, one backend replica, no pre-existing harness resource, inactive rule, `up=1`, active Alertmanager target, private services, and public Alertmanager-path denial. It installed the receiver, mounted the token file, held Alertmanager at zero replicas, scaled the backend to zero, and observed the rule firing. After Alertmanager returned it received the authenticated firing event. After backend recovery it received the resolved event with the same fingerprint and a real end time.

Cleanup reapplied the exact repository overlay, restarted Alertmanager, removed the transient Secret/ConfigMap/Service/Deployment, and rechecked baseline hash, PVC UID, active target, inactive rule, absent alert series, and application health. The Prometheus/Grafana restart-persistence verifier passed between two delivery runs; the second delivery run above passed after those restarts.

## Merge gate and limits

- Observability contracts: **9/9**.
- Backend regression after telemetry review: **76 suites / 517 tests**; backend build passed.
- Prometheus/Grafana restart persistence and final Alertmanager delivery: passed.
- Kubernetes gate: **5 socket + 5 core + 9 observability + 2 Datadog**; GitOps: **1**. Node/Bash syntax, all Kustomize renders, credential canary, backend build, and `git diff --check` passed.

During final teardown, the host Docker daemon restarted and recreated the still-mounted socket source as an empty host-root mode-0755 directory while stopping Compose. The existing guard refused it. A new RED/GREEN contract added a narrowly bounded recovery: only that exact empty state plus the owned node's exact read-only bind is accepted; the disposable node is removed, then an isolated no-network/no-capability container removes only the exact orphan. The live recovery removed the node/path, and the idempotent no-cluster teardown passed. Compose was restored from all six untouched named volumes.

There is no configured external receiver, public Alertmanager endpoint, email/chat/pager credential, TLS receiver acceptance, NetworkPolicy enforcement, escalation, inhibition, authorized silence workflow, tuned production grouping, remote cluster, or on-call proof. ClusterIP is not authentication from other pods. Alertmanager's retained labels/notification state is not secure erasure and has no backup/restore proof. These boundaries keep the slice and Phase 13 Experimental.

Superseding note (2026-10-24): local-kind default-deny policy now restricts Alertmanager ingress to Prometheus and its verifier-only egress to the exact temporary receiver. An independent review also found and fixed a dangling temporary Secret mount; the full firing/resolved lifecycle passed after cleanup began explicitly removing the mount/volume and asserting restoration. This does not add a real receiver, TLS, tenant isolation, remote-CNI proof, or backup/restore. See [network-policies-live.md](network-policies-live.md).
