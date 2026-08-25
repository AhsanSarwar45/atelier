#!/usr/bin/env bash
# Pool every kept run into one text per style and score them together.
#
# A single run is four replies, about 350 words. That is far too small to tell
# two styles apart: the same style scored 15.5 and 27.8 on two runs. Pooling
# several runs gets each style past 1000 words, which is the length Biber's
# reference figures were built on.
#
#   bash machinery/style-pool.sh ab-examples ab-rules ab-rules2
set -uo pipefail
RUNS="${STYLE_TRY_RUNS:-$HOME/.cache/atelier/style-runs}"
POOL=$(mktemp -d); trap 'rm -rf "$POOL"' EXIT

for s in "$@"; do
  n=0
  for f in "$RUNS"/*/*."$s".txt; do
    [ -f "$f" ] || continue
    cat "$f" >> "$POOL/$s.txt"; printf '\n\n' >> "$POOL/$s.txt"; n=$((n+1))
  done
  printf '%-14s %2d replies, %5d words\n' "$s" "$n" "$(wc -w < "$POOL/$s.txt")"
done
cp "$(dirname "$0")/style-controls/"CONTROL-*.txt "$POOL/"
"$(dirname "$0")/style-score.py" "$POOL"
