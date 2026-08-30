#!/usr/bin/env bash
# Prove the installed Rust runtime and both provider transports on a machine
# with Node, npm, Python and python3 absent. Provider programs are deterministic
# Rust test fixtures; the production Atelier binary, routes, database actor and
# process supervisors are the same ones shipped to users.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"
BASE="${IMAGE:-fedora:43}"
TARGET="${CARGO_TARGET_DIR:-$REPO/server/target}"
failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
say() { printf '\n%s\n' "$*"; }

say "Fresh machine prerequisites"
command -v docker >/dev/null 2>&1 || { fail "docker is not installed"; exit 1; }
docker info >/dev/null 2>&1 || { fail "docker daemon does not answer"; exit 1; }
pass "docker answers"

BINARY="${ATELIER_BINARY:-$TARGET/release/atelier}"
if [ ! -x "$BINARY" ]; then
  fail "no release binary at $BINARY"
  exit 1
fi
pass "release binary: $BINARY"

# The transport fixtures live in the Rust test executable. Find the executable
# by behavior rather than its Cargo hash, which changes on every dependency set.
FIXTURE="${ATELIER_PROVIDER_FIXTURE:-}"
if [ -z "$FIXTURE" ]; then
  for candidate in $(ls -t "$TARGET"/debug/deps/atelier-* 2>/dev/null); do
    [ -x "$candidate" ] || continue
    if grep -aq 'CLAUDE_NATIVE_STREAM' "$candidate" &&
       grep -aq 'CODEX_NATIVE_STREAM' "$candidate" &&
       "$candidate" --list 2>/dev/null | grep -q 'native_claude_fake_program'; then
      FIXTURE="$candidate"
      break
    fi
  done
fi
if [ -z "$FIXTURE" ] || [ ! -x "$FIXTURE" ]; then
  fail "no Rust provider fixture; run cargo test --manifest-path server/Cargo.toml --no-run"
  exit 1
fi
pass "Rust provider fixture: $(basename "$FIXTURE")"

BD="$(command -v bd 2>/dev/null || true)"
[ -n "$BD" ] && BD="$(readlink -f "$BD")"
[ -x "$BD" ] || { fail "no bd executable to mount"; exit 1; }

say "A git+bd machine with no language runtime"
IMAGE_NAME="atelier-fresh-native"
if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  if printf 'FROM %s\nRUN dnf -y install git-core && rpm -e --nodeps python3 python-unversioned-command || true\nRUN dnf clean all\n' "$BASE" |
      docker build -q -t "$IMAGE_NAME" - >/dev/null 2>&1; then
    pass "built $IMAGE_NAME"
  else
    fail "could not build $IMAGE_NAME"
    exit 1
  fi
else
  pass "$IMAGE_NAME is already built"
fi

RUN="$(mktemp -d "${TMPDIR:-/tmp}/atelier-fresh.XXXXXX")" || exit 1
mkdir -p "$RUN/home" "$RUN/data" "$RUN/project" "$RUN/providers" "$RUN/claude" "$RUN/codex"
chmod 777 "$RUN/home" "$RUN/data" "$RUN/project" "$RUN/claude" "$RUN/codex"
printf '#!/bin/sh\nexport ATELIER_FAKE_CLAUDE=1\nexec /opt/atelier-tests --exact workbench::claude::transport::tests::native_claude_fake_program --nocapture\n' > "$RUN/providers/claude"
printf '#!/bin/sh\nexport ATELIER_FAKE_CODEX=1\nexec /opt/atelier-tests --exact workbench::codex::transport::tests::native_codex_fake_app_server --nocapture\n' > "$RUN/providers/codex"
chmod +x "$RUN/providers/claude" "$RUN/providers/codex"

CONTAINER=""
cleanup() {
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$RUN"
}
trap cleanup EXIT

