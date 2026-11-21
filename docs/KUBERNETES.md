# Kubernetes

State: **Experimental**. The bounded local kind core is implemented and live-verified; this is not a production or remote Kubernetes deployment claim.

The repository ships `k8s/base` manifests for the `kfive` and `kfive-observability` namespaces, private MongoDB/Redis/ChromaDB services, persistent claims, backend/frontend, and Traefik. All workloads have resource bounds, probes, runtime-default seccomp, dropped capabilities, no privilege escalation, and read-only roots. Application and observability workloads do not receive Kubernetes API tokens. Fluent Bit derives limited namespace/pod/container identity from the container-log tag with `Use_Tag_For_Meta On`; it uses the default ServiceAccount with token automount disabled and has no Role or RoleBinding. Traefik uses projected static file-provider routes and receives no Kubernetes RBAC. Only Traefik publishes a loopback-bound local NodePort; databases, ChromaDB, and telemetry services remain ClusterIP-only.

## Local kind run

Prerequisites are Docker, kind, kubectl, curl, Node.js, the application images named by the script, a healthy host Ollama on `127.0.0.1:11434`, and a configured `.env`. The current local profile deliberately requires host UID 1000.

```bash
npm run test:kubernetes
npm run kind:up
# map kfive.local to 127.0.0.1 in local DNS or /etc/hosts
curl -H 'Host: kfive.local' http://127.0.0.1:8088/api/v1/readiness
npm run kind:verify
npm run kind:down
```

Prometheus and Grafana remain opt-in:

```bash
npm run kind:up:observability
npm run kind:verify:logs
npm run kind:verify:observability
npm run kind:verify:probes
npm run kind:verify:alerts
npm run kind:verify:network-policies
```

The observability profile includes private Alertmanager 0.29.0 with a null default receiver and bounded persistent state. It also includes a private fixed-target prober for independent MongoDB/Redis TCP and ChromaDB heartbeat reachability; it accepts no caller-selected target. `kind:verify:probes` proves a Chroma-only failure, rule firing, restoration, PVC identity, and application recovery. `kind:verify:alerts` temporarily installs an authenticated private receiver, proves firing and resolved delivery across an Alertmanager outage, then restores the exact null baseline and removes the harness. It does not send a real page or configure an external receiver.

Optional Datadog forwarding is a separate fresh-cluster profile. Add `DD_API_KEY` only to the ignored private `.env`, then run `npm run kind:up:datadog`. It retains Loki delivery while adding TLS/gzip Datadog delivery from an external Secret. For a non-SaaS integration check, start the ordinary observability profile and run `npm run kind:verify:datadog`; the verifier uses only a private in-cluster receiver, refuses pre-existing harness resources, and restores the default collector. See [Observability](OBSERVABILITY.md) for the data-egress and acceptance boundary.

Both namespaces default-deny ingress and egress. Explicit policy edges cover only the loopback edge routes, frontend/backend, backend datastores, observability scrapes/datasources/log delivery/alerts, and the fixed subsystem prober. DNS is restricted to CoreDNS selectors plus `10.96.0.10/32`; the kind service subnet is pinned to `10.96.0.0/16`. `kind:verify:network-policies` creates three healthy disposable canaries, requires explicit remote denial sentinels for nine private targets over three passes, verifies the allowed graph, then proves canary cleanup and unchanged Secret/PVC UIDs. See [the live record](../output/verification/network-policies-live.md).

This policy graph is a single-node kindnet development boundary, not tenant isolation. Selectors are label-based, so a principal able to create or relabel pods can impersonate an allowed workload. Traefik ingress is intentionally open on its pod port because it is the edge; host publication remains loopback-only. The opt-in Datadog collector has unrestricted TCP/443 destination egress because standard NetworkPolicy cannot select an FQDN; use an FQDN-aware CNI policy or controlled proxy for production.

`k8s/observability/ingress.yaml` is a retained, inactive prototype and is not included by the Kustomize overlay. The supported local route is the projected Traefik file-provider configuration; the prototype must not be applied independently.

## Local Argo CD GitOps run

The GitOps profile is separately opt-in and creates a clean cluster. It cannot be combined with the observability flag in one bootstrap command.

```bash
npm run test:gitops
npm run kind:up:gitops
npm run kind:verify:gitops
npm run kind:verify
npm run kind:down
```

The bootstrap copies only `k8s/` into an owner-marked `/tmp` workspace, makes an isolated commit, and serves its bare repository from a constrained container on the private kind network with no published port. It verifies the pinned Argo CD 3.5.3 install manifest checksum before applying it. AppProjects restrict the exact source, destinations, and resource kinds and reject Secret management. The externally created `kfive-secrets` Secret therefore stays outside Git.

Infrastructure synchronizes and becomes healthy before application resources are introduced. Infrastructure self-heals but does not prune automatically; application resources self-heal and prune. Namespace and PVC resources additionally require explicit prune confirmation and retain data on Application deletion. Neither Application has a cascade finalizer. The verifier moves each Application between exact commit SHAs, proves application creation and pruning, replica self-heal, controller/repository-server restart recovery, private exposure, and unchanged PVC and Secret identity.

