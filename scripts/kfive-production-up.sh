#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"

env_file=${1:-.env.production}
if [[ ! -f $env_file ]]; then
  echo "Missing production environment file: $env_file" >&2
  echo "Copy .env.production.example to a private mode-0600 file and replace every placeholder." >&2
  exit 1
fi

permissions=$(stat -c '%a' -- "$env_file")
if [[ $permissions != 600 ]]; then
  echo "Production environment file must have mode 0600; found $permissions." >&2
  exit 1
fi

node scripts/production-environment.cjs --env-file "$env_file"
docker compose --env-file "$env_file" -f docker-compose.production.yml config --quiet
docker compose --env-file "$env_file" -f docker-compose.production.yml pull
docker compose --env-file "$env_file" -f docker-compose.production.yml up -d --wait
docker compose --env-file "$env_file" -f docker-compose.production.yml ps
