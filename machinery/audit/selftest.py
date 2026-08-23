#!/usr/bin/env python3
"""Cases for the three things session-cost.py claims to measure.

Each one is a shape the measure got wrong at least once while it was being
written, so each is here to stop it going wrong again quietly.
"""

import base64
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


def png(wide, high, tail=b"\x00" * 400):
    """A PNG header saying how big the picture is, as one is really handed over."""
    blob = (b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR"
            + wide.to_bytes(4, "big") + high.to_bytes(4, "big") + tail)
    return [{"type": "image", "source": {
        "type": "base64", "media_type": "image/png",
        "data": base64.b64encode(blob).decode()}}]


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
written, carried, _ = cost.pictures_carried(
    [asked_for("/shots/a.png"), answered(), turn(), turn(), squashed(), turn(), turn()])
check("a picture is written in once", written, 100)
check("a picture is carried until the memory is squashed", carried, 200)

# A file that is not a picture costs its one reading and nothing after it.
written, carried, _ = cost.pictures_carried([asked_for("/src/a.ts"), answered(), turn(), turn()])
check("a file that is not a picture is not counted", (written, carried), (0, 0))

# What a picture costs is read off its pixels, not off how many characters it
# encoded into. The same screenshot compressing twice as well costs the same.
check("a picture costs what its pixels cost", cost.tokens_for(800, 600), 640)
check("a picture over the ceiling is charged the ceiling", cost.tokens_for(1440, 900), 1600)
check("a wide picture is charged after its long edge is brought down",
      cost.tokens_for(3136, 400), 418)
written, carried, blind = cost.pictures_carried(
    [asked_for("/shots/a.png"),
     {"type": "user", "message": {"content": [
         {"type": "tool_result", "tool_use_id": "t1", "content": png(1440, 900)}]}},
     turn(), turn()])
check("a real picture is charged its real cost", written, 1600)
check("a picture whose size can be read is not guessed at", blind, 0)

# A picture nobody can size is charged the most one can cost, and counted, so
# the number is never quietly short.
written, carried, blind = cost.pictures_carried(
    [asked_for("/shots/b.png"),
     {"type": "user", "message": {"content": [
         {"type": "tool_result", "tool_use_id": "t1",
          "content": [{"type": "image", "source": {"type": "base64", "data": "!!!!"}}]}]}},
     turn()])
check("a picture that cannot be sized is charged the ceiling", written, cost.MOST)
check("and is counted as one that could not be sized", blind, 1)

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

cut = cost.slices_of([ran('sed -n "1,80p" /src/quoted.ts')])
check("a slice written in double quotes is still a slice", cut.get("/src/quoted.ts"), 1)

# The gate refuses three shapes of the same habit. A count that saw only one of
# them would read a session moving between them as an improvement.
cut = cost.slices_of([ran("awk 'NR>=1 && NR<=60' /src/awked.ts")])
check("an awk line range is a slice", cut.get("/src/awked.ts"), 1)
check("awk doing something else is not a slice",
      cost.slices_of([ran("awk '{print $1}' /src/awked.ts")]).get("/src/awked.ts"), None)


def read_part(path, ident="r1"):
    return {"type": "assistant", "message": {"usage": {"output_tokens": 1}, "content": [
        {"type": "tool_use", "id": ident, "name": "Read",
         "input": {"file_path": path, "offset": 40, "limit": 20}}]}}


cut = cost.slices_of([read_part("/src/tooled.ts")])
check("part of a file asked for by the reading tool is a slice", cut.get("/src/tooled.ts"), 1)
check("a whole file asked for by the reading tool is not",
      cost.slices_of([asked_for("/src/tooled.ts")]).get("/src/tooled.ts"), None)

# Two files of one name are two different files. Answering with whichever the
# search happened to return first scored a reading against a file nobody read.
import tempfile  # noqa: E402
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    (root / "one").mkdir()
    (root / "two").mkdir()
    (root / "one" / "README.md").write_text("a\n" * 10)
    (root / "two" / "README.md").write_text("b\n" * 900)
    (root / "only.ts").write_text("c\n" * 42)
    lengths = cost.Lengths(root)
    check("a file named by its path is measured where it was named",
          lengths.of("one/README.md"), 10)
    check("the other file of the same name is measured as itself",
          lengths.of("two/README.md"), 900)
    check("a bare name two files wear answers nothing",
          lengths.of("README.md"), None)
    check("a bare name only one file wears still answers",
          lengths.of("only.ts"), 42)

if FAILED:
    for line in FAILED:
        print("FAILED  " + line)
    sys.exit(1)
print(f"all {24} cases pass")
