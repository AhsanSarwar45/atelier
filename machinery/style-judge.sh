#!/usr/bin/env bash
# Blind taste test between two styles. A score can be gamed; an ear cannot.
#
# For every task in every kept run, a fresh session is shown the two replies with
# no idea where either came from, and picks the one that sounds like a person
# said it out loud. Which reply goes first alternates, so a judge that always
# picks the first one scores 50/50 rather than winning.
#
#   bash machinery/style-judge.sh ab-examples ab-rules
set -uo pipefail
A="$1"; B="$2"
RUNS="${STYLE_TRY_RUNS:-$HOME/.cache/atelier/style-runs}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

n=0
for fa in "$RUNS"/*/*."$A".txt; do
  fb="${fa%.$A.txt}.$B.txt"
  [ -f "$fa" ] && [ -f "$fb" ] || continue
  if [ $((n % 2)) -eq 0 ]; then first="$fa"; second="$fb"; order="AB"; else first="$fb"; second="$fa"; order="BA"; fi
  {
    printf 'Two people wrote a reply to their manager about the same thing.\n\n'
    printf 'REPLY ONE\n%s\n\n' "$(cat "$first")"
    printf 'REPLY TWO\n%s\n\n' "$(cat "$second")"
    printf 'Which one sounds like a real person actually said it out loud, rather than a machine writing to sound professional? Answer with exactly one word, ONE or TWO. Nothing else.\n'
  } > "$T/$n.prompt"
  printf '%s\n' "$order" > "$T/$n.order"
  # A neutral judge. Under the style being tested it would be marking its own homework.
  timeout 180 claude -p --settings '{"outputStyle":"default"}' \
    --disallowedTools Bash Edit Write Read Glob Grep Agent Task NotebookEdit WebFetch WebSearch \
    < "$T/$n.prompt" > "$T/$n.out" 2>&1 &
  n=$((n+1))
done
wait

a=0; b=0; bad=0
for i in $(seq 0 $((n-1))); do
  pick=$(tr -d ' \n' < "$T/$i.out" | tr '[:lower:]' '[:upper:]')
  order=$(cat "$T/$i.order")
  case "$pick$order" in
    ONEAB|TWOBA) a=$((a+1));;
    TWOAB|ONEBA) b=$((b+1));;
    *) bad=$((bad+1));;
  esac
done
printf '\n\033[1m──── blind taste test ────\033[0m\n'
printf '  %d pairs, order alternated\n\n' "$n"
printf '  %-14s %2d\n  %-14s %2d\n' "$A" "$a" "$B" "$b"
[ "$bad" -gt 0 ] && printf '  %-14s %2d\n' "no answer" "$bad"
printf '\n'
