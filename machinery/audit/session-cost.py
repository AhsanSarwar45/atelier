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
import base64
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
# The range may be single-quoted, double-quoted or bare; knowing only two of
# the three left the third uncounted (bw-nqll.7).
SLICE = re.compile(r"sed -n\s+['\"]?(\d+),(\d+)p['\"]?\s+(\S+)")

# `awk 'NR>=120 && NR<=240' some/file` — the same reading, written the other
# common way. The gate refuses this shape, so the count has to see it too, or
# the number this job is judged on misses whatever the gate is turning away
# (bw-nqll.13).
AWK = re.compile(r"\bawk\b[^|;]*?NR\s*[<>=]{1,2}\s*\d+[^|;]*?\s(\S+)$")

PICTURE = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif")

# What a picture costs to read is decided by its pixels, not by how many
# characters it happens to encode into: a screenshot that compresses well and
# one that does not cost the same if they are the same size on screen. Counting
# the encoded characters charged a 1440x900 shot 7,667 tokens where it really
# costs 1,600 — nearly five times over, by a different factor for every
# picture (bw-nqll.9).
#
# A picture whose long edge is over 1568 pixels is scaled down to it, and what
# is left costs one token per 750 pixels — up to a ceiling of about 1600, above
# which it is scaled down again.
EDGE = 1568
PER_TOKEN = 750

# The most any one picture can cost. Also what a picture whose size cannot be
# read at all is charged, so that number is an over-count and never a quiet
# under-count; how many were charged this way is reported beside it.
MOST = 1600


def pixels(blob: bytes):
    """How wide and how tall an encoded picture is, or None if it cannot be told."""
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(blob[16:20], "big"), int.from_bytes(blob[20:24], "big")
    if blob[:3] == b"GIF":
        return int.from_bytes(blob[6:8], "little"), int.from_bytes(blob[8:10], "little")
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        kind = blob[12:16]
        if kind == b"VP8 ":
            return int.from_bytes(blob[26:28], "little") & 0x3FFF, int.from_bytes(blob[28:30], "little") & 0x3FFF
        if kind == b"VP8L":
            bits = int.from_bytes(blob[21:25], "little")
            return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
        if kind == b"VP8X":
            return int.from_bytes(blob[24:27], "little") + 1, int.from_bytes(blob[27:30], "little") + 1
    if blob[:2] == b"\xff\xd8":
        at = 2
        while at + 9 < len(blob):
            if blob[at] != 0xFF:
                at += 1
                continue
            marker = blob[at + 1]
            if marker == 0x01 or 0xD0 <= marker <= 0xD8:
                at += 2
                continue
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                return int.from_bytes(blob[at + 7:at + 9], "big"), int.from_bytes(blob[at + 5:at + 7], "big")
            at += 2 + int.from_bytes(blob[at + 2:at + 4], "big")
    return None


def tokens_for(wide: float, high: float) -> int:
    """What a picture of this size costs on every turn it survives."""
    if wide <= 0 or high <= 0:
        return 0
    shrink = min(1.0, EDGE / max(wide, high))
    wide, high = wide * shrink, high * shrink
    return min(MOST, int(round(wide * high / PER_TOKEN)))


def picture_tokens(body) -> tuple[int, int]:
    """What one answer to a picture reading costs, and how many went unsized.

    An answer that carries no picture at all — an error, a refusal — is text,
    and costs what its text costs.
    """
    tokens = unsized = 0
    shots = 0
    for shot in body if isinstance(body, list) else []:
        if not isinstance(shot, dict) or shot.get("type") != "image":
            continue
        shots += 1
        raw = (shot.get("source") or {}).get("data") or ""
        size = None
        try:
            size = pixels(base64.b64decode(raw, validate=False))
        except Exception:
            size = None
        if size:
            tokens += tokens_for(*size)
        else:
            tokens += MOST
            unsized += 1
    if shots:
        return tokens, unsized
    return len(body if isinstance(body, str) else json.dumps(body)) // 4, 0

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


