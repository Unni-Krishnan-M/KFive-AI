#!/usr/bin/env bash
set -euo pipefail
cluster_name=${KFIVE_KIND_CLUSTER:-kfive}
ollama_socket_dir=/tmp/kfive-kind-ollama
bridge_name=kfive-kind-ollama-bridge
git_source_name=kfive-kind-gitops-source
gitops_dir=/tmp/kfive-kind-gitops
expected_uid=1000
if [[ "$cluster_name" != kfive ]]; then
  echo "Only the bounded 'kfive' cluster name is supported by k8s/kind-config.yaml." >&2
  exit 1
fi
if docker inspect "$git_source_name" >/dev/null 2>&1; then
  source_cluster=$(docker inspect "$git_source_name" --format '{{index .Config.Labels "com.kfive.kind.cluster"}}')
  [[ "$source_cluster" == "$cluster_name" ]] || { echo "Refusing to remove an unowned $git_source_name container." >&2; exit 1; }
  docker rm -f "$git_source_name" >/dev/null
fi
if docker inspect "$bridge_name" >/dev/null 2>&1; then
  bridge_cluster=$(docker inspect "$bridge_name" --format '{{index .Config.Labels "com.kfive.kind.cluster"}}')
  [[ "$bridge_cluster" == "$cluster_name" ]] || { echo "Refusing to remove an unowned $bridge_name container." >&2; exit 1; }
  docker rm -f "$bridge_name" >/dev/null
fi
cleanup_status=0
node scripts/kind-ollama-socket.cjs cleanup "$ollama_socket_dir" "$expected_uid" || cleanup_status=$?
if (( cleanup_status != 0 )); then
  if ! kind get clusters | grep -Fxq "$cluster_name"; then
    echo "Refusing to delete the kind node after unsafe socket cleanup." >&2
    exit "$cleanup_status"
  fi
  orphan_valid=0
  for attempt in {1..5}; do
    if node scripts/kind-ollama-socket.cjs inspect-docker-orphan "$ollama_socket_dir" 0; then
      orphan_valid=1
      break
    fi
    sleep 1
  done
  (( orphan_valid == 1 )) \
    || { echo "Refusing to delete the kind node after unsafe socket cleanup." >&2; exit "$cleanup_status"; }
  node_name="${cluster_name}-control-plane"
  node_cluster=$(docker inspect "$node_name" --format '{{index .Config.Labels "io.x-k8s.kind.cluster"}}')
  [[ "$node_cluster" == "$cluster_name" ]] \
    || { echo "Refusing recovery for an unowned kind node." >&2; exit "$cleanup_status"; }
  mounts=$(docker inspect "$node_name" --format '{{json .Mounts}}')
  node -e 'const [raw,source]=process.argv.slice(1);const mounts=JSON.parse(raw);const exact=mounts.some((mount)=>mount.Type==="bind"&&mount.Source===source&&mount.Destination==="/run/kfive-host-ollama"&&mount.RW===false);if(!exact)throw new Error("kind node lacks the exact read-only orphaned socket bind mount")' "$mounts" "$ollama_socket_dir" \
    || { echo "kind node lacks the exact read-only orphaned socket bind mount" >&2; exit "$cleanup_status"; }
  echo "Recovering an empty Docker-recreated kind socket directory after daemon restart." >&2
  kind delete cluster --name "$cluster_name"
  orphan_remove_status=0
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL \
    --security-opt no-new-privileges --pids-limit 16 --memory 32m --cpus 0.1 \
    --mount type=bind,src=/tmp,dst=/host-tmp --entrypoint /bin/rmdir \
    kindest/node:v1.37.0 /host-tmp/kfive-kind-ollama || orphan_remove_status=$?
  [[ ! -e "$ollama_socket_dir" ]] \
    || { echo "Docker orphan cleanup did not remove $ollama_socket_dir (status $orphan_remove_status)." >&2; exit 1; }
else
  if kind get clusters | grep -Fxq "$cluster_name"; then
    kind delete cluster --name "$cluster_name"
  else
    echo "KFive kind cluster is not running."
  fi
fi
node scripts/kind-gitops-source.cjs cleanup "$cluster_name" || cleanup_status=$?
exit "$cleanup_status"
