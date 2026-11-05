#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

cluster_name=${KFIVE_KIND_CLUSTER:-kfive}
gitops_dir=/tmp/kfive-kind-gitops
git_source_name=kfive-kind-gitops-source
install_override=${KFIVE_ARGOCD_INSTALL_MANIFEST:-}

[[ "$cluster_name" == kfive ]] || { echo "Only the bounded 'kfive' cluster is supported." >&2; exit 1; }
for command_name in curl docker git kubectl node sha256sum; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 1; }
done
kind get clusters | grep -Fxq "$cluster_name" || { echo "The kfive kind cluster is not running." >&2; exit 1; }
docker network inspect kind >/dev/null

bootstrap_complete=0
bootstrap_state_created=0
git_source_created=0
cleanup_failed_bootstrap() {
  (( bootstrap_complete == 0 )) || return 0
  if (( git_source_created == 1 )) && docker inspect "$git_source_name" >/dev/null 2>&1; then
    source_cluster=$(docker inspect "$git_source_name" --format '{{index .Config.Labels "com.kfive.kind.cluster"}}')
    [[ "$source_cluster" == "$cluster_name" ]] && docker rm -f "$git_source_name" >/dev/null || true
  fi
  if (( bootstrap_state_created == 1 )); then
    node scripts/kind-gitops-source.cjs cleanup "$cluster_name" || true
  fi
}
trap cleanup_failed_bootstrap EXIT

if [[ -e "$gitops_dir" || -L "$gitops_dir" ]]; then
  echo "Refusing to replace existing GitOps state at $gitops_dir; run kind:down first." >&2
  exit 1
fi
install -d -m 0700 "$gitops_dir" "$gitops_dir/work"
printf '%s\n' "$cluster_name" > "$gitops_dir/.kfive-owned"
chmod 0600 "$gitops_dir/.kfive-owned"
bootstrap_state_created=1
cp -R -- k8s "$gitops_dir/work/k8s"

git -C "$gitops_dir/work" init --initial-branch=gitops-live >/dev/null
git -C "$gitops_dir/work" config user.name 'KFive GitOps verifier'
git -C "$gitops_dir/work" config user.email 'gitops-verifier@invalid.local'
git -C "$gitops_dir/work" add k8s
git -C "$gitops_dir/work" commit -m 'KFive disposable GitOps snapshot' >/dev/null
initial_revision=$(git -C "$gitops_dir/work" rev-parse HEAD)
git clone --bare "$gitops_dir/work" "$gitops_dir/repo.git" >/dev/null
git -C "$gitops_dir/repo.git" update-server-info
git -C "$gitops_dir/work" remote add origin "$gitops_dir/repo.git"
printf '%s\n' "$initial_revision" > "$gitops_dir/expected-revision"
chmod 0600 "$gitops_dir/expected-revision"

if docker inspect "$git_source_name" >/dev/null 2>&1; then
  echo "Refusing to replace existing $git_source_name container." >&2
  exit 1
fi
docker run -d --name "$git_source_name" \
  --label "com.kfive.kind.cluster=$cluster_name" --label com.kfive.role=gitops-source \
  --network kind --user 101:101 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 32 --memory 64m --cpus 0.25 \
  --restart no --no-healthcheck \
  --tmpfs /var/cache/nginx:rw,noexec,nosuid,size=8m,uid=101,gid=101 \
  --tmpfs /var/run:rw,noexec,nosuid,size=1m,uid=101,gid=101 \
  --tmpfs /tmp:rw,noexec,nosuid,size=1m,uid=101,gid=101 \
  --mount "type=bind,src=$gitops_dir/repo.git,dst=/usr/share/nginx/html/repo.git,readonly" \
  kfive-ai-frontend:latest >/dev/null
git_source_created=1
git_source_ip=$(docker inspect "$git_source_name" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
[[ "$git_source_ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] || { echo "Unexpected private Git source address." >&2; exit 1; }
git_source_url="http://$git_source_ip:8080/repo.git"

readarray -t install_config < <(node - <<'NODE'
const fs = require('node:fs');
const yaml = require('js-yaml');
const config = yaml.load(fs.readFileSync('k8s/gitops/install.yaml', 'utf8')).data;
for (const key of ['ARGOCD_VERSION', 'INSTALL_MANIFEST_URL', 'INSTALL_MANIFEST_SHA256']) {
  if (!config[key]) throw new Error(`Missing ${key}`);
  process.stdout.write(`${config[key]}\n`);
}
NODE
)
argocd_version=${install_config[0]}
install_url=${install_config[1]}
install_sha256=${install_config[2]}
install_manifest="$gitops_dir/argocd-install.yaml"
if [[ -n "$install_override" ]]; then
  [[ -f "$install_override" && ! -L "$install_override" ]] || { echo "Invalid Argo CD install override." >&2; exit 1; }
  cp -- "$install_override" "$install_manifest"
else
  curl -fsSL --max-time 60 "$install_url" -o "$install_manifest"
fi
actual_sha256=$(sha256sum "$install_manifest" | cut -d ' ' -f 1)
[[ "$actual_sha256" == "$install_sha256" ]] || { echo "Argo CD install manifest checksum mismatch." >&2; exit 1; }

kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply --server-side --force-conflicts -n argocd -f "$install_manifest" >/dev/null
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=300s
for deployment_name in argocd-applicationset-controller argocd-dex-server argocd-notifications-controller argocd-redis argocd-repo-server argocd-server; do
  kubectl -n argocd rollout status "deployment/$deployment_name" --timeout=300s
done

wait_for_application() {
  local application_name=$1
  local deadline=$((SECONDS + 360))
  while (( SECONDS < deadline )); do
    sync_status=$(kubectl -n argocd get application "$application_name" -o jsonpath='{.status.sync.status}' 2>/dev/null || true)
    health_status=$(kubectl -n argocd get application "$application_name" -o jsonpath='{.status.health.status}' 2>/dev/null || true)
    synced_revision=$(kubectl -n argocd get application "$application_name" -o jsonpath='{.status.sync.revision}' 2>/dev/null || true)
    if [[ "$sync_status" == Synced && "$health_status" == Healthy && "$synced_revision" == "$initial_revision" ]]; then return 0; fi
    sleep 3
  done
  kubectl -n argocd get application "$application_name" -o yaml >&2 || true
  return 1
}

node scripts/render-gitops-bootstrap.cjs projects "$git_source_url" "$initial_revision" | kubectl apply -f - >/dev/null
node scripts/render-gitops-bootstrap.cjs infrastructure "$git_source_url" "$initial_revision" | kubectl apply -f - >/dev/null
wait_for_application kfive-infrastructure
node scripts/render-gitops-bootstrap.cjs application "$git_source_url" "$initial_revision" | kubectl apply -f - >/dev/null
wait_for_application kfive-application

bootstrap_complete=1
trap - EXIT
echo "Argo CD $argocd_version synchronized KFive infrastructure, then application, from disposable revision $initial_revision."