CONTAINER="$(docker run -d -p 127.0.0.1::3008 \
  -e ATELIER_HOST=0.0.0.0 -e ATELIER_PORT=3008 \
  -e HOME=/fresh/home -e ATELIER_DATA_DIR=/fresh/data \
  -e CLAUDE_CONFIG_DIR=/fresh/claude -e CODEX_HOME=/fresh/codex \
  -e CLAUDE_PATH=/fixtures/claude -e CODEX_PATH=/fixtures/codex \
  -e PATH=/usr/local/bin:/usr/bin:/bin \
  -v "$BINARY":/opt/atelier:ro -v "$FIXTURE":/opt/atelier-tests:ro \
  -v "$RUN/providers":/fixtures:ro -v "$BD":/usr/local/bin/bd:ro \
  -v "$RUN":/fresh "$IMAGE_NAME" /opt/atelier)" || {
    fail "container did not start"; exit 1;
  }
PORT="$(docker port "$CONTAINER" 3008/tcp | sed 's/.*://')"
URL="http://127.0.0.1:$PORT"
ready=0
for _ in $(seq 1 80); do
  if curl -sf "$URL/api/health" >/dev/null; then ready=1; break; fi
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true || break
  sleep 0.25
done
if [ "$ready" != 1 ]; then
  fail "Atelier did not serve: $(docker logs "$CONTAINER" 2>&1 | tail -8 | tr '\n' ' ')"
  exit 1
fi
pass "one Rust binary serves on isolated port $PORT"

missing="$(docker exec "$CONTAINER" /bin/sh -c 'for t in node npm python python3; do command -v "$t" >/dev/null 2>&1 && printf "%s " "$t"; done')"
if [ -z "$missing" ]; then
  pass "node, npm, python and python3 are absent"
else
  fail "unexpected language runtimes are present: $missing"
fi

post() {
  curl -fsS -H 'content-type: application/json' --data "$1" "$URL/api/workbench/command"
}
events() {
  curl -sN --max-time 2 "$URL/api/workbench/events?session=$1&since=0" 2>/dev/null || true
}

exercise() { # brand, session, external, stream marker, approval id
  local brand="$1" id="$2" external="$3" marker="$4" ask="$5" response seen
  say "Native $brand lifecycle"
  response="$(post "{\"type\":\"session.start\",\"sessionId\":\"$id\",\"externalId\":\"$external\",\"brand\":\"$brand\",\"projectId\":\"fresh-project\",\"projectPath\":\"/fresh/project\",\"permissionMode\":\"default\"}" 2>&1)" || {
    fail "$brand start failed: $response"; return;
  }
  pass "$brand starts"
  post "{\"type\":\"prompt.send\",\"sessionId\":\"$id\",\"text\":\"prove the native stream\"}" >/dev/null 2>&1 || fail "$brand prompt failed"
  seen="$(events "$id")"
  if printf '%s' "$seen" | grep -q "$marker"; then
    pass "$brand streams"
  else
    fail "$brand stream marker was absent (events: $(printf '%s' "$seen" | head -c 800 | tr '\n' ' '))"
  fi
  if printf '%s' "$seen" | grep -q "$ask"; then
    post "{\"type\":\"ask.answer\",\"sessionId\":\"$id\",\"askId\":\"$ask\",\"optionId\":\"once\"}" >/dev/null 2>&1 && pass "$brand approval resolves" || fail "$brand approval failed"
  else
    fail "$brand approval was absent"
  fi
  post "{\"type\":\"session.stop\",\"sessionId\":\"$id\"}" >/dev/null 2>&1 && pass "$brand stops" || fail "$brand stop failed"
  post "{\"type\":\"session.close\",\"sessionId\":\"$id\"}" >/dev/null 2>&1 || fail "$brand close failed"
  post "{\"type\":\"session.resume\",\"sessionId\":\"$id\",\"externalId\":\"$external\",\"brand\":\"$brand\",\"projectId\":\"fresh-project\",\"projectPath\":\"/fresh/project\"}" >/dev/null 2>&1 && pass "$brand resumes" || fail "$brand resume failed"
  post "{\"type\":\"session.close\",\"sessionId\":\"$id\"}" >/dev/null 2>&1 || true
}

exercise claude claude-fresh claude-thread CLAUDE_NATIVE_STREAM permission-1
exercise codex codex-fresh codex-thread CODEX_NATIVE_STREAM shell-1

say "$failures failure(s)"
[ "$failures" = 0 ]
