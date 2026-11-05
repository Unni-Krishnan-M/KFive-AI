# Local alert evaluation and dashboard visibility — 2026-09-29

State: **Experimental**. This evidence proves one private local-kind Prometheus rule's load, firing, recovery, and Grafana visibility. It does not prove notification delivery or production incident response.

## Implemented boundary

- Prometheus loads a read-only `prometheus-rules` ConfigMap from `/etc/prometheus/rules`.
- `KFiveBackendUnavailable` evaluates failed and absent `kfive-backend` scrape series, holds for 30 seconds, and exposes fixed `severity=critical` and `component=backend` labels plus non-secret operator annotations.
- Grafana's provisioned dashboard has a stat panel scoped exactly to the firing state of this rule.
- Prometheus remains a private, tokenless ClusterIP service. No Prometheus, Alertmanager, receiver, webhook, paging credential, or new Ingress was added.

## Test-first chronology

The initial seventh observability contract failed because `rule_files` was absent. The first implementation passed 7/7. A design review then identified that a global alert-count panel would become ambiguous as rules are added; a refined contract failed until the panel query was scoped to `KFiveBackendUnavailable`. A final reliability contract failed until the rule covered `absent(up{job="kfive-backend"})` as well as `up == 0`, preventing a long outage from clearing merely because the series became stale.

## Live acceptance

Commands:

```bash
npm run kind:up:observability
npm run kind:verify:alerts
npm run kind:verify:observability
```

The final alert verifier returned:

```json
{
  "rule": "KFiveBackendUnavailable",
  "ruleHealth": "ok",
  "severity": "critical",
  "firingObservedAt": "2026-09-28T19:33:50.233Z",
  "recovered": true,
  "backendRestored": true,
  "dashboardPanel": "Firing alerts",
  "prometheusExposure": "ClusterIP only"
}
```

The verifier first required an inactive healthy rule and `up=1`, then scaled only the disposable `kfive` backend Deployment to zero. It observed both the rule API's `firing` state and the corresponding `ALERTS` series. Its `finally` path restored one replica and waited for rollout; it then required the rule to return inactive, the alert series to disappear, `up=1`, and the public application health route to return 200. Public `/prometheus/api/v1/rules` resolved to frontend HTML rather than the Prometheus API.

The existing observability gate restarted Prometheus and Grafana, recovered the same historical metric sample, retained the non-provisioned Grafana PVC marker, and confirmed healthy provisioned datasources/dashboard. The alert fire/recover verifier then passed again after those restarts; the JSON above is from that final post-restart run.

## Browser acceptance

Real headless Google Chrome used a browser-only `kfive.local` resolver mapping and rendered all four panels. **Firing alerts** showed `0` after recovery; the Prometheus and Loki datasource calls returned 200. The only console error was the known anonymous Viewer request to `/grafana/api/user/stars` returning 401.

Screenshot: [recovered alert dashboard](../playwright/alerting-dashboard-live-2026-09-29.png).

There is no committed visual baseline, so visual-regression comparison is inconclusive; functional rendering passed.

## Merge gate

- Observability contracts: 7/7.
- Kubernetes manifests: 5/5; socket lifecycle: 3/3.
- Node verifier syntax, Kustomize rendering, and `git diff --check`: passed.
- Live alert fire/recover and existing Prometheus/Grafana restart-persistence gates: passed.
- Real browser panel rendering and datasource requests: passed.

After verification, `npm run kind:down` removed the disposable cluster; no kind nodes, labeled helper containers, or kind temporary paths remained. The existing `kfive-ai_*` Compose volumes remained present and were not modified or deleted.

## Limits

This is a single local availability rule, not a complete alerting system. There is no Alertmanager, receiver authentication, email/chat/pager delivery, retry/deduplication, routing, inhibition, silencing policy, escalation, SLO burn-rate logic, subsystem/GPU coverage, remote monitoring, or on-call acceptance. Anonymous loopback Grafana Viewers can see aggregate alert state. NetworkPolicies and production TLS remain absent. The rule's 30-second threshold is a local test profile and has not been tuned against production error budgets.

Superseding note (2026-10-24): later slices added private Alertmanager protocol delivery and default-deny local-kind policies. Production TLS, a real operational receiver, escalation/on-call acceptance, and remote-CNI proof remain absent. See [alertmanager-live.md](alertmanager-live.md) and [network-policies-live.md](network-policies-live.md).
