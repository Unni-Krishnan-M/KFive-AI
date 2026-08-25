#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

with_code_lab=0
case "${1:-}" in
  --with-code-lab)
    with_code_lab=1
    shift
    ;;
  --help|-h)
    echo "Usage: $0 [--with-code-lab]"
    exit 0
    ;;
esac

if (( $# > 0 )); then
  echo "Usage: $0 [--with-code-lab]" >&2
  exit 2
fi

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and replace required secrets." >&2
  exit 1
fi

run_compose() {
  if (( with_code_lab )); then
    env COMPOSE_PROFILES= CODE_RUNNER_MODE=container docker compose --profile code-lab "$@"
  else
    env COMPOSE_PROFILES= CODE_RUNNER_MODE=disabled docker compose "$@"
  fi
}

if (( with_code_lab )); then
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

run_compose up --build -d
run_compose ps
