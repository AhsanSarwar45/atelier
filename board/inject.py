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
    python3 board/inject.py --anchors  # only whether every fault still applies
    SRC=<checkout> python3 board/inject.py

`--anchors` is the cheap half: it reads the live source and says which faults no
longer patch it, without running the suite once. That is the half worth putting
on another project's push gate — the source moving under a fault is this
machinery's business, and a full run is thirty suites where the gate around it
is one (mch-mkp.49).
"""
import concurrent.futures
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.environ.get("SRC") or HERE
# What gets exported. The last commit by default; a gate running before one is
# made says which tree it means, because judging the commit behind the change
# being committed proves nothing about the change.
TREE = os.environ.get("TREE") or "HEAD"
GATE = "hooks/board-merge-gate.py"
COMMON = "hooks/board_common.py"
CLOSE = "hooks/board-status-gate.py"
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
    ("a command quoted in a card note is read as a command", COMMON,
     lambda s: s.replace('        elif ch in "\'\\"`":', "        elif False:")),
    ("a line named in quotes is read as no line at all", COMMON,
     lambda s: s.replace("        split = shlex.split(_held(seg))",
                         "        split = _held(seg).split()")),
    ("a command sent into another checkout is judged where the session began",
     GATE, lambda s: s.replace('            if name == "-C" or name == "--work-tree":\n'
                               "                where = under(where, value)\n", "")),
    ("one mid-fold switch stands the whole line down", GATE,
     lambda s: s.replace("        if passive(verb, rest):",
                         "        if any(p in cmd for p in PASSIVE):")),
    ("committing where you stand is not a route onto a line", GATE,
     lambda s: s.replace('"merge", "rebase", "push", "commit",',
                         '"merge", "rebase", "push",')),
    ("a new line on the next line of the call is the first one's arguments", COMMON,
     lambda s: s.replace('        elif ch in ";&|()\\n":', '        elif ch in ";&|()":')),
    ("sending every line at once names no line", GATE,
     lambda s: s.replace('    if any(a in ("--all", "--mirror") for a in rest):\n'
                         "        return [EVERY]\n", "")),
    ("a line whose name ends in a protected word is that line", GATE,
     lambda s: s.replace('    return [line_named(r.split(":")[-1], here) for r in refs]',
                         '    return [r.split(":")[-1].split("/")[-1] for r in refs]')),
    ("changing into another checkout is not following the command there", GATE,
     lambda s: s.replace('        if argv[:1] in (["cd"], ["pushd"], ["popd"]):',
                         "        if False:")),
    ("naming the position you stand at names no line", GATE,
     lambda s: s.replace("    return here if ref in HERE_NAMES else ref",
                         "    return ref")),
    ("pointing a line at your own work is not writing to it", GATE,
     lambda s: s.replace('"pull", "fetch", "branch", "reset", "update-ref")',
                         '"pull", "fetch")')),
    ("stepping onto a line by force does not reset it", GATE,
     lambda s: s.replace("    if not any(a in REMAKES for a in rest):\n"
                         "        return []\n", "    return []\n")),
    ("a project running a board is not told why it can never finish", GATE,
     lambda s: s.replace("        said += WEDGED % decl.lands_on", "        pass")),
    ("the lines a project names are not taken at its word", DECL,
     lambda s: s.replace("        if self.data_protected is not None:\n"
                         "            return frozenset(self.data_protected)\n", "")),
    ("bringing work in by pulling is not writing to a line", GATE,
     lambda s: s.replace('           "pull", "fetch"', '           "fetch"')),
    ("a rename is credited only with the name it ends at", GATE,
     lambda s: s.replace("        old = line_named(args[0], here) if len(args) > 1 else here\n"
                         "        return [n for n in (old, line_named(args[-1], here)) if n]",
                         "        return [line_named(args[-1], here)]")),
    ("the brackets of a nested command are separators", COMMON,
     lambda s: s.replace('        elif cmd[i:i + 2] == "$(":', "        elif False:")),
    ("an escaped quote opens a quoted stretch", COMMON,
     lambda s: s.replace(' and quote != "\'":', " and False:")),
    ("only a reset's first name is tested for being a path", GATE,
     lambda s: s.replace("    if len(args) > 1 and not any(a in RESET_MODES for a in rest):\n"
                         "        return []\n", "")),
    ("a word carrying a command is read as the command", COMMON,
     lambda s: s.replace("        elif head in WRAPPERS:\n"
                         "            argv, carried = argv[1:], True\n", "")),
    ("the shortcut for a home directory is joined before it is expanded", GATE,
     lambda s: s.replace("    named = os.path.expanduser(named)\n", "")),
    ("a name only the shell can settle is refused as every line at once", GATE,
     lambda s: s.replace("                made.append((verb, where, UNREADABLE, rest))",
                         "                made.append((verb, where, EVERY, rest))")),
    ("a checkout named by its git directory is not followed", GATE,
     lambda s: s.replace('            elif name == "--git-dir":\n'
                         "                where = repo_dir(under(where, value))\n", "")),
    ("a setting put in front of the command is dropped", GATE,
     lambda s: s.replace("        for name, resolve in POINTERS:\n"
                         "            if put.get(name):\n", "        for name, resolve in ():\n"
                         "            if put.get(name):\n")),
    ("a command line handed to a shell is not read as one", GATE,
     lambda s: s.replace("        if script is not None:", "        if False:")),
    ("the forge tool is only itself when typed by its bare name", GATE,
     lambda s: s.replace('    if not argv or os.path.basename(argv[0]) != "gh":\n'
                         "        return False\n",
                         '    if argv[:1] != ["gh"]:\n        return False\n')),
    ("the line stepped onto is remembered against the directory", GATE,
     lambda s: s.replace("        tree = tree_of(where)", "        tree = where")
                .replace("        at[tree_of(where)] = line", "        at[where] = line")),
    ("bringing your own line up to date is read as landing work on it", GATE,
     lambda s: s.replace('    if verb == "pull":\n'
                         "        return pull_targets(rest, here)\n", "")),
    ("a shell is only a shell when its switch stands alone", COMMON,
     lambda s: s.replace('        if arg.startswith("-") and not arg.startswith("--") '
                         'and "c" in arg[1:] \\\n                and i + 1 < len(argv):',
                         '        if arg == "-c" and i + 1 < len(argv):')),
    ("stepping back onto the line before is read as no step", GATE,
     lambda s: s.replace("    if any(a in BACK for a in rest):\n"
                         "        return previous(where)\n", "")),
    ("each gate keeps its own list of the words that carry a command", CLOSE,
     lambda s: s.replace('WRAP = r"(?:(?:%s)(?:\\s+(?!(?:bd|git|rtk)\\b)\\S+)*\\s+|\\\\)*"'
                         ' % "|".join(bc.WRAPPERS)',
                         'WRAP = r"(?:(?:env|command|exec|nice|setsid|stdbuf|time)'
                         '\\s+(?:\\w+=\\S+\\s+)*|\\\\)*"')),
    ("a carrier is only a carrier when it has no switches of its own", CLOSE,
     lambda s: s.replace('(?:\\s+(?!(?:bd|git|rtk)\\b)\\S+)*\\s+',
                         '\\s+(?:\\w+=\\S+\\s+)*')),
    ("the line a shell was handed stays quoted, so nothing reads it", CLOSE,
     lambda s: s.replace("    cmd = bc.unshelled(raw)", "    cmd = raw")),
    ("bringing a line down onto a different one is not landing it", GATE,
     lambda s: s.replace('    if verb == "fetch":\n'
                         "        return fetch_targets(rest, here)\n", "")),
    ("a fetch onto the line of the same name is landing work", GATE,
     lambda s: s.replace("        if line_named(came, here) != line_named(onto, here):\n"
                         "            out.append(line_named(onto, here))",
                         "        out.append(line_named(onto, here))")),
    ("a waiting piece of work is only merged by the subcommand for it", GATE,
     lambda s: s.replace("    return writes_a_line(path, fields) and method not in GH_READS",
                         "    return False")),
    ("asking whether a piece of work is merged is merging it", GATE,
     lambda s: s.replace("    return writes_a_line(path, fields) and method not in GH_READS",
                         "    return writes_a_line(path, fields)")),
    ("a line named by a plain variable is a line spelled out", GATE,
     lambda s: s.replace('GROWN = ("$", "`")', 'GROWN = ("$(", "`", "${")')),
    ("a forced step onto an unreadable name rewrites nothing", GATE,
     lambda s: s.replace("                if any(a in REMAKES for a in rest):\n"
                         "                    made.append((verb, where, UNREADABLE, rest))\n",
                         "")),
    ("throwing your own work away moves the line you stand on", GATE,
     lambda s: s.replace("    if all(a in HERE_NAMES for a in args):",
                         "    if False:")),
    ("a rule about one command runs to the end of the next", CLOSE,
     lambda s: s.replace(r"[^|;&\n]*", r"[^|;&]*")),
    ("ordinary text in a message opens a here-document", COMMON,
     lambda s: s.replace('        if ch in "\'\\"":\n            quote = ch\n'
                         "            i += 1\n            continue\n", "")),
    ("an opener whose closing word never arrives still hides the rest", COMMON,
     lambda s: s.replace("    if waiting:\n        # An opener whose closing word never arrives is not a here-document at\n"
                         "        # all, and dropping the rest of the line for it is the one failure\n"
                         "        # direction this guard must not have. Read the whole thing instead.\n"
                         "        return cmd, []\n", "")),
    ("only the bare spelling of changing directory is followed", GATE,
     lambda s: s.replace('        if argv[:1] in (["cd"], ["pushd"], ["popd"]):',
                         '        if argv[:1] == ["cd"]:')),
    ("the forge has only one way onto a line", GATE,
     lambda s: s.replace('    if parts and parts[-1] == "merges":\n        return True\n',
                         "")),
    ("a query-endpoint instruction names this checkout's own repository", GATE,
     lambda s: s.replace('    if parts and parts[-1] == "graphql":\n'
                         "        return UNREADABLE\n", "")),
    ("the batch form of pointing a line names the line", GATE,
     lambda s: s.replace('        if "--stdin" in rest:\n            # The batch form carries every line it writes to in its own input,\n'
                         "            # so the command names none of them.\n"
                         "            return [UNREADABLE]\n", "")),
    ("a name fed in from a pipe is the line you stand on", GATE,
     lambda s: s.replace("(unknowable(seg) or bc.fed(seg))", "unknowable(seg)")),
    ("the query endpoint and the file-writing path change nothing", GATE,
     lambda s: s.replace('    if "contents" in parts:\n        return True\n'
                         '    if parts and parts[-1] == "graphql":\n'
                         "        return any(MUTATION in (value or \"\") for value in fields)\n", "")),
    ("a setting made on a command of its own stands for nothing", GATE,
     lambda s: s.replace("            standing.update(put)\n            continue\n", "")),
    ("a card id is looked for in the line as the shell would run it", CLOSE,
     lambda s: s.replace("    ids = card_id.findall(raw)", "    ids = card_id.findall(cmd)")),
    ("a shell handed its commands on its own input is not read", COMMON,
     lambda s: s.replace("            elif shell:\n"
                         "                # What a SHELL is handed on its own input is a command line, and\n"
                         "                # every route is open behind four characters if it is not read.\n"
                         "                ran.append(line)\n", "")),
    ("a shell fed its commands by a pipe runs a line that is read", GATE,
     lambda s: s.replace("    if bc.piped_into_shell(cmd):", "    if False:")),
    ("a directory change made inside brackets outlives them", GATE,
     lambda s: s.replace('        if sep == "(":', "        if False:")),
    ("the place a second copy is made is the word after the switch", GATE,
     lambda s: s.replace('    "worktree": ("--reason", "-b", "-B"),',
                         '    "worktree": ("--reason",),')),
    ("a here-document body is a run of commands", COMMON,
     lambda s: s.replace("    cmd, ran = _without_heredocs(cmd)\n", "    ran = []\n")),
    ("a substitution inside an unquoted here-document runs unread", COMMON,
     lambda s: s.replace("            elif not quoted:\n"
                         "                ran += grown_in(line)\n", "")),
    ("what a substitution holds is read by nobody", COMMON,
     lambda s: s.replace("    out, i = [], 0\n    while i < len(cmd):\n"
                         '        if cmd[i:i + 2] == "$(":',
                         "    out, i = [], 0\n    while False:\n"
                         '        if cmd[i:i + 2] == "$(":')),
    ("what eval is handed is not a command line", COMMON,
     lambda s: s.replace('    if os.path.basename(argv[0]) == "eval":\n'
                         '        return " ".join(argv[1:]) or None\n', "")),
    ("a checkout that cannot be asked writes to nothing", GATE,
     lambda s: s.replace("            at[tree] = standing_on(where) or (\n"
                         "                None if common_dir(where) else UNREADABLE)",
                         "            at[tree] = standing_on(where)")),
    ("the line a second checkout will stand on is not named here", GATE,
     lambda s: s.replace("            made_tree = added_tree(rest, where)\n"
                         "            if made_tree:\n"
                         "                stand(made_tree[0], made_tree[1])\n", "")),
    ("repointing the position by hand is not stepping onto a line", GATE,
     lambda s: s.replace('        if verb == "symbolic-ref":', "        if False:")),
    ("a forge command is judged where the shell stands", GATE,
     lambda s: s.replace("            named = repo_named(line)\n"
                         "            if named and named.lower() != repo_here(where).lower():\n",
                         "            named = repo_named(line)\n"
                         "            if False:\n")),
    ("a switch that may take a value always takes one", GATE,
     lambda s: s.replace('    "push": ("-o", "--push-option", "--receive-pack", "--exec", "--repo"),',
                         '    "push": ("-o", "--push-option", "--receive-pack", "--exec", "--repo",\n'
                         '             "--force-with-lease", "--signed"),')),
    ("only the short spelling makes a line, or points one at you", GATE,
     lambda s: s.replace('MAKES = ("-b", "-c", "-B", "-C", "--create", "--force-create", "--orphan")\n'
                         'REMAKES = ("-B", "-C", "--force-create")',
                         'MAKES = ("-b", "-c", "-B", "-C")\nREMAKES = ("-B", "-C")')),
    ("a remote-tracking name lands on itself", GATE,
     lambda s: s.replace('    if "/" in name and ref_exists("refs/remotes/" + name, where):\n'
                         '        return name.split("/", 1)[1]\n', "")),
    ("a shell's own word in front of a command is part of the command", COMMON,
     lambda s: s.replace("        elif head in KEYWORDS:\n            argv = argv[1:]\n", "")),
    ("a shell's own word hides a command from the close gate", COMMON,
     lambda s: s.replace("        if head in KEYWORDS and rest.strip():",
                         "        if False:")),
    ("a commit whose message is in a file can never name its card", CLOSE,
     lambda s: s.replace("        ids = card_id.findall(written_in(message_files(cmd, bc.where(data))))",
                         "        pass")),
    ("the close gate reads a commit with a pattern of its own", CLOSE,
     lambda s: s.replace("    if commits(cmd) and not AMEND.search(bare) and not ids:",
                         '    if re.search(START + WRAP + r"(?:rtk\\s+)?git\\s+(?:-\\S+\\s+)*commit\\b",\n'
                         "                 bare, re.M) and not AMEND.search(bare) and not ids:")),
    ("a switch's value is read as a switch of its own", GATE,
     lambda s: s.replace("        if passive(verb, rest):",
                         "        if any(a in PASSIVE for a in rest):")),
    ("a switch's value is one of the command's own arguments", GATE,
     lambda s: s.replace('            skip = "=" not in arg and arg in TAKES_ARG.get(verb, ())\n'
                         "            continue",
                         "            continue")),
    ("a line that exists only on the remote is no line at all", GATE,
     lambda s: s.replace('            ["git", "for-each-ref", "--format=%(refname)", '
                         '"refs/remotes/*/" + name],',
                         '            ["git", "for-each-ref", "--format=%(refname)", '
                         '"refs/remotes/nowhere/" + name],')),
    ("a run fired from a commit hook is aimed by that hook's own settings", SUITE,
     lambda s: s.replace("    os.environ.pop(_pointed, None)", "    pass")),
    ("a repository inside a project borrows that project's permission", GATE,
     lambda s: s.replace("        if nested_repository(where, project.root(where)):",
                         "        if False:")),
    ("copying one line over another writes to the name it copies from", GATE,
     lambda s: s.replace("    if any(a in BRANCH_COPIES for a in rest):",
                         "    if False:")),
    ("listing the lines of a checkout is a write to one", GATE,
     lambda s: s.replace('    if verb == "branch":\n'
                         "        return any(a in BRANCH_WRITES for a in rest)\n", "")),
    ("a rebase is unreadable whenever anything on it is", GATE,
     lambda s: s.replace('    if verb == "rebase":\n'
                         '        return unknowable(rebase_target(rest) or "")\n', "")),
    ("a stretch the shell works out is several words", COMMON,
     lambda s: s.replace("        split = shlex.split(_held(seg))",
                         "        split = shlex.split(seg)")),
    ("a line too long to read is read as far as it goes and passed", GATE,
     lambda s: s.replace('        made.append(("read", cwd, UNENDING, []))', "        pass")),
    ("a fast-forward switch anywhere on the line answers for every fold", GATE,
     lambda s: s.replace("    if any(verb == \"merge\" and FF_ONLY not in rest "
                         "for verb, rest in folds):",
                         "    if any(verb == \"merge\" for verb, rest in folds) "
                         "and FF_ONLY not in bc.words(cmd):")),
]


def stale():
    """Faults whose patch no longer matches the live source, by name.

    Read off the tree as it stands rather than off a commit: what a gate around
    this wants to know is whether the code in front of it has moved, and which
    branch the shared checkout happens to be standing on is not that question.
    """
    out = []
    for label, path, break_it in FAULTS:
        try:
            with open(os.path.join(SRC, path)) as fh:
                was = fh.read()
        except OSError as why:
            out.append("%s (%s)" % (label, why))
            continue
        if break_it(was) == was:
            out.append(label)
    return out


if "--anchors" in sys.argv:
    # The cheap half, and the only half worth putting on another project's push:
    # whether every fault still patches the source, with no suite run at all.
    gone = stale()
    for label in gone:
        print("MOVED  %s" % label)
    print("%d of %d fault(s) no longer apply" % (len(gone), len(FAULTS)))
    sys.exit(1 if gone else 0)


def export():
    tmp = tempfile.mkdtemp(prefix="inject-")
    tar = subprocess.Popen(["git", "-C", SRC, "archive", TREE],
                           stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", tmp], stdin=tar.stdout, check=True)
    tar.wait()
    return tmp


def run(tmp):
    got = subprocess.run([sys.executable, SUITE], cwd=tmp,
                         capture_output=True, text=True, timeout=1800)
    return got.returncode, (got.stdout + got.stderr)


head = subprocess.run(["git", "-C", SRC, "rev-parse", "--short", TREE],
                      capture_output=True, text=True).stdout.strip()
print("source: %s at %s" % (SRC, head or "no commit"))

base = export()
try:
    code, out = run(base)
    print("clean export: exit %d  %s" % (code, "GREEN" if code == 0 else "RED"))
    assert code == 0, out[-800:]
finally:
    shutil.rmtree(base, ignore_errors=True)

def put_back(fault):
    """One fault, in a copy of its own, and what the suite said about it."""
    label, path, break_it = fault
    tmp = export()
    try:
        full = os.path.join(tmp, path)
        was = open(full).read()
        now = break_it(was)
        if now == was:
            return label, None, "the code it patches moved"
        open(full, "w").write(now)
        code, out = run(tmp)
        return label, code, next(
            (l.strip()[:140] for l in out.splitlines() if "AssertionError" in l), "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# Each fault is a whole suite run in a copy of its own, so they are put back at
# once rather than one after another: run in turn this is minutes, and a check
# nobody can afford to run is a check nobody runs.
WIDTH = min(8, (os.cpu_count() or 4))

survived, moved = [], []
with concurrent.futures.ThreadPoolExecutor(max_workers=WIDTH) as pool:
    for label, code, line in pool.map(put_back, FAULTS):
        if code is None:
            moved.append(label)
            print("%-58s %s" % (label, "MOVED — " + line))
            continue
        if not code:
            survived.append(label)
        print("%-58s exit %d  %s\n     %s"
              % (label, code, "RED" if code else "STILL GREEN", line))

# A fault nothing notices is the finding, not a line of the report. Printed and
# walked past, it reads the same as teeth to whatever runs this.
if survived or moved:
    sys.exit(
        "".join(
            ["%d fault(s) left the suite green, so nothing holds them down:\n  %s\n"
             % (len(survived), "\n  ".join(survived)) if survived else "",
             "%d fault(s) no longer apply — the code they patch moved, so they "
             "prove nothing until they are rewritten against it:\n  %s"
             % (len(moved), "\n  ".join(moved)) if moved else ""]))