def pictures_carried(records) -> tuple[int, int, int]:
    """Tokens a session's pictures cost: written in once, then carried.

    Returns (written in, carried, unsized) — the second is the one that
    matters, and it is the first multiplied by how many turns each picture
    survived before the memory it sat in was squashed. The third says how many
    pictures had to be charged the ceiling because their size could not be
    read.
    """
    turns: list[int] = []
    squashed: list[int] = []
    shots: list[tuple[int, int]] = []  # (turn it arrived on, tokens)
    asked: dict[str, str] = {}
    turn = 0
    unsized = 0

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
                    tokens, blind = picture_tokens(block.get("content"))
                    shots.append((turn, tokens))
                    unsized += blind
        if r.get("isCompactSummary") or r.get("subtype") == "compact_boundary":
            squashed.append(turn)

    last = turns[-1] if turns else 0
    written = carried = 0
    for arrived, tokens in shots:
        until = min([s for s in squashed if s >= arrived], default=last)
        written += tokens
        carried += tokens * sum(1 for t in turns if arrived < t <= until)
    return written, carried, unsized


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
    """Every file a session opened a slice of, and how many times.

    All three shapes the gate refuses are counted: a sed range, an awk line
    range, and the reading tool asked for part of a file. Counting only the
    first left the number blind to two habits the gate itself stops, so a
    session could move from one to another and read as an improvement
    (bw-nqll.13).
    """
    cut: collections.Counter = collections.Counter()
    for r in records:
        if r.get("type") != "assistant":
            continue
        for block in (r.get("message") or {}).get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            got = block.get("input") or {}
            if block.get("name") == "Bash":
                command = got.get("command") or ""
                for m in SLICE.finditer(command):
                    cut[m.group(3)] += 1
                for m in AWK.finditer(command):
                    cut[m.group(1)] += 1
            elif block.get("name") == "Read" and (got.get("offset") or got.get("limit")):
                if got.get("file_path"):
                    cut[got["file_path"]] += 1
    return cut


class Lengths:
    """How long a file is, looked up by the name the session actually typed."""

    def __init__(self, root: Path):
        self.root = root
        self.known: dict[str, int | None] = {}
        self.by_name: dict[str, list[str]] = {}

    def _wearing(self, name: str) -> list[str]:
        """Every file in the checkout with this bare name."""
        if name in self.by_name:
            return self.by_name[name]
        hits: list[str] = []
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
        except Exception:
            hits = []
        self.by_name[name] = hits
        return hits

    def of(self, named: str) -> int | None:
        """The length of the file a session named, or None when that is not knowable.

        The name is taken as written and resolved against the checkout, because
        that is what the session meant by it. Falling back to the bare name and
        taking whatever came back first measured the wrong file whenever two
        files shared a name — and this checkout has nine README.md, four
        package.json and five page.js outside the folders already skipped
        (bw-nqll.8). So the bare name answers only when exactly one file wears
        it; two files of one name are two different files, and guessing between
        them scores a reading against something nobody read.
        """
        where = (named or "").strip("'\"")
        if where in self.known:
            return self.known[where]
        found = None
        try:
            path = Path(os.path.expanduser(where))
            if not path.is_absolute():
                path = self.root / path
            if not path.is_file():
                wearing = self._wearing(os.path.basename(where))
                path = Path(wearing[0]) if len(wearing) == 1 else None
            if path is not None and path.is_file():
                with path.open("rb") as fh:
                    found = sum(1 for _ in fh)
        except OSError:
            found = None
        self.known[where] = found
        return found


def measure(paths: list[Path], root: Path) -> dict:
    """The three numbers, over a given set of sessions."""
    lengths = Lengths(root)
    carried = written = 0
    doubled = 0
    resliced = 0
    unsized = 0
    per_session = []

    for path in paths:
        records = list(read(path))
        w, c, blind = pictures_carried(records)
        unsized += blind
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
        "pictures whose size could not be read": unsized,
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
    blind = found.get("pictures whose size could not be read") or 0
    if blind:
        print(f"  ({blind} picture(s) charged the ceiling of {MOST:,} — their size could not be read)")
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

    live = os.environ.get("CLAUDE_CODE_SESSION_ID", "")[:8] or None
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
