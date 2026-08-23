#!/usr/bin/env python3
"""What a session paid to carry its own past, read back out of the transcripts.

Three numbers, because three habits are what the money went on:

  pictures carried   a screenshot read into the conversation is re-read on
                     every later turn until the memory is squashed. Written in
                     once, paid for hundreds of times.
  briefings a start  the opening board briefing, counted per session start. Two
                     means the same rule is registered twice and everything it
                     hands over arrives doubled.
  small files resliced
                     a file short enough to read whole, opened again in another
                     slice. Every repeat is a turn, and a turn is the whole
                     conversation read again.

The numbers this job was opened on are pinned in `baseline.json` beside this
file, so the before is a measurement and not a memory. `--baseline` re-measures
exactly those sessions; it reproducing the pinned numbers is what says the tool
still reads transcripts the way it did the day they were written.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "baseline.json"

# Claude Code writes one transcript per session, under a folder named for the
# project path with every separator turned into a dash.
SESSIONS = Path.home() / ".claude" / "projects"

# A file this long or shorter had no reason to be read in pieces.
SMALL = 800

# `sed -n '120,240p' some/file` — the shape a slice read takes as a command.
SLICE = re.compile(r"sed -n\s+'?(\d+),(\d+)p'?\s+(\S+)")

PICTURE = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp")

# The first line of the board briefing, which is what tells one hook's output
# from another's without depending on how long it happens to be today.
BRIEFING = "work state lives"


def transcripts_for(project: Path) -> Path:
    """The folder holding one project's session transcripts."""
    return SESSIONS / ("-" + str(project).strip("/").replace("/", "-"))


