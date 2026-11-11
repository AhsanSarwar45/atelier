#!/usr/bin/env bash
set -uo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
PORT="${PORT:-3008}"
BASE_URL="http://localhost:${PORT}"
SERVER_BIN="/app/server/target/release/atelier"
PASSED=0
FAILED=0
SERVER_PID=""
PROJECT_DIR=""

# ── Helpers ────────────────────────────────────────────────────────────────────

cleanup() {
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [[ -n "$PROJECT_DIR" && -d "$PROJECT_DIR" ]]; then
        rm -rf "$PROJECT_DIR"
    fi
}
trap cleanup EXIT

pass() {
    local name="$1"
    PASSED=$((PASSED + 1))
    echo "  PASS: $name"
}

fail() {
    local name="$1"
    shift
    FAILED=$((FAILED + 1))
    echo "  FAIL: $name — $*"
}

# assert_status TEST_NAME ACTUAL EXPECTED
assert_status() {
    local name="$1" actual="$2" expected="$3"
    if [[ "$actual" == "$expected" ]]; then
        pass "$name"
    else
        fail "$name" "expected HTTP $expected, got $actual"
    fi
}

# ── Setup: create a temporary git repo ────────────────────────────────────────

echo "=== Setting up test project ==="
PROJECT_DIR="$HOME/atelier-integration-test-$$"
mkdir -p "$PROJECT_DIR"
echo "  Project dir: $PROJECT_DIR"

cd "$PROJECT_DIR"
git init
git config user.email "test@test.com"
git config user.name "Test"
echo "test" > README.md
git add -A
git commit -m "init"

# ── Start server ──────────────────────────────────────────────────────────────

echo "=== Starting atelier on port $PORT ==="

PORT="$PORT" "$SERVER_BIN" &
SERVER_PID=$!
sleep 2

# Verify server is running
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "FATAL: Server failed to start"
    exit 1
fi
echo "  Server running (PID $SERVER_PID)"

# ── Tests ─────────────────────────────────────────────────────────────────────

echo ""
echo "=== Running integration tests ==="

# Test 1: GET /api/projects returns list
test_1_list_projects() {
    local name="GET /api/projects returns project list"
    local status
    status=$(curl -s -o /tmp/t1.json -w "%{http_code}" "${BASE_URL}/api/projects")
    assert_status "$name" "$status" "200"
}

# Test 2: POST /api/projects — add project
test_2_add_project() {
    local name="POST /api/projects adds project"
    local status
    status=$(curl -s -o /tmp/t2.json -w "%{http_code}" \
        -X POST "${BASE_URL}/api/projects" \
        -H "Content-Type: application/json" \
        -d "{\"name\":\"Integration Test Project\",\"path\":\"${PROJECT_DIR}\"}")
    if [[ "$status" == "200" || "$status" == "201" ]]; then
        pass "$name"
    else
        local body=$(cat /tmp/t2.json 2>/dev/null || echo "no body")
        fail "$name" "expected HTTP 200/201, got $status — $body"
    fi
}

# Test 3: Archive project
test_3_archive_project() {
    local name="PATCH archive project"
    # Get project ID from the add response
    local project_id
    project_id=$(python3 -c "import json; print(json.load(open('/tmp/t2.json')).get('id',''))" 2>/dev/null || echo "")
    if [[ -z "$project_id" ]]; then
        fail "$name" "no project ID from test 2"
        return
    fi
    local status
    status=$(curl -s -o /tmp/t3.json -w "%{http_code}" \
        -X PATCH "${BASE_URL}/api/projects/${project_id}/archive")
    if [[ "$status" == "200" || "$status" == "204" ]]; then
        pass "$name"
    else
        fail "$name" "expected HTTP 200 or 204, got $status"
    fi
}

# Test 4: Archived project hidden from default list
test_4_archived_hidden() {
    local name="Archived project hidden from default list"
    local status
    status=$(curl -s -o /tmp/t4.json -w "%{http_code}" "${BASE_URL}/api/projects")
    if [[ "$status" != "200" ]]; then
        fail "$name" "expected HTTP 200, got $status"
        return
    fi
    local result
    result=$(python3 -c "
import json, sys
with open('/tmp/t4.json') as f:
    projects = json.load(f)
names = [p.get('name','') for p in projects]
if 'Integration Test Project' in names:
    print('archived project still visible', file=sys.stderr)
    sys.exit(1)
" 2>&1)
    if [[ $? -eq 0 ]]; then
        pass "$name"
    else
        fail "$name" "$result"
    fi
}

# Test 5: Unarchive project
test_5_unarchive_project() {
    local name="PATCH unarchive project"
    local project_id
    project_id=$(python3 -c "import json; print(json.load(open('/tmp/t2.json')).get('id',''))" 2>/dev/null || echo "")
    if [[ -z "$project_id" ]]; then
        fail "$name" "no project ID"
        return
    fi
    local status
    status=$(curl -s -o /tmp/t5.json -w "%{http_code}" \
        -X PATCH "${BASE_URL}/api/projects/${project_id}/unarchive")
    if [[ "$status" == "200" || "$status" == "204" ]]; then
        pass "$name"
    else
        fail "$name" "expected HTTP 200 or 204, got $status"
    fi
}

# ── Run all tests ─────────────────────────────────────────────────────────────

test_1_list_projects
test_2_add_project
test_3_archive_project
test_4_archived_hidden
test_5_unarchive_project

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results ==="
TOTAL=$((PASSED + FAILED))
echo "  $PASSED passed, $FAILED failed (out of $TOTAL)"

if [[ "$FAILED" -gt 0 ]]; then
    exit 1
fi
echo "  All tests passed!"
exit 0
