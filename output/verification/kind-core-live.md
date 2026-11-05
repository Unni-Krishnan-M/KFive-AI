# Local kind core verification — 2026-09-22

State: **PASS for the bounded local core; Kubernetes overall remains Experimental.**

## Scope

The verified slice is frontend → Traefik → backend with MongoDB, Redis, ChromaDB, persistent claims, Socket.IO, and loopback-only host Ollama through a restricted Unix-socket bridge. It does not include KFive worker services, TLS, GPU scheduling, observability, Argo CD, or a remote cluster.

## TDD evidence

The failing manifest contract first showed missing `OLLAMA_SOCKET_PATH`, backend socket mounts, kind `extraMounts`, and removal of the TCP EndpointSlice. After implementation:

- `node scripts/kind-ollama-socket.test.cjs`: 3/3 passed (private owned directory/marker, symlink and unsafe-directory rejection, cleanup refusal for symlinks/foreign contents).
- `node scripts/kubernetes-manifests.test.cjs`: 5/5 passed (resources/namespaces/PVCs, external secrets and socket topology, workload resources/security, Traefik/private services, deployment-script safeguards).
- `node --test services/ollama-bridge/server.test.cjs`: 12/12 passed.
- `bash -n scripts/kfive-kind-up.sh scripts/kfive-kind-down.sh`: passed.
- `kubectl kustomize k8s/base`: passed.

No TDD checkpoint commits were created because the shared worktree already contains extensive user/agent changes; RED/GREEN evidence is retained here instead.

## Live production-path result

`./scripts/kfive-kind-up.sh` created a clean `kind-kfive` cluster and completed every rollout. `node scripts/verify-kind-core-live.cjs --allow-live-test` then returned:

```json
{
  "frontend": "passed",
  "readiness": "passed",
  "socketIo": "passed",
  "providerModels": "passed",
  "chatStream": "passed",
  "bridgeRestart": "passed",
  "mongoBackendRestartPersistence": "passed"
}
```

The verifier registered a disposable user, listed `all-minilm:22m` and `phi3:latest` through the authenticated provider abstraction, streamed a real Phi3 response with provider/model start and completed SSE events, restarted the Unix bridge, restarted MongoDB and backend, logged in again with the same Mongo user id, and removed the disposable conversation/user records.

Post-run inspection showed six of six pods Ready, five of five PVCs Bound, and readiness HTTP 200 with MongoDB and Redis available. The bridge had project/cluster ownership labels, host networking only for loopback Ollama access, a read-only root, all capabilities dropped, `no-new-privileges`, 64 PIDs, and 96 MiB RAM. The socket directory/marker/socket were owned by UID 1000 with modes 0700/0600/0660.

Finally, `./scripts/kfive-kind-down.sh` removed the labeled bridge, deleted only the `kfive` kind cluster, and safely removed the verified owned socket/marker directory. Follow-up inspection reported `No kind clusters found` and `socket-dir-cleaned`; the heavy test stack was not left running.

## Browser and known gaps

Playwright was attempted against `http://kfive.local:8088`, but the machine had no `kfive.local → 127.0.0.1` resolver entry, yielding `ERR_NAME_NOT_RESOLVED`. Chromium also rejects manual `Host` header overriding. Therefore browser-rendered kind acceptance is explicitly unverified; direct HTTP ingress, authenticated API, Socket.IO, and streaming paths passed.

The local `hostPath` socket bridge is incompatible with Baseline/Restricted Pod Security admission and is intentionally limited to this single-node kind profile. Remote Kubernetes needs a different authenticated provider topology. Argo CD and observability remain Planned.
