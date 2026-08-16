#!/usr/bin/env python3
"""Put each fault back, one at a time, and show the suite goes red for it.

A guard is only a guard if it refuses something. Running the suite green proves
the code passes its own cases; it does not prove a case would notice the fault
coming back. This puts each one back and reports which cases wake up.

Works on a clean export of the checkout, never on the checkout itself, so a
shared tree is never left holding an injected fault. A fault whose patch no
longer applies stops the run rather than reporting green: the code it was
written against has moved, and a fault that cannot be injected proves nothing.

    python3 board/inject.py            # against the installed checkout
    SRC=<checkout> python3 board/inject.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

SRC = os.environ.get("SRC") or "/home/ahsan/dev/machinery"
GATE = "hooks/board-merge-gate.py"
DECL = "project.py"

FAULTS = [
    ("the guard stands aside where no board is running", GATE,
     lambda s: s.replace(
         "    guarded = protected_by(root)",
         "    if not os.path.isdir(os.path.join(root, '.beads')):\n"
         "        return\n"
         "    guarded = protected_by(root)")),
    ("a project cannot say its agents land their own work", DECL,
     lambda s: s.replace("        if self.agent_merges:\n"
                         "            return frozenset()\n", "")),
    ("a command quoted in a card note is read as a command", GATE,
     lambda s: s.replace("    said = bare(cmd)", "    said = cmd")),
]


def export():
    tmp = tempfile.mkdtemp(prefix="inject-")
    tar = subprocess.Popen(["git", "-C", SRC, "archive", "HEAD"],
                           stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", tmp], stdin=tar.stdout, check=True)
    tar.wait()
    return tmp


def run(tmp):
    got = subprocess.run([sys.executable, "board/selftest.py"], cwd=tmp,
                         capture_output=True, text=True, timeout=900)
    return got.returncode, (got.stdout + got.stderr)


base = export()
try:
    code, out = run(base)
    print("clean export: exit %d  %s" % (code, "GREEN" if code == 0 else "RED"))
    assert code == 0, out[-800:]
finally:
    shutil.rmtree(base, ignore_errors=True)

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
        print("%-52s exit %d  %s\n     %s"
              % (label, code, "RED" if code else "STILL GREEN", line.strip()[:140]))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
