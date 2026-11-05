#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

args=() code_mode=disabled notebook_enabled=false with_host_ollama=0 with_documents=0
while (( $# > 0 )); do
  case "$1" in
    --with-code-lab) args+=(--profile code-lab); code_mode=container ;;
    --with-notebook) args+=(--profile notebook); notebook_enabled=true ;;
    --with-host-ollama) with_host_ollama=1 ;;
    --with-documents) with_documents=1 ;;
    --help|-h) echo "Usage: $0 [--with-code-lab] [--with-notebook] [--with-host-ollama] [--with-documents] [SERVICE ...]"; exit 0 ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
  shift
done
compose_files=()
if (( with_host_ollama || with_documents )); then compose_files+=(-f docker-compose.yml); fi
if (( with_host_ollama )); then compose_files+=(-f docker-compose.ollama-host.yml); fi
if (( with_documents )); then compose_files+=(-f docker-compose.documents.yml); fi
env COMPOSE_PROFILES= CODE_RUNNER_MODE=$code_mode NOTEBOOK_EXECUTION_ENABLED=$notebook_enabled \
  docker compose "${compose_files[@]}" "${args[@]}" logs --follow --tail=200 "$@"
