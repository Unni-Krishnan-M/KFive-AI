#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

with_code_lab=0
with_notebook=0
while (( $# > 0 )); do
  case "$1" in
    --with-code-lab) with_code_lab=1 ;;
    --with-notebook) with_notebook=1 ;;
    --help|-h)
      echo "Usage: $0 [--with-code-lab] [--with-notebook]"
      exit 0
      ;;
    *)
      echo "Usage: $0 [--with-code-lab] [--with-notebook]" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and replace required secrets." >&2
  exit 1
fi

run_compose() {
  local args=() code_mode=disabled notebook_enabled=false
  if (( with_code_lab )); then args+=(--profile code-lab); code_mode=container; fi
  if (( with_notebook )); then args+=(--profile notebook); notebook_enabled=true; fi
  env COMPOSE_PROFILES= CODE_RUNNER_MODE=$code_mode NOTEBOOK_EXECUTION_ENABLED=$notebook_enabled \
    docker compose "${args[@]}" "$@"
}

read_env_value() {
  local requested_key=$1
  local line
  env_value=""
  while IFS= read -r line; do
    case "$line" in
      "${requested_key}="*) env_value=${line#*=} ;;
    esac
  done < .env
  env_value=${env_value%$'\r'}
  if [[ $env_value == \"*\" && $env_value == *\" ]]; then
    env_value=${env_value:1:${#env_value}-2}
  elif [[ $env_value == \'*\' && $env_value == *\' ]]; then
    env_value=${env_value:1:${#env_value}-2}
  fi
}

if (( with_code_lab )); then
  docker_socket=${CODE_RUNNER_DOCKER_SOCKET:-}
  if [[ -z $docker_socket ]]; then
    read_env_value CODE_RUNNER_DOCKER_SOCKET
    docker_socket=$env_value
  fi
  docker_socket=${docker_socket:-/var/run/docker.sock}

  docker_gid=${CODE_RUNNER_DOCKER_GID:-}
  if [[ -z $docker_gid ]]; then
    read_env_value CODE_RUNNER_DOCKER_GID
    docker_gid=$env_value
  fi

  if [[ ! -S $docker_socket || ! -r $docker_socket || ! -w $docker_socket ]]; then
    echo "Code Lab Docker socket is missing or inaccessible: $docker_socket" >&2
    echo "Set CODE_RUNNER_DOCKER_SOCKET in .env to a readable/writable dedicated or rootless Docker socket." >&2
    exit 1
  fi
  if [[ ! $docker_gid =~ ^[0-9]+$ ]]; then
    echo "CODE_RUNNER_DOCKER_GID must be the numeric group ID owning $docker_socket." >&2
    echo "Run: stat -c '%g' '$docker_socket'" >&2
    echo "Then paste that number into .env; do not copy an example GID." >&2
    exit 1
  fi
  actual_docker_gid=$(stat -c '%g' -- "$docker_socket")
  if [[ $docker_gid != "$actual_docker_gid" ]]; then
    echo "CODE_RUNNER_DOCKER_GID=$docker_gid does not match socket group $actual_docker_gid." >&2
    echo "Update .env with: CODE_RUNNER_DOCKER_GID=$actual_docker_gid" >&2
    exit 1
  fi

  docker_host="unix://$docker_socket"
  if ! docker --host "$docker_host" info >/dev/null 2>&1; then
    echo "Cannot access the Docker daemon required by Code Lab at $docker_socket." >&2
    exit 1
  fi

  missing_images=()
  for image in python:3.12-alpine node:22-alpine; do
    if ! docker --host "$docker_host" image inspect "$image" >/dev/null 2>&1; then
      missing_images+=("$image")
    fi
  done
  if (( ${#missing_images[@]} > 0 )); then
    echo "Code Lab requires fixed runtime images to exist before startup; runs never pull images." >&2
    for image in "${missing_images[@]}"; do
      echo "  docker --host '$docker_host' pull $image" >&2
    done
    echo "After reviewing the image tags/digests, rerun: $0 --with-code-lab" >&2
    exit 1
  fi
fi

if (( with_notebook )); then
  notebook_socket=${NOTEBOOK_DOCKER_SOCKET:-}
  if [[ -z $notebook_socket ]]; then read_env_value NOTEBOOK_DOCKER_SOCKET; notebook_socket=$env_value; fi
  notebook_socket=${notebook_socket:-/var/run/docker.sock}
  notebook_gid=${NOTEBOOK_DOCKER_GID:-}
  if [[ -z $notebook_gid ]]; then read_env_value NOTEBOOK_DOCKER_GID; notebook_gid=$env_value; fi
  if [[ ! -S $notebook_socket || ! -r $notebook_socket || ! -w $notebook_socket ]]; then
    echo "Notebook broker Docker socket is missing or inaccessible: $notebook_socket" >&2
    exit 1
  fi
  if [[ ! $notebook_gid =~ ^[0-9]+$ ]]; then
    echo "NOTEBOOK_DOCKER_GID must be the numeric group ID owning $notebook_socket." >&2
    echo "Run: stat -c '%g' '$notebook_socket'" >&2
    exit 1
  fi
  actual_notebook_gid=$(stat -c '%g' -- "$notebook_socket")
  if [[ $notebook_gid != "$actual_notebook_gid" ]]; then
    echo "NOTEBOOK_DOCKER_GID=$notebook_gid does not match socket group $actual_notebook_gid." >&2
    exit 1
  fi
  notebook_host="unix://$notebook_socket"
  if ! docker --host "$notebook_host" info >/dev/null 2>&1; then
    echo "Cannot access the Docker daemon required by the notebook broker." >&2
    exit 1
  fi
  security_options=$(docker --host "$notebook_host" info --format '{{json .SecurityOptions}}')
  if [[ $security_options != *name=seccomp* ]]; then
    echo "Notebook execution requires Docker seccomp support." >&2
    exit 1
  fi
  notebook_require_apparmor=${NOTEBOOK_REQUIRE_APPARMOR:-}
  if [[ -z $notebook_require_apparmor ]]; then read_env_value NOTEBOOK_REQUIRE_APPARMOR; notebook_require_apparmor=${env_value:-true}; fi
  if [[ $notebook_require_apparmor == true && $security_options != *name=apparmor* ]]; then
    echo "Notebook execution requires AppArmor, but Docker does not report it." >&2
    echo "Enable AppArmor or explicitly set NOTEBOOK_REQUIRE_APPARMOR=false for an Experimental reduced-isolation run." >&2
    exit 1
  fi
  notebook_runtime_image=${NOTEBOOK_RUNTIME_IMAGE:-}
  if [[ -z $notebook_runtime_image ]]; then read_env_value NOTEBOOK_RUNTIME_IMAGE; notebook_runtime_image=${env_value:-kfive-notebook-runtime:local}; fi
  notebook_verifier_image=${NOTEBOOK_VERIFIER_IMAGE:-}
  if [[ -z $notebook_verifier_image ]]; then read_env_value NOTEBOOK_VERIFIER_IMAGE; notebook_verifier_image=${env_value:-kfive-notebook-verifier:local}; fi
  if [[ $notebook_runtime_image == "$notebook_verifier_image" ]]; then
    echo "Notebook runtime and verifier image names must be distinct." >&2
    exit 1
  fi
  docker --host "$notebook_host" build --target runtime -t "$notebook_runtime_image" services/notebook-runtime
  docker --host "$notebook_host" build --target verifier -t "$notebook_verifier_image" services/notebook-runtime
  runtime_id=$(docker --host "$notebook_host" image inspect --format '{{.Id}}' "$notebook_runtime_image")
  verifier_id=$(docker --host "$notebook_host" image inspect --format '{{.Id}}' "$notebook_verifier_image")
  if [[ -z $runtime_id || -z $verifier_id || $runtime_id == "$verifier_id" ]]; then
    echo "Notebook runtime and verifier did not resolve to distinct image identities." >&2
    exit 1
  fi
fi

run_compose up --build -d
run_compose ps
