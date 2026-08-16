#!/usr/bin/env python3
"""Put each fault back, one at a time, and show the suite goes red for it.

A guard is only a guard if it refuses something. Running the suite green proves
the code passes its own cases; it does not prove a case would notice the fault
coming back. This puts each one back and reports which cases wake up.

Works on a clean export of the tree this script sits in, never on that tree
itself, so a shared checkout is never left holding an injected fault. Work here
is done in worktrees, so reading a fixed path instead would hand a session a
verdict about somebody else's code. A fault whose patch no longer applies stops
the run rather than reporting green: the code it was written against has moved,
and a fault that cannot be injected proves nothing.

    python3 board/inject.py            # against the tree this script is in
    SRC=<checkout> python3 board/inject.py
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("SRC") or HERE
GATE = "hooks/board-merge-gate.py"
DECL = "project.py"
SUITE = "board/selftest.py"

FAULTS = [
    ("the guard stands aside where no board is running", GATE,
     lambda s: s.replace(
         "    made = routes(cmd, home)",
         "    if not os.path.isdir(os.path.join(bc.board_root(home), '.beads')):\n"
         "        return\n"
         "    made = routes(cmd, home)")),
    ("a project cannot say its agents land their own work", DECL,
     lambda s: s.replace("        if self.agent_merges:\n"
                         "            return frozenset()\n", "")),
    ("a command quoted in a card note is read as a command", GATE,
     lambda s: s.replace('        elif ch in "\'\\"`":', "        elif False:")),
    ("a line named in quotes is read as no line at all", GATE,
     lambda s: s.replace("        return shlex.split(seg)", "        return seg.split()")),
    ("a command sent into another checkout is judged where the session began",
     GATE, lambda s: s.replace("                where = under(where, argv[i + 1])",
                               "                pass")),
    ("one mid-fold switch stands the whole line down", GATE,
     lambda s: s.replace("        if any(a in PASSIVE for a in rest):",
                         "        if any(p in cmd for p in PASSIVE):")),
    ("committing where you stand is not a route onto a line", GATE,
     lambda s: s.replace('"merge", "rebase", "push", "commit",',
                         '"merge", "rebase", "push",')),
    ("a new line on the next line of the call is the first one's arguments", GATE,
     lambda s: s.replace('        elif ch in ";&|()\\n":', '        elif ch in ";&|()":')),
    ("sending every line at once names no line", GATE,
     lambda s: s.replace('    if any(a in ("--all", "--mirror") for a in rest):\n'
                         "        return [EVERY]\n", "")),
    ("a line whose name ends in a protected word is that line", GATE,
     lambda s: s.replace('    return [line_named(r.split(":")[-1], here) for r in refs]',
                         '    return [r.split(":")[-1].split("/")[-1] for r in refs]')),
    ("changing into another checkout is not following the command there", GATE,
     lambda s: s.replace('        if argv[:1] == ["cd"]:', "        if False:")),
    ("naming the position you stand at names no line", GATE,
     lambda s: s.replace("    return here if ref in HERE_NAMES else ref",
                         "    return ref")),
    ("pointing a line at your own work is not writing to it", GATE,
     lambda s: s.replace('"pull", "branch", "reset", "update-ref")', '"pull")')),
    ("stepping onto a line by force does not reset it", GATE,
     lambda s: s.replace('    if not any(a in ("-B", "-C") for a in rest):\n'
                         "        return []\n", "    return []\n")),
    ("a project running a board is not told why it can never finish", GATE,
     lambda s: s.replace("        said += WEDGED % decl.lands_on", "        pass")),
    ("the lines a project names are not taken at its word", DECL,
     lambda s: s.replace("        if self.data_protected is not None:\n"
                         "            return frozenset(self.data_protected)\n", "")),
    ("bringing work in by pulling is not writing to a line", GATE,
     lambda s: s.replace('           "pull", "branch"', '           "branch"')),
    ("a rename is credited only with the name it ends at", GATE,
     lambda s: s.replace("        old = line_named(args[0], here) if len(args) > 1 else here\n"
                         "        return [n for n in (old, line_named(args[-1], here)) if n]",
                         "        return [line_named(args[-1], here)]")),
    ("the brackets of a nested command are separators", GATE,
     lambda s: s.replace('        elif cmd[i:i + 2] == "$(":', "        elif False:")),
    ("an escaped quote opens a quoted stretch", GATE,
     lambda s: s.replace(' and quote != "\'":', " and False:")),
    ("only a reset's first name is tested for being a path", GATE,
     lambda s: s.replace("    if len(args) > 1 and not any(a in RESET_MODES for a in rest):\n"
                         "        return []\n", "")),
    ("a word carrying a command is read as the command", GATE,
     lambda s: s.replace("        elif head in WRAPPERS:\n"
                         "            argv, carried = argv[1:], True\n", "")),
    ("the shortcut for a home directory is joined before it is expanded", GATE,
     lambda s: s.replace("    named = os.path.expanduser(named)\n", "")),
    ("a name only the shell can settle is refused as every line at once", GATE,
     lambda s: s.replace("                made.append((verb, where, UNREADABLE))",
                         "                made.append((verb, where, EVERY))")),
    ("a checkout named by its git directory is not followed", GATE,
     lambda s: s.replace('            elif name == "--git-dir":\n'
                         "                where = repo_dir(under(where, value))\n", "")),
    ("a setting put in front of the command is dropped", GATE,
     lambda s: s.replace('        if put.get("GIT_WORK_TREE"):', "        if False:")),
    ("a command line handed to a shell is not read as one", GATE,
     lambda s: s.replace("        if script is not None:", "        if False:")),
    ("the forge tool is only itself when typed by its bare name", GATE,
     lambda s: s.replace('        if os.path.basename(argv[0] if argv else "") == "gh" \\\n'
                         '                and argv[1:3] == ["pr", "merge"]:',
                         '        if argv[:3] == ["gh", "pr", "merge"]:')),
    ("the line stepped onto is remembered against the directory", GATE,
     lambda s: s.replace("        tree = tree_of(where)", "        tree = where")
                .replace("        at[tree_of(where)] = line", "        at[where] = line")),
]


def export():
    tmp = tempfile.mkdtemp(prefix="inject-")
    tar = subprocess.Popen(["git", "-C", SRC, "archive", "HEAD"],
                           stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", tmp], stdin=tar.stdout, check=True)
    tar.wait()
    return tmp


def run(tmp):
    got = subprocess.run([sys.executable, SUITE], cwd=tmp,
                         capture_output=True, text=True, timeout=1800)
    return got.returncode, (got.stdout + got.stderr)


head = subprocess.run(["git", "-C", SRC, "rev-parse", "--short", "HEAD"],
                      capture_output=True, text=True).stdout.strip()
print("source: %s at %s" % (SRC, head or "no commit"))

base = export()
try:
    code, out = run(base)
    print("clean export: exit %d  %s" % (code, "GREEN" if code == 0 else "RED"))
    assert code == 0, out[-800:]
finally:
    shutil.rmtree(base, ignore_errors=True)

survived = []
for label, path, break_it in FAULTS:
    tmp = export()
    try:
        full = os.path.join(tmp, path)
        was = open(full).read()
        now = break_it(was)
        assert now != was, "fault %r did not apply — the code it patches moved" % label
        open(full, "w").write(now)
        code, out = run(tmp)
        line = next((l for l in out.splitlines() if "AssertionError" in l), "")
        if not code:
            survived.append(label)
        print("%-58s exit %d  %s\n     %s"
              % (label, code, "RED" if code else "STILL GREEN", line.strip()[:140]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

# A fault nothing notices is the finding, not a line of the report. Printed and
# walked past, it reads the same as teeth to whatever runs this.
if survived:
    sys.exit("%d fault(s) left the suite green, so nothing holds them down:\n  %s"
             % (len(survived), "\n  ".join(survived)))
