#!/usr/bin/env python3
"""What the board's refusals cost, and how often they fire.

    python3 board/cost.py

Read-only: it reads the board and this machine's session records and writes to
neither. A refusal with no number yet is printed rather than left out — the
manager was told the cost was an estimate, and a slot he can see is what turns
that into a number he can check. There are two ways to have no number and they
are different facts, so they print differently: `not built yet` for a refusal
nothing on disk records, and `built, never fired` for one that is wired up and
has caught nobody.

## The counter file

`<board-sessions>/counters.jsonl` — one JSON object per line, appended, never
rewritten and never rotated:

    {"n": "<counter>", "t": <epoch>, "s": "<session id>", "v": <number>}

A gate records one firing by appending one row under its own name, through
`record` below and nothing else; anything measuring a spend puts the amount in
`v`, which is 1 when it is only counting. One short line per append, so two
hooks firing at once interleave rows rather than tear one.
"""
import glob
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "hooks"))
import board_common as bc  # noqa: E402
import project  # noqa: E402
import spine  # noqa: E402

COUNTERS = os.path.join(bc.STATE_DIR, "counters.jsonl")
# The machinery's own home: the gates whose firings are counted here live in it,
# not in any one project's checkout.
REPO = os.path.dirname(HERE)

# The counters the report has a row for: the name, the file that records it, and
# what it means. Declared here so a number no gate has produced yet is still
# visible as missing rather than absent — and the file is read for the name rather
# than believed, so a gate deleted or renamed goes back to reading `not built yet`
# instead of reading as a refusal that never fires.
FIRES = [
    ("guard-waiver", "hooks/board-status-gate.py",
     "cor-mx9d.7 refused a finish: nothing catches the fault, and no waiver in the "
     "manager's words"),
    ("habit-cause", "hooks/board-gate.py",
     "cor-mx9d.8 refused a reply: a habit pointed at, and no card naming what "
     "produced it"),
    ("carry-on", "hooks/board-gate.py",
     "cor-etbo sent a session back to work: its own job still running, and nothing "
     "asked of the manager"),
    ("carry-on-spent", "hooks/board-gate.py",
     "cor-etbo gave up sending a session back — seven refusals in a row and it still "
     "had not carried on"),
    ("landing-gated", "hooks/board-status-gate.py",
     "refused a close that said the work landed while a reading somebody is owed "
     "was still held shut"),
    ("turns-seen", "hooks/habit-reading.py",
     "one row per turn the reply gate looked at — the exact denominator the count "
     "above only estimates"),
]
SPEND = [("reading-tokens", "hooks/habit-reading.py",
          "tokens the reply gate's reading of the manager spent")]

# A counter's name where a gate records one: `tally("…")` in a hook, `record("…")`
# anywhere else. The name is a literal at every call site, which is what lets the
# list above be checked against the code rather than trusted.
RECORDS = re.compile(r"\b(?:tally|record)\(\s*[\"']([a-z][a-z0-9-]*)[\"']")

# The step whose drop the closing gate will refuse.
GUARD = "test"
GUARD_HEAD = "\nGUARD STEP DROPPED — the baseline cor-mx9d.7 will change"
# The manager's own words, by the same shape the design step is already held to.
MANAGER = spine.NOTE_SHAPE["design"][0]

# A session record keeps only the LAST turn boundary, so turns are read off the
# gaps between recorded actions instead. The span is the claim lease: past it the
# board itself stops believing the session is alive.
IDLE = 300

# What bc._path writes a real session under. The rest of the directory is the
# prefix cache and the fixtures the selftest leaves behind.
SESSION = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$")

# The timestamped things a session record keeps.
ACTIONS = ("edits", "created", "claims", "closed")


def record(name, value=1, session=""):
    """Append one counter row. The only writer of the counter file."""
    os.makedirs(bc.STATE_DIR, exist_ok=True)
    row = json.dumps({"n": name, "t": bc.now(), "s": session, "v": value})
    with open(COUNTERS, "a") as fh:
        fh.write(row + "\n")


