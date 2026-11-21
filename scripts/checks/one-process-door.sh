#!/usr/bin/env bash
# Every child process the server starts goes through one module,
# server/src/launch. Anything that builds a command anywhere else is listed,
# and the check fails. Test code (from a file's `#[cfg(test)]` on) is not
# counted. Prints the first places wrong and exits 1, or prints ok.
cd "$(dirname "$0")/../.." || exit 1
found=$(
  find server/src -name '*.rs' -not -path 'server/src/launch/*' -not -path 'server/src/launch.rs' -print0 |
    xargs -0 awk '
      FNR == 1 { tests = 0 }
      /^[[:space:]]*#\[cfg\(test\)\]/ { tests = 1 }
      tests { next }
      /^[[:space:]]*\/\// { next }
      /Command::new\(|CommandBuilder::new\(|AcpAgent::new\(/ { print FILENAME ":" FNR }
    '
)
count=$(printf '%s' "$found" | grep -c . || true)
if [ "$count" != 0 ]; then
  echo "WRONG: $count places start a process outside server/src/launch:"
  printf '%s\n' "$found" | head -20
  exit 1
fi
[ -e server/src/launch.rs ] || [ -d server/src/launch ] || { echo "WRONG: there is no server/src/launch"; exit 1; }
echo ok
