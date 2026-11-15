#!/usr/bin/env bash
# Runs one test of workflow-runs.spec.ts on its own stack: two free
# ports and a run folder of its own, so checks never share the owner's app.
#   tests/e2e/workflow-runs.sh 'test name'
set -euo pipefail
# Linuxbrew's OpenSSL 4 is too new for openssl-sys; the system one builds.
if [ -z "${PKG_CONFIG:-}" ] && [ -x /usr/bin/pkg-config ]; then export PKG_CONFIG=/usr/bin/pkg-config; fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
read -r web helper <<<"$(python3 - <<'PY'
import socket
held = [socket.socket() for _ in range(2)]
for sock in held:
    sock.bind(("127.0.0.1", 0))
print(*(sock.getsockname()[1] for sock in held))
for sock in held:
    sock.close()
PY
)"
export BEADS_E2E_ACP_ADAPTERS="$ROOT/tests/fixtures/acp-adapters"
export BEADS_WEB_PORT="$web" ATELIER_PORT="$web" BEADS_WORKBENCH_PORT="$helper"
export WORKBENCH_E2E_RUN="$ROOT/tests/.e2e-run-wfruns-$web"
trap 'rm -rf "$WORKBENCH_E2E_RUN"' EXIT
"$ROOT/scripts/workbench-e2e.sh" tests/e2e/workflow-runs.spec.ts -g "$1"
