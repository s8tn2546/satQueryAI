#!/usr/bin/env bash
set -euo pipefail

# SatQuery AI orchestrated smoke test (Agent M6 integration milestone).
# Builds and starts the full stack (mongodb + ml + backend), verifies both
# service healthchecks, and reports stack status. Optionally runs a live
# query round-trip when LLM_API_KEY is available (root .env or environment).
#
# Requires a running Docker engine with the Docker Compose v2 plugin.

cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker engine is not available. Cannot run the orchestrated smoke test." >&2
  echo "Install/start Docker Desktop (or a remote engine) and retry." >&2
  exit 2
fi

echo "[1/4] Building and starting stack (mongodb, ml, backend)..."
docker compose up -d --build --wait

cleanup() {
  echo
  echo "[cleanup] Tearing down stack..."
  docker compose down
}
trap cleanup EXIT

echo "[2/4] Health checks..."
backend_health="$(curl -fsS http://localhost:5000/health)"
ml_health="$(curl -fsS http://localhost:8000/health)"
echo "  backend /health -> $backend_health"
echo "  ml      /health -> $ml_health"
[[ "$backend_health" == *'"status": "ok"'* ]] || { echo "backend unhealthy" >&2; exit 1; }
[[ "$ml_health" == *'"status": "ok"'* ]] || { echo "ml unhealthy" >&2; exit 1; }

echo "[3/4] Stack status:"
docker compose ps

if [[ -z "${LLM_API_KEY:-}" ]]; then
  echo "[4/4] Skipping live /api/query round-trip (LLM_API_KEY not set)."
  echo "      Set LLM_API_KEY in root .env to exercise full inference in the smoke test."
else
  echo "[4/4] Running live query round-trip..."
  resp="$(curl -fsS -X POST http://localhost:5000/api/query \
    -H 'Content-Type: application/json' \
    -d '{"queryText":"List the supported tasks.","imageRefs":[],"sessionId":"smoke-session"}')"
  echo "  /api/query -> $resp"
  [[ "$resp" == *'"status"'* ]] || { echo "query round-trip failed" >&2; exit 1; }
fi

echo
echo "Orchestrated smoke test PASSED."