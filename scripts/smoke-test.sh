#!/usr/bin/env bash
# Smoke test for the gcal-mcp Docker image.
# Builds the image, boots it on a random host port, and asserts that:
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

# Pick a random ephemeral host port. awk + srand seeded with $$ gives us a
# portable PRNG without depending on shuf/jot/python.
HOST_PORT=$(awk -v seed="$$" 'BEGIN{srand(seed); print int(49152 + rand() * 16383)}')

BASE_URL="http://127.0.0.1:${HOST_PORT}"

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

step "Starting container ${CONTAINER_NAME} on port ${HOST_PORT}"
docker run --rm -d \
  --name "${CONTAINER_NAME}" \
  -p "${HOST_PORT}:8000" \
  -e PORT=8000 \
  "${IMAGE_TAG}" >/dev/null

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

post_mcp() {
  # $1 = json body to POST. Echoes the parsed response (jsonrpc envelope) on
  # stdout. StreamableHTTPServerTransport may answer with text/event-stream
  # frames; extract the JSON from any 'data: ...' line, or pass plain JSON
  # through.
  local body="$1"
  curl -fsS -X POST "${BASE_URL}/mcp" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer fake-token" \
    -d "${body}" \
    | python3 -c '
import sys, json
raw = sys.stdin.read()
candidate = raw
for line in raw.splitlines():
    if line.startswith("data:"):
        candidate = line[5:].strip()
        break
parsed = json.loads(candidate)
print(json.dumps(parsed))
'
}

step "POST /mcp initialize"
INIT_RESP=$(post_mcp '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}')
PROTO=$(printf '%s' "${INIT_RESP}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("result",{}).get("protocolVersion",""))')
if [ -z "${PROTO}" ]; then
  red "initialize did not return protocolVersion: ${INIT_RESP}"
  exit 1
fi
green "initialize OK (protocolVersion=${PROTO})"

step "POST /mcp tools/list"
TOOLS_RESP=$(post_mcp '{"jsonrpc":"2.0","method":"tools/list","id":2,"params":{}}')
TOOL_COUNT=$(printf '%s' "${TOOLS_RESP}" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d.get("result",{}).get("tools",[])))')
if [ "${TOOL_COUNT}" != "6" ]; then
  red "expected 6 tools, got ${TOOL_COUNT}. Response: ${TOOLS_RESP}"
  exit 1
fi
green "tools/list OK (6 tools)"

step "POST /mcp tools/call list_calendars (fake token)"
CALL_RESP=$(post_mcp '{"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"list_calendars","arguments":{}}}')
# We accept either:
#  - jsonrpc.error (transport-level rejection)
#  - jsonrpc.result.isError === true (tool returned a structured error)
# What we REJECT is a 5xx crash (already caught by curl -f), an empty body,
# or a result that succeeded silently.
IS_STRUCTURED_ERROR=$(printf '%s' "${CALL_RESP}" | python3 -c '
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
  red "tools/call with fake token did not return a structured error: ${CALL_RESP}"
  exit 1
fi
green "tools/call surfaced a structured error (no crash)"

step "Assert container is still running"
if ! docker ps --filter "name=^/${CONTAINER_NAME}$" --filter "status=running" -q | grep -q .; then
  red "container is no longer running"
  docker logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi
green "container still running"

green ""
green "smoke test PASSED"