def counted():
    """The counter rows on disk, by name. A line that does not parse is dropped —
    a torn append is not a firing."""
    out = {}
    try:
        with open(COUNTERS) as fh:
            lines = fh.readlines()
    except OSError:
        return out
    for line in lines:
        try:
            row = json.loads(line)
        except Exception:
            continue
        out.setdefault(row.get("n"), []).append(row)
    return out


def recorded(where):
    """The counter names one file records. A file that cannot be read records none:
    the report says a refusal is built only when it has seen the line that builds it."""
    try:
        with open(os.path.join(REPO, where)) as fh:
            return set(RECORDS.findall(fh.read()))
    except OSError:
        return set()


def built(name, where):
    return name in recorded(where)


def unlisted():
    """Counters a hook records that no row above describes, by the file recording
    them. What stops the list going stale in the other direction: a gate wired to a
    name nobody wrote down would otherwise be counted and never reported."""
    listed = {n for n, _, _ in FIRES + SPEND}
    out = {}
    for path in sorted(glob.glob(os.path.join(REPO, "hooks", "*.py"))):
        for name in sorted(recorded(path) - listed):
            out.setdefault(name, os.path.relpath(path, REPO))
    return out


def jobs(root):
    """Every card poured as a job; None when the board did not answer. A recorded
    run of steps is what makes a job — a container and a find have none."""
    ok, out = bc.bd(["list", "--status", "all", "--limit", "0", "--has-metadata-key",
                     "spine", "--brief", "--json"], root)
    if not ok:
        return None
    try:
        return json.loads(out or "[]") or []
    except Exception:
        return None


def drops(rows, sid):
    """How each job answered for one droppable step: ran it, dropped it in writing,
    or dropped it with nothing recorded.

    The third is not a refusal anyone dodged: those jobs were poured before the
    pour asked, so whose call it was cannot be read off the board at all.
    """
    ran, said, silent = 0, [], []
    for r in rows:
        meta = dict(r.get("metadata") or {})
        why = meta.get("skip." + sid)
        if sid in spine.stored(meta.get("spine")):
            ran += 1
        elif why:
            said.append((r.get("id") or "?", why))
        else:
            silent.append(r.get("id") or "?")
    return ran, said, silent


def sessions():
    """Per session: actions recorded, turns they fall into, when it last acted.

    Returns (rows, skipped) — a file that is not a session record, or that no
    longer parses, is counted rather than quietly dropped.
    """
    rows, skipped = [], 0
    for path in sorted(glob.glob(os.path.join(bc.STATE_DIR, "*.json"))):
        if not SESSION.match(os.path.basename(path)):
            skipped += 1
            continue
        try:
            with open(path) as fh:
                state = json.load(fh)
        except Exception:
            skipped += 1
            continue
        stamps = sorted(e["t"] for k in ACTIONS for e in (state.get(k) or [])
                        if isinstance(e, dict) and e.get("t"))
        turns = 1 + sum(1 for a, b in zip(stamps, stamps[1:]) if b - a > IDLE)
        rows.append((os.path.basename(path)[:8], len(stamps),
                     turns if stamps else 0, stamps[-1] if stamps else 0))
    return rows, skipped


def when(stamp):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(stamp)) if stamp else "never"


def guard_section(rows):
    """The baseline the closing gate changes: who dropped the guard step, and on
    whose words."""
    print(GUARD_HEAD)
    print("%d jobs poured. Each answers for every droppable step at the pour."
          % len(rows))
    print("\n  %-9s %6s  %-22s  %s" % ("step", "ran it", "dropped, reason kept",
                                       "dropped, nothing kept"))
    # The guard keeps its row once cor-mx9d.7 takes it out of the droppable tier:
    # what it cost while it was droppable is the baseline that gate is judged on.
    steps = spine.droppable()
    every = {sid: drops(rows, sid) for sid in steps + ([] if GUARD in steps else [GUARD])}
    for sid, (ran, said, silent) in every.items():
        print("  %-9s %6d  %-22d  %d" % (sid, ran, len(said), len(silent)))

    _, said, silent = every[GUARD]
    print("\nWhose words the %d stated guard-step reasons carry, by the shape the "
          "design\nstep already uses for the manager's approval:" % len(said))
    if not said:
        print("  no job has dropped the guard step in writing, so there is nothing "
              "to read")
    for cid, why in sorted(said):
        whose = "manager" if MANAGER(why) else "agent"
        print("  %-8s  %-7s  %s" % (cid, whose, spine.subject(why.replace("\n", " "), 66)))
    if silent:
        print("\n%d more jobs ran no guard step and kept no reason — poured before the "
              "pour\nasked for one, so whose call it was is not on the board. Not a "
              "measured zero." % len(silent))


