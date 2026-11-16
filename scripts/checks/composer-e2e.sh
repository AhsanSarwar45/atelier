#!/usr/bin/env bash
# Runs one e2e spec on its own disposable stack: two free ports probed just
# before start and a run directory of its own, removed afterwards.
# Usage: scripts/checks/composer-e2e.sh <spec> [playwright arguments]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
free_port() {
  python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}
BEADS_WEB_PORT="$(free_port)"
BEADS_WORKBENCH_PORT="$(free_port)"
while [ "$BEADS_WORKBENCH_PORT" = "$BEADS_WEB_PORT" ]; do BEADS_WORKBENCH_PORT="$(free_port)"; done
export BEADS_WEB_PORT BEADS_WORKBENCH_PORT ATELIER_PORT="$BEADS_WEB_PORT"
# Linuxbrew's pkg-config finds an OpenSSL that openssl-sys refuses; the
# system one finds the supported version.
[ -x /usr/bin/pkg-config ] && export PKG_CONFIG="${PKG_CONFIG:-/usr/bin/pkg-config}"
export WORKBENCH_E2E_RUN="$ROOT/tests/.e2e-run-check-$$"
trap 'rm -rf "$WORKBENCH_E2E_RUN"' EXIT
"$ROOT/scripts/workbench-e2e.sh" "$@"
