#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail() { printf 'release ssh test: %s\n' "$*" >&2; exit 1; }
has()  { printf '%s\n' "$1" | grep -Fq "$2" || fail "output did not contain: $2"; }

bash -n scripts/release.sh

TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
FAKE_BIN=$TEST_ROOT/bin
mkdir -p "$FAKE_BIN" "$TEST_ROOT/home/.ssh"
touch "$TEST_ROOT/home/.ssh/release_key"

cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = api ]; then printf 'ahsanswr\n'; exit 0; fi
exit 0
EOF

cat > "$FAKE_BIN/ssh-agent" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -k ]; then exit 0; fi
printf 'SSH_AUTH_SOCK=%s; export SSH_AUTH_SOCK;\n' "$TEST_ROOT/agent.sock"
printf 'SSH_AGENT_PID=12345; export SSH_AGENT_PID;\n'
EOF

cat > "$FAKE_BIN/ssh-add" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -l ]; then exit 2; fi
printf 'prompt\n' >> "$TEST_ROOT/prompts"
EOF

cat > "$FAKE_BIN/ssh" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = -G ]; then printf 'identityfile %s/home/.ssh/release_key\n' "$TEST_ROOT"; exit 0; fi
printf 'Hi AhsanSarwar45! You have successfully authenticated, but GitHub does not provide shell access.\n' >&2
exit 1
EOF

for name in gh ssh-agent ssh-add ssh; do chmod +x "$FAKE_BIN/$name"; done

# Stop after readiness: that proves a mismatched gh login is not authoritative,
# the publishing key was verified, and the first network call reused its agent.
cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
case "$1 ${2:-} ${3:-}" in
  'remote get-url --push') printf 'git@github.com:AhsanSarwar45/atelier.git\n' ;;
  'symbolic-ref --short HEAD') printf 'ours\n' ;;
  'status --porcelain --untracked-files=no') ;;
  'fetch --quiet origin') printf '%s\n' "$SSH_AUTH_SOCK" >> "$TEST_ROOT/git-agent" ;;
  'merge-base --is-ancestor origin/main') printf '%s\n' "$SSH_AUTH_SOCK" >> "$TEST_ROOT/git-agent"; exit 1 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE_BIN/git"

OUTPUT=$(PATH="$FAKE_BIN:$PATH" HOME="$TEST_ROOT/home" TEST_ROOT="$TEST_ROOT" \
  bash scripts/release.sh 2>&1 || true)

has "$OUTPUT" "AhsanSarwar45 publishing key unlocked for this run"
has "$OUTPUT" "what is online is ahead of this checkout"
[ "$(wc -l < "$TEST_ROOT/prompts")" -eq 1 ] || fail "the publishing key was not requested exactly once"
[ "$(wc -l < "$TEST_ROOT/git-agent")" -eq 2 ] || fail "repeated Git operations did not reuse the agent"
[ "$(sort -u "$TEST_ROOT/git-agent")" = "$TEST_ROOT/agent.sock" ] || fail "Git did not inherit the publishing agent"

printf '0 failures: one publishing-key prompt serves the release\n'
