#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$repo_dir"

command -v node >/dev/null || { echo "Node.js 22+ is required." >&2; exit 1; }
node_major=$(node --version | sed 's/^v//' | cut -d. -f1)
(( node_major >= 22 )) || { echo "Node.js 22+ is required; found $(node --version)." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "Docker Compose: available"
else
  echo "Docker Compose: unavailable (required for the full local stack)"
fi

if command -v ollama >/dev/null; then
  echo "Ollama: available"
else
  echo "Ollama: unavailable (install it manually only if using local Ollama)"
fi

npm install

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Replace every required placeholder before starting KFive."
else
  echo "Existing .env preserved."
fi

echo "Setup complete. Run npm test && npm run build, then ./scripts/kfive-up.sh."
