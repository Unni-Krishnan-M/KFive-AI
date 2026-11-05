# Argo CD local-kind verification — 2026-09-24

State: **Experimental**. This record proves the bounded disposable local-kind GitOps slice; it is not evidence for remote or production deployment.

## Scope and safety contract

- Argo CD `v3.5.3` was installed from the pinned upstream manifest after matching SHA-256 `7efe2d6bbc03f63623640f1e4198f16c84009d510fb810ef71e56df1b7614ba9`.
- Infrastructure and application use separate, disjoint Applications and restricted AppProjects. Infrastructure self-heals with automatic pruning disabled; application resources self-heal and prune.
- Namespaces and all five persistent claims carry `Prune=confirm,Delete=false`. Both Applications omit cascade finalizers. The runtime `kfive-secrets` Secret is externally created and excluded from GitOps by kind blacklist.
- The source is an isolated `k8s/` snapshot at an exact commit. A constrained read-only Git HTTP container runs only on the private kind network, publishes no host port, and never receives the working tree's `.git` directory.
- Argo CD has only ClusterIP services and no Ingress. Traefik uses static file-provider routes, has `automountServiceAccountToken: false`, and has no Kubernetes RBAC.

## Test-first changes and live findings

The first GitOps contract run failed four tests because the repository had no GitOps manifests or protection policy. After implementation, focused contracts passed 6/6. Live bootstrap then exposed and drove fixes for three integration defects: infrastructure health was blocked by application PVC ownership, the AppProject omitted PVC permission, and an Ingress without a load-balancer status never became Healthy. The final design split application PVC ownership and replaced Kubernetes Ingress discovery with tokenless static Traefik routes.

A cleanup regression was added last: it failed because explicit bootstrap validation exits were outside an `ERR` trap. The bootstrap now uses an `EXIT` guard that removes only state created by that invocation, and teardown attempts both owned temporary-state cleanups. The focused regression then passed.

## Clean-cluster live result

Commands exercised:

```bash
npm run kind:up:gitops
npm run kind:verify:gitops
npm run kind:verify
```

Initial exact revision: `7e1304264ad7400e71b9b2e4b8ed18cd9918114f`.

The independent GitOps verifier created a canary at a new exact commit, observed Argo create it, removed it in another exact commit, and observed automated application pruning. It changed frontend replicas to two and observed self-heal restore one replica. It restarted the Argo application controller and repository server, then required both Applications to return to their exact final revision in `Synced/Healthy` state.

Final exact revision: `8668f0093ba998503fb486c38f27866f19760fc8`.

```json
{
  "expectedRevision": "7e1304264ad7400e71b9b2e4b8ed18cd9918114f",
  "finalRevision": "8668f0093ba998503fb486c38f27866f19760fc8",
  "infrastructure": "Synced/Healthy",
  "application": "Synced/Healthy",
  "selfHeal": true,
  "prune": true,
  "pvcUidsUnchanged": true,
  "secretUnchanged": true,
  "controllerRestart": true,
  "privateExposure": true
}
```

All five PVC UIDs were identical before and after reconciliation. The external Secret UID and content hash were identical. Authorization confirmed Traefik cannot list Secrets. Six core pods were Ready, and frontend plus readiness routing passed with no Traefik provider/permission errors.

The authenticated core verifier also passed through the Argo-managed cluster:

```json
{
  "frontend": "passed",
  "readiness": "passed",
  "socketIo": "passed",
  "providerModels": "passed",
  "chatStream": "passed",
  "bridgeRestart": "passed",
  "mongoBackendRestartPersistence": "passed",
  "userId": "6ab53f0bf8d482a76e1aed82"
}
```

Its disposable fixture was removed by the verifier. No Compose service or persistent volume was changed.

## Observability compatibility

After the GitOps and authenticated core gates, the opt-in observability overlay was applied to the same disposable cluster to regression-test the Traefik provider change. The metrics verifier passed backend metrics privacy, Prometheus target health, Grafana health/datasource/dashboard, an identical Prometheus historical sample after restart, and Grafana provisioning plus a non-provisioned PVC marker after restart. The log verifier passed namespace-scoped RBAC, no Service exposure, structured JSON parsing, Kubernetes metadata, namespace exclusion, backend/Traefik marker correlation, and resumed collection after Fluent Bit replacement. This confirms compatibility; the overlay was applied directly for this regression and is not claimed as a third Argo Application.

## Images and focused gates

Controller images observed on the host before loading into kind:

- Argo CD: `quay.io/argoproj/argocd:v3.5.3`, digest `sha256:dd3f47d5a5e4da563a7a398506e892481b358a7cec50abdf320c71aa55904bfa`
- Dex: `ghcr.io/dexidp/dex:v2.45.1`, digest `sha256:8499afd690c437f52301efd2b05b2455da5bd2dfc20332cd697dc9937f808462`
- Redis: `public.ecr.aws/docker/library/redis:8.2.3-alpine`, digest `sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba`

The final focused gate includes GitOps contracts 6/6, Kubernetes contracts 5/5, observability contracts 4/4, Bash and Node syntax checks, base and observability Kustomize rendering, and `git diff --check`.

## Limits

Application images still use local mutable tags, even though the Argo controller images and install manifest are pinned. The profile uses an unauthenticated disposable Git source inside one local Docker network, default local Argo accounts, one kind node, local-path storage, and a hostPath Ollama bridge. Remote Git authentication, remote/multi-node clusters, TLS/SSO, production controller RBAC/isolation, NetworkPolicies, portable storage, backup/restore, disaster recovery, promotion/rollback, and laptop-independent operation remain unverified. Those gaps keep this slice Experimental.

Superseding note (2026-10-24): default-deny application and observability NetworkPolicies are now part of the GitOps ownership split and passed a separate direct-apply kindnet acceptance. They were not part of this original Argo sync run, and Argo-controller isolation, remote/multi-node CNI behavior, portable storage, and backup/restore remain unverified. Fluent Bit is now tokenless/tag-derived rather than namespace-RBAC-based. See [network-policies-live.md](network-policies-live.md).
