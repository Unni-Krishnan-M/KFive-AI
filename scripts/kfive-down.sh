#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

with_code_lab=0
with_notebook=0
with_host_ollama=0
while (( $# > 0 )); do
  case "$1" in
    --with-code-lab) with_code_lab=1 ;;
    --with-notebook) with_notebook=1 ;;
    --with-host-ollama) with_host_ollama=1 ;;
    --help|-h) echo "Usage: $0 [--with-code-lab] [--with-notebook] [--with-host-ollama]"; exit 0 ;;
    *) echo "Usage: $0 [--with-code-lab] [--with-notebook] [--with-host-ollama]" >&2; exit 2 ;;
  esac
  shift
done

args=() code_mode=disabled notebook_enabled=false
if (( with_host_ollama )); then args+=(-f docker-compose.yml -f docker-compose.ollama-host.yml); fi
if (( with_code_lab )); then args+=(--profile code-lab); code_mode=container; fi
if (( with_notebook )); then args+=(--profile notebook); notebook_enabled=true; fi
env COMPOSE_PROFILES= CODE_RUNNER_MODE=$code_mode NOTEBOOK_EXECUTION_ENABLED=$notebook_enabled \
  docker compose "${args[@]}" down
