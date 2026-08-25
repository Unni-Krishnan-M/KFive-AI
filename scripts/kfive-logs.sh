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
    echo "Usage: $0 [--with-code-lab] [SERVICE ...]"
    exit 0
    ;;
esac

if (( with_code_lab )); then
  env COMPOSE_PROFILES= CODE_RUNNER_MODE=container docker compose --profile code-lab logs --follow --tail=200 "$@"
else
  env COMPOSE_PROFILES= CODE_RUNNER_MODE=disabled docker compose logs --follow --tail=200 "$@"
fi
