#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

echo "KFive development diagnostics"
node --version
npm --version
docker compose version 2>/dev/null || echo "Docker Compose unavailable"

if [[ -f backend/.env ]]; then
  echo "backend/.env: present"
else
  echo "backend/.env: missing; copy backend/.env.example and replace placeholders"
fi

if curl --fail --silent --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Ollama: reachable"
else
  echo "Ollama: unreachable (only required for an Ollama provider)"
fi

echo "No global packages, system software, or Git hooks were modified."
