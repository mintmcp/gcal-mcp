#!/usr/bin/env bash
# Smoke test for the gcal-mcp Docker image.
# Builds the image, boots it on a Docker-assigned ephemeral host port, and
# asserts that:
#   - /healthz returns 200 with {"status":"ok"}
#   - POST /mcp `initialize` returns a protocolVersion
#   - POST /mcp `tools/list` lists exactly 6 tools
#   - POST /mcp `tools/call list_calendars` with a fake bearer token returns
#     a structured error (not a 5xx crash) and the container is still alive.
#
# Requires: bash >=4, docker, curl, python3. No other dependencies.
# Exits 0 on full pass, 1 on the first failure.

set -euo pipefail

IMAGE_TAG="gcal-mcp:smoke"
CONTAINER_NAME="gcal-mcp-smoke-$$"

red()    { printf '\033[31m%s\033[0m\n' "$1" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$1"; }
step()   { printf '\n=== %s ===\n' "$1"; }

cleanup() {
  local code=$?
  if docker ps -aq --filter "name=^/${CONTAINER_NAME}$" | grep -q .; then
    docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  fi
  if [ "${code}" -ne 0 ]; then
    red "smoke test FAILED (exit ${code})"
  fi
  exit "${code}"
}
trap cleanup EXIT

step "Building image ${IMAGE_TAG}"
docker build -t "${IMAGE_TAG}" .

step "Starting container ${CONTAINER_NAME} (Docker-assigned loopback port)"
# Bind only to 127.0.0.1 and let Docker pick a free ephemeral port — avoids
# host-port races and never exposes the test server to the network.
docker run --rm -d \
  --name "${CONTAINER_NAME}" \
  -p "127.0.0.1::8000" \
  -e PORT=8000 \
  "${IMAGE_TAG}" >/dev/null

# Resolve the assigned host port. `docker port` output looks like:
#   8000/tcp -> 127.0.0.1:55321
HOST_PORT=$(docker port "${CONTAINER_NAME}" 8000/tcp | head -n 1 | awk -F: '{print $NF}')
if [ -z "${HOST_PORT}" ]; then
  red "could not resolve host port for container ${CONTAINER_NAME}"
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi
BASE_URL="http://127.0.0.1:${HOST_PORT}"
echo "container reachable at ${BASE_URL}"

# Wait up to 30s for /healthz to come up.
step "Waiting for /healthz"
for i in $(seq 1 60); do
  if curl -fsS "${BASE_URL}/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if [ "${i}" -eq 60 ]; then
    red "healthz never came up"
    docker logs "${CONTAINER_NAME}" >&2 || true
    exit 1
  fi
done

step "Assert /healthz body"
HEALTH_BODY=$(curl -fsS "${BASE_URL}/healthz")
if [ "${HEALTH_BODY}" != '{"status":"ok"}' ]; then
  red "unexpected /healthz body: ${HEALTH_BODY}"
  exit 1
fi
green "/healthz OK"

# Tolerant POST: captures both HTTP status and body separately, so we can
# inspect non-2xx responses instead of silently failing. Echoes "<status>|<body>".
# The body is the parsed jsonrpc envelope (handling SSE 'data:' frames).
post_mcp_tolerant() {
  local body="$1"
  local out
  out=$(mktemp)
  local http_code
  http_code=$(curl -sS -o "${out}" -w '%{http_code}' \
    -X POST "${BASE_URL}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer fake-token" \
    -d "${body}")
  local raw
  raw=$(cat "${out}")
  rm -f "${out}"
  # Extract JSON from SSE if needed.
  local payload
  payload=$(printf '%s' "${raw}" | python3 -c '
import sys
raw = sys.stdin.read()
for line in raw.splitlines():
    if line.startswith("data:"):
        print(line[5:].strip())
        sys.exit(0)
print(raw)
')
  printf '%s|%s' "${http_code}" "${payload}"
}

parse_envelope() {
  # Validate that the payload is JSON. Echo it back; non-JSON → empty.
  python3 -c '
import sys, json
try:
    json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)
' >/dev/null 2>&1 <<<"$1" && printf '%s' "$1"
}

step "POST /mcp initialize"
RESP=$(post_mcp_tolerant '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
STATUS="${RESP%%|*}"
PAYLOAD="${RESP#*|}"
if [ "${STATUS}" != "200" ]; then
  red "initialize returned HTTP ${STATUS}: ${PAYLOAD}"
  exit 1
fi
PROTO=$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",{}).get("protocolVersion",""))' 2>/dev/null || true)
if [ -z "${PROTO}" ]; then
  red "initialize did not return protocolVersion: ${PAYLOAD}"
  exit 1
fi
green "initialize OK (protocolVersion=${PROTO})"

step "POST /mcp tools/list"
RESP=$(post_mcp_tolerant '{"jsonrpc":"2.0","method":"tools/list","id":2,"params":{}}')
STATUS="${RESP%%|*}"
PAYLOAD="${RESP#*|}"
if [ "${STATUS}" != "200" ]; then
  red "tools/list returned HTTP ${STATUS}: ${PAYLOAD}"
  exit 1
fi
TOOL_COUNT=$(printf '%s' "${PAYLOAD}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("result",{}).get("tools",[])))' 2>/dev/null || echo 0)
if [ "${TOOL_COUNT}" != "6" ]; then
  red "expected 6 tools, got ${TOOL_COUNT}. Response: ${PAYLOAD}"
  exit 1
fi
green "tools/list OK (6 tools)"

step "POST /mcp tools/call list_calendars (fake token)"
RESP=$(post_mcp_tolerant '{"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"list_calendars","arguments":{}}}')
STATUS="${RESP%%|*}"
PAYLOAD="${RESP#*|}"
# Accept any well-formed, non-5xx response. The contract under test is:
# "tools/call with a fake bearer token must not crash the server (5xx)".
# Both a jsonrpc.error envelope and result.isError=true count as success.
if [ "${STATUS}" -ge 500 ]; then
  red "tools/call returned HTTP ${STATUS} (crash): ${PAYLOAD}"
  exit 1
fi
VALIDATED=$(parse_envelope "${PAYLOAD}" || true)
if [ -z "${VALIDATED}" ]; then
  red "tools/call returned non-JSON body (HTTP ${STATUS}): ${PAYLOAD}"
  exit 1
fi
IS_STRUCTURED_ERROR=$(printf '%s' "${VALIDATED}" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    print("yes")
elif d.get("result", {}).get("isError") is True:
    print("yes")
else:
    print("no")
')
if [ "${IS_STRUCTURED_ERROR}" != "yes" ]; then
  red "tools/call with fake token did not return a structured error (HTTP ${STATUS}): ${VALIDATED}"
  exit 1
fi
green "tools/call surfaced a structured error (HTTP ${STATUS}, no crash)"

step "Assert container is still running"
if ! docker ps --filter "name=^/${CONTAINER_NAME}$" --filter "status=running" -q | grep -q .; then
  red "container is no longer running"
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi
green "container still running"

green ""
green "smoke test PASSED"