`kind:up` parses `.env` as data, writes secrets to private temporary files, and creates the Kubernetes Secret without printing its payload. The script never commits a Secret. It loads only the local linux/amd64 images needed by this slice and waits for MongoDB, Redis, ChromaDB, backend, frontend, and Traefik rollouts.

`kind:down` normally validates and removes the owned private Ollama socket directory before deleting its mounted node. If a Docker-daemon restart has stopped the bridge and recreated that bind source, recovery is allowed only when the directory is host-root-owned, mode 0755, completely empty, and attached as the exact read-only mount of the owned `kfive-control-plane`; the node is deleted first and an isolated no-network/no-capability container removes only that exact orphan. Symlinks, foreign contents, ownership/mode mismatches, unexpected mounts, and unowned nodes still abort teardown.

## Host Ollama boundary

Ollama remains loopback-only on the host. A route-allowlisted, non-root, read-only bridge shares a mode-0660 Unix socket through a read-only kind node mount and a read-only backend mount. There is no Ollama TCP listener, Kubernetes Service, or EndpointSlice. The socket directory rejects symlinks, unexpected ownership/modes, foreign contents, unowned bridge containers, and stale/mismatched node mounts. A live bridge restart proved the backend reconnects to the recreated socket.

This `hostPath` is a deliberate local-kind exception and is incompatible with Kubernetes Baseline/Restricted Pod Security admission. It must not be presented as a portable production topology. Remote deployments should use an authenticated remote provider or an independently secured provider service instead.

## Repository importer boundary

The local-kind profile now uses a separate non-root importer pod with no secrets, application data, API token, or permitted service-network traffic. The backend and importer are pinned to `kfive-control-plane` and communicate over a fixed `0660` Unix socket in a guarded node-local 1 MiB tmpfs. The backend mount is read-only. The namespace DNS allow rule excludes the importer. Its pod has startup/readiness/liveness socket probes, a read-only root, dropped capabilities, runtime-default seccomp, 32 MiB memory-backed scratch, 512 MiB memory, one CPU, zero swap, and zero core dumps. The kubelet enforces 256 PIDs per pod across this node.

`kind:up` provisions and checks the socket directory before applying workloads; it rejects existing nodes with incompatible PID/swap bounds without deleting their data. The node-local directory is ephemeral and must be provisioned again after node loss. Applying the base YAML alone to an unprepared node is insufficient. This adds a second narrow local-kind hostPath exception; neither socket topology is portable production Kubernetes or compatible with Baseline/Restricted Pod Security admission. Image tags remain locally loaded mutable development tags.

Run `npm run test:repository-importer-kubernetes` for contracts and `npm run kind:verify:repository-importer` for the opt-in real upload/network/outage/restart/cleanup acceptance. The latter scales only the importer and restarts the backend, creates seven temporary identities, and preflights every exact ID/email pair before deleting their reports and accounts. It checks Kubernetes PVC/Secret and existing Compose volume identities. See [the acceptance record](../output/verification/repository-importer-kubernetes-live.md), including the host's retained terminated-Pod-record limitation.

## Verified scope and limits

On 2026-09-22, a clean cluster passed frontend and readiness routing, Socket.IO polling, authenticated registration/model discovery, real Phi3 chat streaming through host Ollama, bridge restart, MongoDB/backend restart, login with the same user id, and exact fixture cleanup. All six workloads were Ready and all five PVCs were Bound. See [the core live evidence](../output/verification/kind-core-live.md).

On 2026-09-24, the same authenticated core verifier passed in a clean Argo-managed cluster after exact-commit sync, self-heal, prune, controller restart, PVC preservation, and external-Secret preservation checks. See [the GitOps live evidence](../output/verification/argocd-live.md).

The core acceptance initially lacked browser DNS. Later observability acceptances supplied a browser-only host resolver mapping and rendered the real Grafana route through Traefik, including backend-process MongoDB/Redis availability, independent MongoDB/Redis/ChromaDB reachability, and explicit CPU-only GPU-unavailable panels; this does not broaden the earlier authenticated application-core test or prove physical GPU access.

Still missing: Code Runner and its worker, document/OCR processors, RAG/agent/workflow/benchmark/notebook workers, provider/worker probes, GPU scheduling/device mapping/DCGM acceptance, authentication-aware datastore checks, deep datastore and queue metrics, multi-replica coordination, TLS/domain automation, portable storage classes, backup/restore, production-durable remote log storage, operational paging/escalation, normal host-DNS browser setup, remote/multi-node CNI verification, and any remote-cluster acceptance. The local Loki slice proves search and pod-restart persistence only; kind/node/PV loss is not covered. The independent prober proves shallow reachability only. The Alertmanager slice proves authenticated local protocol delivery, not a real on-call receiver. The Datadog slice proves a secret-backed collector contract against a private receiver, not external SaaS acceptance or destination-constrained 443 egress. The Argo CD slice still lacks remote Git credentials, a remote or multi-node cluster, production TLS/SSO/RBAC, controller isolation, immutable application image digests, disaster recovery, and promotion/rollback policy. These gaps keep Kubernetes, observability, and GitOps Experimental.
