#!/usr/bin/env bash
# What the server learned once it does not read again.
#
# Each test here holds one answer the server used to work out afresh every
# time it was asked, from the disk: which chats are busy and what each last
# said (from every chat's events), which repository a folder is in and
# whether a task's commits are merged (a git process each), and the list of
# Codex threads (the whole state database). Each now reads only what changed.
#
# The check fails unless every one of them ran and passed, so a test that is
# renamed or removed is noticed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PKG_CONFIG="${PKG_CONFIG:-/usr/bin/pkg-config}"

TESTS=(
  workbench_core_active_chats_read_only_the_newest_state_of_each
  an_older_store_learns_what_each_chat_last_said
  workbench_core_session_activities_read_only_the_latest_state
  a_folders_repository_is_kept_until_its_git_entry_changes
  only_the_codex_threads_that_changed_are_read_again
  a_merged_commit_is_not_asked_about_again_when_the_base_moves_forward
)

cd "$ROOT/server"
out="$(cargo test --lib -- "${TESTS[@]}" 2>&1)" || { echo "$out" | tail -n 40; echo "WRONG: a test that proves nothing is read twice failed"; exit 1; }
passed=0
for name in "${TESTS[@]}"; do
  if grep -qE "::${name} \.\.\. ok$" <<<"$out"; then
    passed=$((passed + 1))
  else
    echo "did not run: $name"
  fi
done
echo "$passed of ${#TESTS[@]} tests ran and passed"
if [ "$passed" -ne "${#TESTS[@]}" ]; then
  echo "WRONG: only $passed of ${#TESTS[@]} tests that prove nothing is read twice ran"
  exit 1
fi
echo ok
