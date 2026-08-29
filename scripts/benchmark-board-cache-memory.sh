#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHANGE="${BOARD_MEMORY_CHANGE:-48e0a7d0a98560f59481f7acedabbd6fca394e32}"
BASELINE="$(git -C "$ROOT" rev-parse "${CHANGE}^")"
SAMPLES="${BOARD_MEMORY_SAMPLES:-9}"
RUN="$(mktemp -d /tmp/atelier-board-memory.XXXXXX)"
trap 'rm -rf "$RUN"' EXIT

build() {
  local revision="$1"
  local label="$2"
  mkdir -p "$RUN/$label/source"
  git -C "$ROOT" archive "$revision" | tar -x -C "$RUN/$label/source"
  CCACHE_DISABLE=1 cargo build --release --manifest-path "$RUN/$label/source/server/Cargo.toml" --target-dir "$ROOT/target/board-memory-benchmark" >/dev/null
  cp "$ROOT/target/board-memory-benchmark/release/atelier" "$RUN/$label/atelier"
}

median() {
  jq -r "$1" "$2" | sort -n | awk '{ values[NR]=$1 } END { if (NR % 2) print values[(NR+1)/2]; else print (values[NR/2]+values[NR/2+1])/2 }'
}

build "$BASELINE" baseline
build "$CHANGE" current
BOARD_MEMORY_FIXTURE_ROOT="$ROOT/tests" node "$ROOT/scripts/benchmark-board-cache-memory.mjs" "$RUN/baseline/atelier" baseline "$SAMPLES" > "$RUN/baseline.json"
BOARD_MEMORY_FIXTURE_ROOT="$ROOT/tests" node "$ROOT/scripts/benchmark-board-cache-memory.mjs" "$RUN/current/atelier" current "$SAMPLES" > "$RUN/current.json"

baseline_retained="$(median '.samples[].retained_mib' "$RUN/baseline.json")"
current_retained="$(median '.samples[].retained_mib' "$RUN/current.json")"
baseline_workload="$(median '.samples[].workload_mib' "$RUN/baseline.json")"
current_workload="$(median '.samples[].workload_mib' "$RUN/current.json")"
baseline_peak="$(median '.samples[].peak_mib' "$RUN/baseline.json")"
current_peak="$(median '.samples[].peak_mib' "$RUN/current.json")"

jq -n --arg baseline "$BASELINE" --arg current "$CHANGE" --argjson samples "$SAMPLES" \
  --argjson boards 8 --argjson cards 3168 --argjson cached_reads 8 \
  --argjson baseline_retained "$baseline_retained" --argjson current_retained "$current_retained" \
  --argjson baseline_workload "$baseline_workload" --argjson current_workload "$current_workload" \
  --argjson baseline_peak "$baseline_peak" --argjson current_peak "$current_peak" \
  --slurpfile baseline_samples "$RUN/baseline.json" --slurpfile current_samples "$RUN/current.json" \
  '{revisions:{baseline:$baseline,current:$current},workload:{samples_per_revision:$samples,boards:$boards,cards_per_board:$cards,cached_reads:$cached_reads},median_mib:{retained:{baseline:$baseline_retained,current:$current_retained,delta:($current_retained-$baseline_retained),percent:(($current_retained-$baseline_retained)/$baseline_retained*100)},workload_over_idle:{baseline:$baseline_workload,current:$current_workload,delta:($current_workload-$baseline_workload),percent:(($current_workload-$baseline_workload)/$baseline_workload*100)},peak:{baseline:$baseline_peak,current:$current_peak,delta:($current_peak-$baseline_peak),percent:(($current_peak-$baseline_peak)/$baseline_peak*100)}},raw:{baseline:$baseline_samples[0].samples,current:$current_samples[0].samples}}'