def read(path: Path):
    """Every record in one transcript, skipping anything half-written."""
    with path.open(errors="replace") as fh:
        for line in fh:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def pictures_carried(records) -> tuple[int, int]:
    """Tokens a session's pictures cost: written in once, then carried.

    Returns (written in, carried) — the second is the one that matters, and it
    is the first multiplied by how many turns each picture survived before the
    memory it sat in was squashed.
    """
    turns: list[int] = []
    squashed: list[int] = []
    shots: list[tuple[int, int]] = []  # (turn it arrived on, tokens)
    asked: dict[str, str] = {}
    turn = 0

    for r in records:
        kind = r.get("type")
        if kind == "assistant":
            message = r.get("message") or {}
            used = message.get("usage") or {}
            if (used.get("output_tokens") or 0) > 0 or (used.get("cache_read_input_tokens") or 0) > 0:
                turn += 1
                turns.append(turn)
            for block in message.get("content") or []:
                if isinstance(block, dict) and block.get("type") == "tool_use" and block.get("name") == "Read":
                    asked[block["id"]] = ((block.get("input") or {}).get("file_path") or "")
        elif kind == "user":
            content = (r.get("message") or {}).get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "tool_result":
                        continue
                    where = asked.get(block.get("tool_use_id"))
                    if not where or not where.lower().endswith(PICTURE):
                        continue
                    body = block.get("content")
                    body = body if isinstance(body, str) else json.dumps(body)
                    shots.append((turn, len(body) // 4))
        if r.get("isCompactSummary") or r.get("subtype") == "compact_boundary":
            squashed.append(turn)

    last = turns[-1] if turns else 0
    written = carried = 0
    for arrived, tokens in shots:
        until = min([s for s in squashed if s >= arrived], default=last)
        written += tokens
        carried += tokens * sum(1 for t in turns if arrived < t <= until)
    return written, carried


def briefings_a_start(records) -> int:
    """How many times ONE session start handed over the board briefing.

    One is right. Two says the rule is registered in two settings files and both
    fire, so everything the briefing carries is paid for twice.

    A session that is resumed or squashed starts again and is handed the
    briefing again. That is correct, and it must not read as a doubled rule —
    so the count is taken inside a single start, never across a session. One
    start's hook output arrives as one record holding one entry per rule that
    answered it, and it is those entries that are counted.
    """
    most = 0
    for r in records:
        if r.get("type") != "attachment":
            continue
        hook = r.get("attachment") or {}
        if hook.get("hookEvent") != "SessionStart":
            continue
        body = hook.get("content")
        entries = body if isinstance(body, list) else [body]
        most = max(most, sum(1 for piece in entries if BRIEFING in str(piece)))
    return most


def slices_of(records) -> collections.Counter:
    """Every file a session opened a slice of, and how many times."""
    cut: collections.Counter = collections.Counter()
    for r in records:
        if r.get("type") != "assistant":
            continue
        for block in (r.get("message") or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            if block.get("name") == "Bash":
                for m in SLICE.finditer((block.get("input") or {}).get("command") or ""):
                    cut[m.group(3)] += 1
    return cut


class Lengths:
    """How long a file is, looked up by name and remembered."""

    def __init__(self, root: Path):
        self.root = root
        self.known: dict[str, int | None] = {}

    def of(self, named: str) -> int | None:
        name = os.path.basename(named)
        if name in self.known:
            return self.known[name]
        found = None
        try:
            out = subprocess.run(
                # A checkout cut for one job holds a second copy of every file
                # in it, and measuring against that copy would answer with
                # whatever that job has done to it so far.
                ["find", str(self.root), "-name", name,
                 "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*",
                 "-not", "-path", "*/worktrees/*", "-not", "-path", "*/target/*"],
                capture_output=True, text=True, timeout=30,
            ).stdout.split("\n")
            hits = [x for x in out if x]
            if hits:
                found = int(subprocess.run(["wc", "-l", hits[0]], capture_output=True, text=True).stdout.split()[0])
        except Exception:
            found = None
        self.known[name] = found
        return found


def measure(paths: list[Path], root: Path) -> dict:
    """The three numbers, over a given set of sessions."""
    lengths = Lengths(root)
    carried = written = 0
    doubled = 0
    resliced = 0
    per_session = []

    for path in paths:
        records = list(read(path))
        w, c = pictures_carried(records)
        briefings = briefings_a_start(records)
        again = 0
        for named, times in slices_of(records).items():
            if times < 2:
                continue
            long = lengths.of(named)
            if long is not None and long <= SMALL:
                again += times - 1
        written += w
        carried += c
        doubled = max(doubled, briefings)
        resliced += again
        per_session.append({
            "session": path.name[:8],
            "pictures written in": w,
            "pictures carried": c,
            "briefings a start": briefings,
            "small files resliced": again,
        })

    return {
        "sessions": [p.name for p in paths],
        "pictures carried": carried,
        "pictures written in": written,
        "briefings a start": doubled,
        "small files resliced": resliced,
        "each": per_session,
    }


def pin(found: dict, what: str) -> None:
    """Write down what was just measured, as the before this job is judged against."""
    BASELINE.write_text(json.dumps({
        "what": what or "the sessions this job was opened on",
        "sessions": found["sessions"],
        "pictures carried": found["pictures carried"],
        "pictures written in": found["pictures written in"],
        "briefings a start": found["briefings a start"],
        "small files resliced": found["small files resliced"],
    }, indent=2) + "\n")


def most_recent(folder: Path, count: int, skip: str | None) -> list[Path]:
    """The last N sessions to be written to, newest first, live one left out.

    A session still being written cannot be measured — its pictures have not
    finished being carried — so the one running this is never counted.
    """
    if not folder.is_dir():
        return []
    every = sorted(folder.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if skip:
        every = [p for p in every if not p.name.startswith(skip)]
    return every[:count]


def show(title: str, found: dict, quiet: bool) -> None:
    print(f"{title} — {len(found['sessions'])} sessions")
    print(f"  picture tokens carried in main conversations : {found['pictures carried']:,}")
    print(f"  opening briefings a session start            : {found['briefings a start']}")
    print(f"  repeat slice-reads of files under {SMALL} lines : {found['small files resliced']}")
    if quiet:
        return
    worst = sorted(found["each"], key=lambda s: -s["pictures carried"])
    print()
    print(f"  {'session':10}{'carried':>16}{'briefings':>11}{'resliced':>10}")
    for s in worst:
        print(f"  {s['session']:10}{s['pictures carried']:16,}{s['briefings a start']:11}{s['small files resliced']:10}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--last", type=int, default=5, help="how many of the most recent sessions to read")
    ap.add_argument("--baseline", action="store_true", help="re-measure the pinned sessions instead")
    ap.add_argument("--project", default=None, help="the checkout whose sessions to read")
    ap.add_argument("--record", action="store_true", help="pin what was just measured as the baseline")
    ap.add_argument("--quiet", action="store_true", help="the three numbers and nothing else")
    args = ap.parse_args()

    root = Path(args.project).resolve() if args.project else HERE.parent.parent
    folder = transcripts_for(root)
    pinned = json.loads(BASELINE.read_text()) if BASELINE.is_file() else None

    if args.baseline:
        if not pinned:
            print("nothing is pinned yet; run with --record", file=sys.stderr)
            return 2
        paths = [folder / name for name in pinned["sessions"]]
        missing = [p.name for p in paths if not p.is_file()]
        if missing:
            print(f"{len(missing)} of the pinned sessions are no longer on this computer", file=sys.stderr)
            paths = [p for p in paths if p.is_file()]
        found = measure(paths, root)
        if args.record:
            pin(found, pinned.get("what", ""))
            print(f"re-pinned {len(found['sessions'])} sessions in {BASELINE}")
            return 0
        show("Pinned sessions, re-measured", found, args.quiet)
        print()
        agrees = all(found[k] == pinned[k] for k in ("pictures carried", "briefings a start", "small files resliced"))
        if missing:
            print("cannot be compared: sessions are missing")
        elif agrees:
            print("agrees with what was pinned")
        else:
            print("DOES NOT agree with what was pinned:")
            for k in ("pictures carried", "briefings a start", "small files resliced"):
                if found[k] != pinned[k]:
                    print(f"  {k}: pinned {pinned[k]:,}, now {found[k]:,}")
            return 1
        return 0

    live = os.environ.get("CLAUDE_SESSION_ID", "")[:8] or None
    paths = most_recent(folder, args.last, live)
    if not paths:
        print(f"no sessions under {folder}", file=sys.stderr)
        return 2
    found = measure(paths, root)

    if args.record:
        pin(found, "the ten sessions this job was opened on")
        print(f"pinned {len(found['sessions'])} sessions in {BASELINE}")

    show("Now", found, args.quiet)
    if pinned:
        print()
        print(f"Pinned {pinned['what']} — {len(pinned['sessions'])} sessions")
        print(f"  picture tokens carried in main conversations : {pinned['pictures carried']:,}")
        print(f"  opening briefings a session start            : {pinned['briefings a start']}")
        print(f"  repeat slice-reads of files under {SMALL} lines : {pinned['small files resliced']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
