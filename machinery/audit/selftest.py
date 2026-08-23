#!/usr/bin/env python3
"""Cases for the three things session-cost.py claims to measure.

Each one is a shape the measure got wrong at least once while it was being
written, so each is here to stop it going wrong again quietly.
"""

import sys

import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("session_cost", Path(__file__).parent / "session-cost.py")
cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cost)

FAILED = []


def check(name, got, want):
    if got != want:
        FAILED.append(f"{name}: wanted {want}, got {got}")


def turn(output=1):
    return {"type": "assistant", "message": {"usage": {"output_tokens": output}, "content": []}}


def asked_for(path, ident="t1"):
    return {"type": "assistant", "message": {"usage": {"output_tokens": 1}, "content": [
        {"type": "tool_use", "id": ident, "name": "Read", "input": {"file_path": path}}]}}


def answered(ident="t1", body="x" * 400):
    return {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": ident, "content": body}]}}


def squashed():
    return {"type": "system", "subtype": "compact_boundary"}


def ran(command):
    return {"type": "assistant", "message": {"usage": {"output_tokens": 1}, "content": [
        {"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": command}}]}}


def started(*entries):
    return {"type": "attachment", "attachment": {
        "type": "hook_additional_context", "hookEvent": "SessionStart", "content": list(entries)}}


# A picture is paid for on every turn it survives, and stops being paid for the
# moment the memory holding it is squashed.
written, carried = cost.pictures_carried(
    [asked_for("/shots/a.png"), answered(), turn(), turn(), squashed(), turn(), turn()])
check("a picture is written in once", written, 100)
check("a picture is carried until the memory is squashed", carried, 200)

# A file that is not a picture costs its one reading and nothing after it.
written, carried = cost.pictures_carried([asked_for("/src/a.ts"), answered(), turn(), turn()])
check("a file that is not a picture is not counted", (written, carried), (0, 0))

# Two rules answering one start is the fault being looked for.
check("a rule registered twice reads as two",
      cost.briefings_a_start([started("... work state lives ...", "... work state lives ...")]), 2)

# A session that is resumed is handed the briefing again, which is correct.
check("a session started twice still reads as one",
      cost.briefings_a_start([
          started("... work state lives ..."), turn(), turn(),
          started("... work state lives ... and now says something else")]), 1)

check("a start that hands over no briefing reads as none",
      cost.briefings_a_start([started("something unrelated")]), 0)

# Slices are counted per file, and only where they are commands.
cut = cost.slices_of([ran("sed -n '1,80p' /src/small.ts"), ran("sed -n '80,160p' /src/small.ts"),
                      ran("cat /src/small.ts")])
check("a slice is counted once per reading", cut.get("/src/small.ts"), 2)
check("reading a file whole is not a slice", len(cut), 1)

cut = cost.slices_of([ran("sed -n 1,80p /src/bare.ts")])
check("a slice written without quotes is still a slice", cut.get("/src/bare.ts"), 1)

if FAILED:
    for line in FAILED:
        print("FAILED  " + line)
    sys.exit(1)
print(f"all {8} cases pass")
