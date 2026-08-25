#!/usr/bin/env bash
set -euo pipefail

api_base_url=${API_BASE_URL:-http://127.0.0.1:5000/api/v1}
test_suffix=$(date +%s)
email="kfive-smoke-${test_suffix}@example.invalid"
username="kfive_smoke_${test_suffix}"
password=${KFIVE_TEST_PASSWORD:-KFive-Smoke-Test-Password-42}

curl --fail --silent --show-error "${api_base_url}/health" >/dev/null

register_response=$(curl --fail --silent --show-error \
  --request POST "${api_base_url}/auth/register" \
  --header 'Content-Type: application/json' \
  --data "{\"email\":\"${email}\",\"username\":\"${username}\",\"password\":\"${password}\"}")

login_response=$(curl --fail --silent --show-error \
  --request POST "${api_base_url}/auth/login" \
  --header 'Content-Type: application/json' \
  --data "{\"email\":\"${email}\",\"password\":\"${password}\"}")

node -e "const r=JSON.parse(process.argv[1]); if(!r.success || !r.data?.accessToken) process.exit(1)" "$register_response"
node -e "const r=JSON.parse(process.argv[1]); if(!r.success || !r.data?.accessToken) process.exit(1)" "$login_response"
echo "Authentication smoke test passed for a newly created test user."
