#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

args=() code_mode=disabled notebook_enabled=false
while (( $# > 0 )); do
  case "$1" in
    --with-code-lab) args+=(--profile code-lab); code_mode=container ;;
    --with-notebook) args+=(--profile notebook); notebook_enabled=true ;;
    --with-host-ollama) args+=(-f docker-compose.yml -f docker-compose.ollama-host.yml) ;;
    --help|-h) echo "Usage: $0 [--with-code-lab] [--with-notebook] [--with-host-ollama]"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
env COMPOSE_PROFILES= CODE_RUNNER_MODE=$code_mode NOTEBOOK_EXECUTION_ENABLED=$notebook_enabled \
  docker compose "${args[@]}" ps
