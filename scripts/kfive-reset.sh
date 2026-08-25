#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

if [[ "${1:-}" != "--delete-data" ]]; then
  echo "Refusing to delete persistent data. Re-run with --delete-data to confirm." >&2
  exit 2
fi

read -r -p "Delete all KFive Docker volumes and persisted data? Type DELETE: " confirmation
if [[ "$confirmation" != "DELETE" ]]; then
  echo "Reset cancelled."
  exit 1
fi

docker compose down --volumes
