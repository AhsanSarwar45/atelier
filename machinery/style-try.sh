#!/usr/bin/env bash
# Put a candidate output style in front of a fresh session and print what it writes.
#
# A style file is judged by the replies it produces, not by reading the file and
# liking it. Four tasks, each the kind of thing the manager actually asks for:
# a finished piece of work, a day that produced nothing, a delivery with something
# dropped, and a question with no answer yet.
#
#   bash machinery/style-try.sh                  the style in settings today
#   bash machinery/style-try.sh manager          one named style
#   bash machinery/style-try.sh manager ab-showing   two, side by side
#
# A style name is a file in .claude/output-styles/ or ~/.claude/output-styles/.
set -uo pipefail

STYLES=("$@")
if [ ${#STYLES[@]} -eq 0 ]; then
  STYLES=("$(python3 - <<'PY'
import json, os
for p in (".claude/settings.json", os.path.expanduser("~/.claude/settings.json")):
    try:
        s = json.load(open(p)).get("outputStyle")
        if s: print(s); break
    except Exception: pass
PY
)")
fi

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

declare -a TASKS=(
"Run no tools. You just finished this work; report it to your manager in chat. You cached the test fixture load and the suite went from 46 seconds to 8. Two tests still fail on Windows because of a path separator. You also noticed the CI pins an old Node version, which you did not fix."
"Run no tools. Tell your manager: you spent the day trying to make the image export faster and got nowhere. You tried three approaches and all three were slower than what we have. You think the bottleneck is the encoder library itself, which we do not control."
"Run no tools. Tell your manager: the new signup screen is done and on staging. It works on phones. You had to drop the social login button because the provider changed their API last month and it needs a rewrite you estimate at two days."
'Run no tools. Your manager asked "why is the dashboard slow". Answer them.'
)
declare -a NAMES=("finished work" "a day with nothing to show" "delivered, one thing dropped" "a question you cannot answer yet")

for i in "${!TASKS[@]}"; do
  for s in "${STYLES[@]}"; do
    # No tools. These are writing tests, and a test agent that can reach the
    # board files real cards off a made-up scenario. One did: bw-n6wq, cancelled.
    timeout 240 claude -p --settings "{\"outputStyle\":\"$s\"}" \
      --disallowedTools "Bash,Edit,Write,Read,Glob,Grep,Agent,Task,NotebookEdit,WebFetch,WebSearch" \
      "${TASKS[$i]}" \
      > "$OUT/$i.$s.txt" 2>&1 &
  done
done
wait

for i in "${!TASKS[@]}"; do
  printf '\n\033[1m════ %s ════\033[0m\n' "${NAMES[$i]}"
  for s in "${STYLES[@]}"; do
    printf '\n\033[1m── %s ──\033[0m\n' "$s"
    cat "$OUT/$i.$s.txt"
  done
done
printf '\n'
