#!/bin/sh
# `atelier case ID -- CMD...` runs CMD and prints one line,
# `CASE ID PASS - -` or `CASE ID FAIL - -`, exiting with CMD's code.
# Prints the first thing wrong and exits 1, or prints ok.
cd "$(dirname "$0")/../.." || exit 1
PKG_CONFIG=/usr/bin/pkg-config cargo build -q --manifest-path server/Cargo.toml 2>&1 | tail -5
bin="${CARGO_TARGET_DIR:-server/target}/debug/atelier"
id=camera/glare/gpu/dark-room
out=$("$bin" case "$id" -- sh -c 'echo working; exit 0' 2>&1); code=$?
[ "$code" = 0 ] || { echo "WRONG: a passing command exits $code: $out"; exit 1; }
[ "$(printf '%s\n' "$out" | grep -c '^CASE ')" = 1 ] || { echo "WRONG: want one CASE line, got: $out"; exit 1; }
printf '%s\n' "$out" | grep -qx "CASE $id PASS - -" || { echo "WRONG: no 'CASE $id PASS - -' line in: $out"; exit 1; }
out=$("$bin" case "$id" -- sh -c 'echo CASE $0 PASS - -; exit 3' 2>&1); code=$?
[ "$code" = 3 ] || { echo "WRONG: a failing command exits $code, not 3: $out"; exit 1; }
printf '%s\n' "$out" | grep -qx "CASE $id FAIL - -" || { echo "WRONG: no 'CASE $id FAIL - -' line in: $out"; exit 1; }
[ "$(printf '%s\n' "$out" | grep -c '^CASE ')" = 1 ] || { echo "WRONG: the command's own CASE line was not hidden: $out"; exit 1; }
out=$("$bin" case "Not An Id" -- true 2>&1); code=$?
[ "$code" != 0 ] || { echo "WRONG: a bad case id was accepted: $out"; exit 1; }
echo ok
