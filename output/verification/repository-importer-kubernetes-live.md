# Repository importer local-kind acceptance

Date: 2026-11-20  
Classification: **Implemented local-kind slice / Experimental Repository Analyzer and Kubernetes**

## Topology

The importer runs in a separate single-replica pod, pinned alongside the backend to `kfive-control-plane`. A dedicated node-local 1 MiB tmpfs holds only the fixed Unix socket. Provisioning checks the mount source/type/options, directory owner/mode, and existing entries; foreign directories, symlinks, and unexpected entries fail closed. The importer owns the directory as `10001:10002` with mode `0770`; the socket is `0660`. The backend joins supplemental group `10002` and mounts only this directory read-only. There is no importer Service or TCP listener and no process fallback.

The namespace default-deny policy selects the importer, while the general DNS allow policy explicitly excludes it. The pod receives no application environment, secrets, data volumes, Docker socket, or Kubernetes API token. It uses a read-only root, dropped capabilities, no privilege escalation, runtime-default seccomp, a 32 MiB memory-backed scratch volume, a 512 MiB memory limit, one CPU, zero swap, and zero core dumps. The kind kubelet sets **256 PIDs per pod**; this differs from Compose's 48-PID limit and applies to all pods on this local node. Startup rejects an existing kind node without the declared PID/swap configuration rather than silently replacing it.

The socket tmpfs is `noexec,nosuid,nodev`; Kubernetes `emptyDir` does not provide an equivalent explicit no-exec mount option for the scratch directory. NetworkPolicy enforcement depends on the CNI and does not isolate pod loopback or every node-local interaction. This is not a portable multi-node topology or a claim of equivalence to Compose `network_mode: none`.

## Executed checks

`./scripts/kfive-kind-up.sh` created a fresh local kind cluster and rolled out the seven core workloads. Existing stopped Compose containers were not started or replaced. No existing Compose volume was removed or recreated.

`node scripts/verify-repository-importer-kubernetes-live.cjs --allow-live-test` passed through the real loopback Traefik/API/MongoDB path:

| Check | Result |
| --- | --- |
| Non-root UID/GID, socket owner/group/mode | `10001:10002`, `0660` |
| Backend socket directory writes | Rejected with `EROFS` |
| Live cgroup memory/swap/CPU | `536870912` bytes / `0` bytes / `100000 100000` |
| Actual parent pod cgroup PID limit | `256` |
| PID 1 soft/hard core limits | `0 / 0` |
| Kubernetes API token mounted | No |
| MongoDB/Redis/ChromaDB denial | Nine denied TCP probes, with backend positive controls |
| CoreDNS TCP/53 | Importer denied; backend positive control succeeded |
| Concurrent admitted imports | Two deterministic 9,699,328-byte ZIPs, each 2,000 entries and 20 manifests |
| Importer parser observation | Peak two children across 1,548 samples at a requested 5 ms interval |
| Cross-user report access | `404` |
| Hostile entry-count/ratio/manifest shapes | All three rejected; zero reports retained for those owners |
| Importer scaled to zero | Containers terminated; new upload fixed `503 REPOSITORY_ANALYZER_UNAVAILABLE`; existing report readable |
| Importer restored | Recovery upload succeeded |
| Backend restart | Prior report remained readable with identical source SHA-256 |
| Exact cleanup | Seven ID/email-preflighted users and their owner-scoped reports removed |
| Kubernetes PVC/Secret and Compose volume identities | Unchanged |

The verifier independently resolves the runtime container PID and reads its parent pod's `pids.max`; a manifest value alone is not the PID proof. Child sampling proves parser placement/concurrency during this workload, not exhaustive native-memory safety or throughput.

## Findings corrected during acceptance

- The first attempt reached runtime/network checks but returned `404` before registration because the host Node fetch transport did not preserve the required virtual Host routing. The verifier now uses native HTTP transport with explicit `Host: kfive.local` and standard bounded multipart serialization. No user was created by that attempt.
- Runtime inspection found unlimited inherited core-dump limits. The importer now starts through a fixed `ulimit -c 0; exec node ...` command, and the final verifier checks both limits on PID 1.
- The next attempt created seven users, passed uploads and hostile rejection, then timed out waiting for a deleted Pod API record. Its finally path restored the importer and removed all seven users/reports; a separate Mongo check confirmed zero matching temporary accounts. This host retains some terminated Pod records with a deletion timestamp. The verifier now requires every importer container to have terminated before testing unavailability and selects only running, non-deleting pods after recovery. No finalizer was removed and no force deletion was used. Completed Pod-record retention remains a host/cluster cleanup limitation, not a claim of complete pod garbage collection.

## Regression and boundaries

The four focused Kubernetes importer contracts pass. Existing Kubernetes/observability and GitOps contracts cover the changed policy graph, hostPath allowlist, configuration, and source ownership. Shell and JavaScript syntax checks and `git diff --check` pass. Final regression results are recorded in the completion plan.

The same backend/importer image already accepted for the Compose resource slice was loaded locally; no new application source was introduced by this slice. This acceptance does not prove immutable registry artifacts, remote/multi-node scheduling, portable socket storage, namespace tenant isolation, arbitrary hostile ZIP safety, soak/sizing, distributed quotas, or complete semantic validation of responses. The importer has no service-network permission, but it still has a Kubernetes pod network namespace. Repository Analyzer and Kubernetes remain **Experimental** overall.

Design references: [Kubernetes pod networking](https://kubernetes.io/docs/concepts/workloads/pods/#pod-networking), [pod PID limiting](https://kubernetes.io/docs/concepts/policy/pid-limiting/), and [kind configuration](https://kind.sigs.k8s.io/docs/user/configuration/).