def turn_section(rows, skipped, exact=0):
    """The denominator: how many turns the reply gate looked at.

    Two answers, and the first is the real one. `turns-seen` is one row per turn the
    reading actually read; it begins at zero the day that hook lands, so the estimate
    below stays the only answer anyone has for every turn before it.
    """
    print("\nTURN VOLUME — the denominator for how often cor-mx9d.8 fires")
    if exact:
        print("%d turns read EXACTLY, one row each, since the reading started "
              "counting." % exact)
    else:
        print("The reading has counted no turn yet, so the estimate below is all "
              "there is.")
    live = [r for r in rows if r[1]]
    print("%d session records on disk, %d with recorded board activity."
          % (len(rows), len(live)))
    if not live:
        print("no session on this machine has recorded any activity, so there is no "
              "denominator")
        return
    print("A record keeps only the last turn boundary, so the turn count is an "
          "ESTIMATE:\nactions more than %ds apart are counted as different turns. It "
          "undercounts far\nmore than it overcounts — a turn that changed no file and "
          "touched no card leaves\nno trace at all — so a rate taken against it reads "
          "high." % IDLE)
    print("\n  %-9s %8s %6s  %s" % ("session", "actions", "turns", "last active"))
    for sid, acts, turns, last in sorted(live, key=lambda r: -r[1]):
        print("  %-9s %8d %6d  %s" % (sid, acts, turns, when(last)))
    print("  %-9s %8d %6d" % ("total", sum(r[1] for r in live),
                              sum(r[2] for r in live)))
    print("%d sessions recorded nothing at all — started, and never touched the "
          "board." % (len(rows) - len(live)))
    if skipped:
        print("%d files there are not session records, or no longer parse, and were "
              "not read." % skipped)


def missing(name, where):
    """What stands where a row's number would be, when it has none: which of the two."""
    return "built, never fired" if built(name, where) else "not built yet"


def future_section():
    """The numbers, and the two ways of having none. Never a zero: a refusal that
    has caught nobody and a refusal nobody built both look like zero, and a manager
    reading one for the other is reading the gate as useless rather than as quiet."""
    print("\nWHAT THE REFUSALS COST")
    print("Counted in %s%s" % (COUNTERS,
                              "" if os.path.exists(COUNTERS) else " — no such file yet"))
    have = counted()
    for name, where, what in FIRES:
        got = have.get(name)
        print("  %-15s %-18s %s" % (name, len(got) if got else missing(name, where), what))
    for name, where, what in SPEND:
        got = have.get(name)
        total = sum(r.get("v") or 0 for r in got) if got else None
        print("  %-15s %-18s %s" % (name, total if got else missing(name, where), what))
    for name, where in sorted(unlisted().items()):
        print("  %-15s %-18s %s records this, and no row here says what it is"
              % (name, len(have.get(name) or ()), where))


def main():
    root = project.root(os.getcwd())
    if not os.path.isdir(os.path.join(root, ".beads")):
        sys.exit("no board under %s — run this from a checkout that has one." % root)
    rows = jobs(root)
    if rows is None:
        print(GUARD_HEAD)
        print("the board did not answer, so no drop can be counted. `bd ready` will "
              "say what is wrong.")
    else:
        guard_section(rows)
    turn_section(*sessions(), exact=len(counted().get("turns-seen") or []))
    future_section()


if __name__ == "__main__":
    main()
