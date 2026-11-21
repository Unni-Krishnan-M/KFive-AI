#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

cluster_name=${KFIVE_KIND_CLUSTER:-kfive}
env_file=${KFIVE_ENV_FILE:-.env}
ollama_socket_dir=/tmp/kfive-kind-ollama
ollama_socket_path=$ollama_socket_dir/ollama.sock
bridge_name=kfive-kind-ollama-bridge
expected_uid=1000
with_observability=0
with_datadog=0
with_gitops=0
while (( $# > 0 )); do
  case "$1" in
    --with-observability) with_observability=1 ;;
    --with-datadog) with_observability=1; with_datadog=1 ;;
    --with-gitops) with_gitops=1 ;;
    --help|-h)
      echo "Usage: $0 [--with-observability|--with-datadog] [--with-gitops]"
      exit 0
      ;;
    *)
      echo "Usage: $0 [--with-observability|--with-datadog] [--with-gitops]" >&2
      exit 2
      ;;
  esac
  shift
done

if (( with_observability && with_gitops )); then
  echo "The first GitOps slice manages only the core; combine observability in a later slice." >&2
  exit 2
fi

if [[ "$cluster_name" != kfive ]]; then
  echo "Only the bounded 'kfive' cluster name is supported by k8s/kind-config.yaml." >&2
  exit 1
fi
if [[ $(id -u) -ne $expected_uid ]]; then
  echo "The local kind profile requires invoking UID $expected_uid for the shared Ollama socket." >&2
  exit 1
fi
if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy .env.example to .env and set the required secrets." >&2
  exit 1
fi

for command_name in curl docker kind kubectl node; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 1; }
done

secret_dir=$(mktemp -d "${TMPDIR:-/tmp}/kfive-kind-secrets.XXXXXX")
cleanup() { rm -rf -- "$secret_dir"; }
trap cleanup EXIT
chmod 700 "$secret_dir"

node scripts/kind-ollama-socket.cjs prepare "$ollama_socket_dir" "$expected_uid"

# Parse dotenv as data, never as shell code. Values are written directly to
# mode-0600 temporary files so neither generated Secret YAML nor plaintext
# credentials are printed by this script.
node - "$env_file" "$secret_dir" "$with_datadog" <<'NODE'
const fs = require('node:fs');
const [envFile, outputDir, withDatadog] = process.argv.slice(2);
const parsed = new Map();
for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  parsed.set(match[1], value);
}
const required = ['MONGO_ROOT_USERNAME', 'MONGO_ROOT_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET', 'JWT_REFRESH_SECRET'];
for (const key of required) {
  const value = parsed.get(key);
  if (!value) throw new Error(`Missing required ${key} in ${envFile}`);
  if ((key === 'JWT_SECRET' || key === 'JWT_REFRESH_SECRET') && value.length < 32) {
    throw new Error(`${key} must contain at least 32 characters`);
  }
  fs.writeFileSync(`${outputDir}/${key}`, value, { mode: 0o600 });
}
const database = parsed.get('MONGO_DATABASE') || 'kfive_ai';
const mongoUser = encodeURIComponent(parsed.get('MONGO_ROOT_USERNAME'));
const mongoPassword = encodeURIComponent(parsed.get('MONGO_ROOT_PASSWORD'));
const redisPassword = encodeURIComponent(parsed.get('REDIS_PASSWORD'));
fs.writeFileSync(`${outputDir}/MONGODB_URL`, `mongodb://${mongoUser}:${mongoPassword}@mongodb:27017/${database}?authSource=admin`, { mode: 0o600 });
fs.writeFileSync(`${outputDir}/REDIS_URL`, `redis://:${redisPassword}@redis:6379`, { mode: 0o600 });
if (withDatadog === '1') {
  const apiKey = parsed.get('DD_API_KEY');
  if (!apiKey || apiKey.length < 32 || apiKey.startsWith('replace-')) {
    throw new Error(`DD_API_KEY must be a non-placeholder value of at least 32 characters in ${envFile}`);
  }
  fs.writeFileSync(`${outputDir}/DD_API_KEY`, apiKey, { mode: 0o600 });
}
NODE

if ! kind get clusters | grep -Fxq "$cluster_name"; then
  kind create cluster --name "$cluster_name" --config k8s/kind-config.yaml --wait 180s
fi
mounts=$(docker inspect "${cluster_name}-control-plane" --format '{{json .Mounts}}')
node -e 'const [raw,source]=process.argv.slice(1); const mounts=JSON.parse(raw); const found=mounts.find(m=>m.Type==="bind"&&m.Source===source&&m.Destination==="/run/kfive-host-ollama"&&m.RW===false); if(!found)throw new Error("kind node lacks the expected read-only Ollama socket bind mount")' "$mounts" "$ollama_socket_dir"
docker exec "${cluster_name}-control-plane" cat /run/kfive-host-ollama/.kfive-owned \
  | cmp - "$ollama_socket_dir/.kfive-owned"
docker exec "${cluster_name}-control-plane" cat /var/lib/kubelet/config.yaml \
  | node -e 'const fs=require("fs"),yaml=require("js-yaml");const c=yaml.load(fs.readFileSync(0,"utf8"));if(c.podPidsLimit!==256||c.memorySwap?.swapBehavior!=="NoSwap")throw new Error("Existing kind node lacks the required PID/swap bounds; preserve its data and migrate deliberately before deploying the importer.")'
docker exec -i "${cluster_name}-control-plane" sh -s < scripts/kind-repository-socket.sh

docker image inspect kfive-ai-ollama-bridge:latest >/dev/null 2>&1 \
  || { echo "Missing local image: kfive-ai-ollama-bridge:latest" >&2; exit 1; }
curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags >/dev/null \
  || { echo "Host Ollama is unavailable at 127.0.0.1:11434." >&2; exit 1; }
if docker inspect "$bridge_name" >/dev/null 2>&1; then
  bridge_cluster=$(docker inspect "$bridge_name" --format '{{index .Config.Labels "com.kfive.kind.cluster"}}')
  [[ "$bridge_cluster" == "$cluster_name" ]] || { echo "Refusing to replace an unowned $bridge_name container." >&2; exit 1; }
  docker rm -f "$bridge_name" >/dev/null
fi
docker run -d --name "$bridge_name" \
  --label "com.kfive.kind.cluster=$cluster_name" --label com.kfive.role=ollama-bridge \
  --network host --user 1000:1000 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 96m --cpus 0.5 \
  --restart no --no-healthcheck \
  --mount type=bind,src="$ollama_socket_dir",dst=/run/ollama-bridge \
  -e KFIVE_OLLAMA_HOST_URL=http://127.0.0.1:11434 \
  -e OLLAMA_SOCKET_PATH=/run/ollama-bridge/ollama.sock \
  kfive-ai-ollama-bridge:latest >/dev/null
curl --retry 15 --retry-all-errors --retry-delay 1 -fsS --max-time 3 \
  --unix-socket "$ollama_socket_path" http://localhost/health >/dev/null
node scripts/kind-ollama-socket.cjs verify-socket "$ollama_socket_dir" "$expected_uid"

images=(
  mongo:7.0
  redis:7.2-alpine
  chromadb/chroma:0.4.24
  traefik:v3.2.5
  kfive-ai-backend:latest
  kfive-ai-frontend:latest
)
if (( with_observability )); then
  images+=(
    prom/prometheus:v3.14.0
    prom/alertmanager:v0.29.0
    kfive-ai-subsystem-prober:latest
    grafana/grafana:13.2.2
    fluent/fluent-bit:5.1.2
    grafana/loki:3.7.8
  )
fi
if (( with_gitops )); then
  images+=(
    quay.io/argoproj/argocd:v3.5.3
    ghcr.io/dexidp/dex:v2.45.1
    public.ecr.aws/docker/library/redis:8.2.3-alpine
  )
fi
for image_name in "${images[@]}"; do
  docker image inspect "$image_name" >/dev/null 2>&1 || { echo "Missing local image: $image_name" >&2; exit 1; }
  # Recent Docker stores registry tags as multi-platform indexes but may retain
  # only the selected platform blobs. kind's all-platform importer then fails
  # on absent attestations. Export exactly the platform this kind node runs.
  docker image save --platform linux/amd64 "$image_name" \
    | docker exec --privileged -i "${cluster_name}-control-plane" \
      ctr --namespace=k8s.io images import --digests --snapshotter=overlayfs - >/dev/null
done

kubectl apply -f k8s/base/namespaces.yaml
kubectl -n kfive create secret generic kfive-secrets \
  --from-file=MONGO_ROOT_USERNAME="$secret_dir/MONGO_ROOT_USERNAME" \
  --from-file=MONGO_ROOT_PASSWORD="$secret_dir/MONGO_ROOT_PASSWORD" \
  --from-file=REDIS_PASSWORD="$secret_dir/REDIS_PASSWORD" \
  --from-file=JWT_SECRET="$secret_dir/JWT_SECRET" \
  --from-file=JWT_REFRESH_SECRET="$secret_dir/JWT_REFRESH_SECRET" \
  --from-file=MONGODB_URL="$secret_dir/MONGODB_URL" \
  --from-file=REDIS_URL="$secret_dir/REDIS_URL" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
if (( with_datadog )); then
  kubectl -n kfive-observability create secret generic kfive-datadog \
    --from-file=DD_API_KEY="$secret_dir/DD_API_KEY" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
fi
if (( with_gitops )); then
  scripts/kfive-argocd-bootstrap.sh
else
  kubectl apply -k k8s/base
fi
if (( with_observability )); then
  if (( with_datadog )); then
    kubectl apply -k k8s/observability-datadog
  else
    kubectl apply -k k8s/observability
  fi
  kubectl -n kfive-observability rollout restart deployment/prometheus >/dev/null
  kubectl -n kfive-observability rollout restart deployment/alertmanager >/dev/null
  kubectl -n kfive-observability rollout restart deployment/subsystem-prober >/dev/null
  kubectl -n kfive-observability rollout restart deployment/grafana >/dev/null
  kubectl -n kfive-observability rollout restart deployment/loki >/dev/null
  kubectl -n kfive-observability rollout restart daemonset/fluent-bit >/dev/null
fi
if (( ! with_gitops )); then
  kubectl -n kfive rollout restart deployment/backend >/dev/null
fi

for workload in statefulset/mongodb statefulset/redis statefulset/chromadb deployment/repository-importer deployment/backend deployment/frontend deployment/traefik; do
  kubectl -n kfive rollout status "$workload" --timeout=240s
done

if (( with_observability )); then
  kubectl -n kfive-observability rollout status deployment/prometheus --timeout=240s
  kubectl -n kfive-observability rollout status deployment/alertmanager --timeout=240s
  kubectl -n kfive-observability rollout status deployment/subsystem-prober --timeout=240s
  kubectl -n kfive-observability rollout status deployment/grafana --timeout=240s
  kubectl -n kfive-observability rollout status deployment/loki --timeout=240s
  kubectl -n kfive-observability rollout status daemonset/fluent-bit --timeout=240s
fi

echo "KFive kind core is ready at http://kfive.local:8088 (map kfive.local to 127.0.0.1 if needed)."
if (( with_observability )); then
  echo "Grafana is ready at http://kfive.local:8088/grafana/."
fi
