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
sys.path.insert(0, HERE)
import project  # noqa: E402

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
LANDING = "hooks/landing-gate.py"
SPINE = "board/spine.py"
POUR = "board/job"
RUN = "board/run.py"
TOUCH = "hooks/board-touch.py"
PRIME = "hooks/board-prime.py"
LAND = "board/land"
READING = "board/reading.py"
REVIEW = "board/review"
CHECKS = "checks"
JOIN = "join"
DECL = "project.py"

FAULTS = [
    ("a gate already wired as a word is not the gate being wired", JOIN,
     lambda s: s.replace('                        if not runs(h.get("command"), name)]',
                         '                        if os.path.basename('
                         '(h.get("command") or "")) != name]')),
    ("a gate is written as the joiner's own folder and not as a word", JOIN,
     lambda s: s.replace('    return typed(name) or os.path.join(HOME, "hooks", name)',
                         '    return os.path.join(HOME, "hooks", name)')),
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
    # And the two sides of the one-name spelling of that word (bw-7e8.9): the
    # question read as the write, and the write read as the question.
    ("asking a name what it points at is writing to it", GATE,
     lambda s: s.replace("            elif len(args) > 1 or (args and any(a in SYMREF_DELETES\n"
                         "                                               for a in rest)):",
                         "            elif args:")),
    ("taking a pointer away is not a write", GATE,
     lambda s: s.replace("            elif len(args) > 1 or (args and any(a in SYMREF_DELETES\n"
                         "                                               for a in rest)):",
                         "            elif len(args) > 1:")),
    ("the reason a repointing carries is one of its names", GATE,
     lambda s: s.replace('    "symbolic-ref": ("-m",),\n', "")),
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
    # The one-command landing and what a reader is shown of a job (bw-a6o.3).
    # Both are a message rather than a merge, and both were found by a reader
    # and not by the suite, which is the argument for putting them here.
    ("a blocked landing says the whole of its refusal twice", LAND,
     lambda s: s.replace("        if refused:",
                         "        if refused and print(said) is None:")),
    ("a landing closes any card of the job its commits name", LAND,
     lambda s: s.replace("            if WORK in (r.get(\"labels\") or [])",
                         "            if any(l.startswith(\"step:\") "
                         "for l in r.get(\"labels\") or [])")),
    ("an item's name is looked for anywhere in the message", LAND,
     lambda s: s.replace('    named = re.compile(r"\\b%s\\b" % re.escape(item_id))',
                         "    named = re.compile(re.escape(item_id))")),
    ("a landing closes what it merged and leaves the run standing there", LAND,
     lambda s: s.replace("    said = running.advance(closed[-1][0], ROOT, actor, "
                         "HERE_TREE)", '    said = ""')),
    ("a reading counts whatever the repository keeps a ref for", READING,
     lambda s: s.replace('                ["git", "log", "--branches", "--tags", '
                         '"--remotes",\n',
                         '                ["git", "log", "--all",\n')),
    # The leftovers a landing lands into (bw-vb2). Both halves are here: a sweep
    # that takes what it should not is as bad as one that never happens, and a
    # refusal nobody can act on is the fault the whole thing was built for.
    ("a landing never looks at the checkout it lands in", GATE,
     lambda s: s.replace("        said, refused = clear_the_way(root, lands_on)",
                         "        said, refused = ('', False)")),
    ("the checkout a landing lands in is the one the command was typed in", GATE,
     lambda s: s.replace("    tree = landing_tree(root, lands_on)",
                         "    tree = root")),
    ("leftovers nobody holds are found and left where they are", GATE,
     lambda s: s.replace("    label, why = sweep(tree)",
                         "    label, why = ('swept', '')")),
    ("the sweep takes untracked files with it", GATE,
     lambda s: s.replace('["git", "stash", "push", "-m", label]',
                         '["git", "stash", "push", "-u", "-m", label]')),
    ("nobody is ever read as still at work, so live work is swept aside", GATE,
     lambda s: s.replace("    when = bc.now() if when is None else when",
                         "    return {}\n    when = bc.now() if when is None else when")),
    ("a session that finished and went is read as still at work", GATE,
     lambda s: s.replace("        if when - last <= LEASE:", "        if True:")),
    ("the label a sweep leaves behind carries no date", GATE,
     lambda s: s.replace('    label = "%s \u2014 %s" % (SWEPT, time.strftime("%Y-%m-%d %H:%M"))',
                         "    label = SWEPT")),
    ("the note says nothing about which files were moved", GATE,
     lambda s: s.replace('"files": "\\n".join("  " + p for p in litter)}, False',
                         '"files": ""}, False')),
    ("the refusal names the files but not the session holding them", GATE,
     lambda s: s.replace('            "who": ", ".join(sorted(theirs)),',
                         '            "who": "somebody",')),
    ("the newest claim names the session, wherever it was made", GATE,
     lambda s: s.replace("    return here if here in mine else "
                         "(mine[0] if mine else here)",
                         "    return mine[0] if mine else here")),
    # The checkout's own guard, and the one carve-out it makes (bw-7e8.8).
    ("the shape of a commit is a commit, whatever made the write", LANDING,
     lambda s: s.replace("    if commit_made_here(old, new, root) and "
                         "a_commit(written_by()):",
                         "    if commit_made_here(old, new, root):")),
    ("any git command at all is read as a commit", LANDING,
     lambda s: s.replace('            return word == "commit"',
                         "            return True")),
    # Where a project says what its checks are (bw-a6o.2). The other half of that
    # cut — the commit hook that used to put every fault back on each gate commit
    # — has no fault left to put back: the machinery is a directory inside a
    # project now and ships no git hook of its own, and the hook the project has
    # is written by bd and rewritten on every upgrade of it (bw-8um.3.7).
    ("a project's own checks command is not read from its declaration", DECL,
     lambda s: s.replace('        self.checks = data.get("checks") or ""',
                         '        self.checks = ""')),

    # What a job costs before it starts: the four steps the cut removed, the
    # written refusal it used to demand for each optional one, and the words a job
    # picks its own steps with (bw-a6o.2).
    ("a step the cut retired is a card every job opens again", SPINE,
     lambda s: s.replace("ORDER = [s[0] for s in STEPS]",
                         "ORDER = [s[0] for s in RETIRED + STEPS]")
                .replace("    return [s[0] for s in STEPS if s[4] == MUST]",
                         "    return [s[0] for s in STEPS + RETIRED "
                         "if s[4] in (MUST, GONE)]")),
    ("a pour owes a written refusal for every step it does not run", POUR,
     lambda s: s.replace(
         '    earned = spine.auto(a.done, getattr(a, "record", "") or "")',
         "    owed = [s for s in spine.optional() if s not in take "
         "and s not in skips]\n"
         "    if owed:\n"
         '        sys.exit("This job has not said which steps it runs: %s"\n'
         '                 % ", ".join(owed))\n'
         '    earned = spine.auto(a.done, getattr(a, "record", "") or "")')),
    ("a job's own words no longer select the step they ask for", SPINE,
     lambda s: s.replace('    """Steps the job\'s own words select without being '
                         'asked."""\n    picked = []',
                         '    """Steps the job\'s own words select without being '
                         'asked."""\n    return []\n    picked = []')),
    ("the checks step closes on a note that ran nothing", SPINE,
     lambda s: s.replace('    "checks": (_has_run, "the exact command you ran and '
                         'the count it came back with"),\n', "")),
    ("the goal never carries the checks command of the project it was poured in",
     POUR,
     lambda s: s.replace('    if DECL.checks:\n        meta["checks"] = DECL.checks\n',
                         "")),

    # Batching, which the opening command is the only place anybody is asked about:
    # a job nobody was told could fold into an open goal, and an item poured where
    # an open sibling already lands (bw-msdm).
    ("a job is opened into a system already carrying an open goal", POUR,
     lambda s: s.replace("    stands_alone(a)\n", "")),
    ("the whole of a work item's body is read as the finish line it is judged by",
     POUR,
     lambda s: s.replace(
         'sections.part(card.get("description") or "", "Acceptance Criteria")',
         '(card.get("description") or "")')),
    # Filling a placeholder in where it stands (bw-7dqe): the same card becomes the
    # job, so nothing is closed as done that nobody did — and the guard rails on
    # that route are these two.
    ("an upgrade fills in any card it is pointed at, placeholder or not", POUR,
     lambda s: s.replace('    if "find" not in (card.get("labels") or []):\n',
                         "    if False:\n")),
    ("what the placeholder said about where it shows is dropped on the way up",
     POUR,
     lambda s: s.replace("    if where:\n        a.evidence = ",
                         "    if False:\n        a.evidence = ")),
    ("what is already open under a goal is nothing a new item is measured against",
     POUR,
     lambda s: s.replace("    kin = siblings_of(a.parent)\n", "    kin = []\n")),
    ("every command a sibling names is read against every place it names", POUR,
     lambda s: s.replace(
         "        before = [name for start, name in runs if start <= at]\n"
         "        out.add((before[-1] if before else runs[0][1], spot))\n",
         "        for _, name in runs:\n            out.add((name, spot))\n")),

    # One refusal that names every fault, rather than one refusal per rule: 54 of
    # the 105 pours refused over 537 sessions took two to five tries, each fixing
    # the one fault it was told about and meeting the next (bw-aczr.1).
    ("a pour is refused on the first fault of it and never on the rest", POUR,
     lambda s: s.replace("    if problem not in FOUND:\n"
                         "        FOUND.append(problem)\n",
                         "    sys.exit(problem)\n")),
    ("a flag typed wrong is handed the rule it broke and not the command to type",
     POUR,
     lambda s: s.replace(
         '        sys.exit("%s: error: %s\\n\\n%s" % (self.prog, message, worked()))',
         '        sys.exit("%s: error: %s" % (self.prog, message))')),

    # A small job is one work item, poured by the command that opens its goal
    # (bw-aczr.5). Both halves: the item that never reaches the board, and the
    # size that goes back to being a tag any job may hand a work item to.
    ("a small job opens its goal and leaves its one work item unpoured", POUR,
     lambda s: s.replace('    made = make_items(root, getattr(a, "do", None) or [],',
                         "    made = make_items(root, [],")),
    ("--size is a tag again, so a job of any size may hand work items to the pour",
     POUR, lambda s: s.replace("    one_item_here(a)\n", "")),

    # One claim a job: the four ways the hand-over goes back to one claim a step —
    # the step nobody is given, the next piece nobody is given, a piece taken off
    # another session's desk, and a close that moves the run on under no name at
    # all (bw-a6o.2).
    ("the step that opens after a close is left for somebody to claim by hand",
     RUN,
     lambda s: s.replace(
         '            return hand_over({"id": new_id, "issue_type": "task", '
         '"labels": labels},\n                             actor, root, here=here)\n',
         "            return\n")),
    ("a job being built hands out nothing, so every work item is claimed by hand",
     RUN,
     lambda s: s.replace("            return hand_over(free_item(items), actor, root, "
                         "only_if_free=True,\n                             here=here)\n",
                         "            return\n")),
    ("a hand-over takes the piece another session is already holding", RUN,
     lambda s: s.replace('    if only_if_free:\n        args += ["--if-assignee", ""]\n',
                         "")),
    ("a close moves the job on under no name, so the next step is handed to nobody",
     TOUCH,
     lambda s: s.replace("said = run.advance(cid, root, closing_actor(cmd, data),\n"
                         "                                   bc.where(data))",
                         "said = run.advance(cid, root, None,\n"
                         "                                   bc.where(data))")),

    # The copy rule reached by the one door that is not a claim: a step the run
    # hands over on its own, which nobody types a command for and so no gate in
    # front of a command ever sees (bw-n1x5).
    ("the run hands out a step that makes code without asking where the session "
     "stands", RUN,
     lambda s: s.replace("    nowhere = nowhere_to_work(piece, root, here)\n"
                         "    if nowhere:\n"
                         "        return HELD_BACK % (cid, nowhere)\n", "")),
    ("a close moves the run on from nowhere in particular, so the copy question is "
     "asked of no directory", TOUCH,
     lambda s: s.replace("said = run.advance(cid, root, closing_actor(cmd, data),\n"
                         "                                   bc.where(data))",
                         "said = run.advance(cid, root, "
                         "closing_actor(cmd, data))")),
    ("a step the run would not hand over is refused in silence", TOUCH,
     lambda s: s.replace("    if held_back:\n"
                         '        told = "\\n\\n".join([told] + held_back)'
                         ".strip()\n", "")),
    ("a close that shuts several cards at once keeps only the last refusal, so "
     "the cards before it are held back in silence", TOUCH,
     lambda s: s.replace("                if said:\n"
                         "                    held_back.append(said)",
                         "                held_back = [said] if said else held_back")),
    ("whoever closed a card is read off the whole line, so a reason that speaks of "
     "the stamp hands the job to a word out of a sentence", TOUCH,
     lambda s: s.replace(
         "    return stamped_name(cmd) or bc.actor(",
         '    got = re.search(r"--actor[= ]+(\\S+)", cmd or "")\n'
         "    if got:\n"
         "        return got.group(1)\n"
         "    return bc.actor(")),

    # The opening text every session is handed before it reads any code: a run of
    # steps written out there by hand, and the refusal the cut stopped asking for
    # (bw-a6o.2).
    ("the opening text spells its own run of steps instead of the playbook's", PRIME,
     lambda s: s.replace('        steps=", ".join(("[%s]" % s) if spine.tier(s) '
                         "!= spine.MUST else s\n"
                         "                        for s in spine.ORDER))]",
                         '        steps="worktree, [clarify], work, [prove], '
                         'verify, review, land")]')),
    ("a session is refused the next piece of the very job its copy holds", CLOSE,
     lambda s: s.replace("            if not goal or goal == skip:\n",
                         "            if not goal:\n")),
    ("a session is still told to write a refusal for every step it does not run",
     PRIME,
     lambda s: s.replace("  --steps <the optional ones it runs>`, which creates "
                         "the goal and its first step.",
                         "  --steps <the ones it runs> --skip <one it does not>="
                         '"why"`, which creates the goal.')),

    # The rule the retired worktree step used to carry, asked of the claim
    # instead (bw-1tgx). A refusal that names no command leaves the session with
    # what it already half-remembered from the documents, which is the state
    # bw-kcz found this rule in.
    ("a session with nowhere to make the change is told so and not told how",
     CLOSE,
     lambda s: s.replace(
         '           "\\n  ".join(cut(where, goal) for where in spots))',
         '           "")')),
    ("a copy of its own is asked of every card, not only the ones that make code",
     CLOSE,
     lambda s: s.replace(
         '    return (not set(card.get("labels") or []) & set(NO_CODE)\n'
         '            and card.get("issue_type") not in ("decision", "epic"))',
         "    return True")),
    ("a job whose change lands in another checkout is asked to stand in the copy "
     "it cut there", CLOSE,
     lambda s: s.replace(
         "    if not mine and own_copy(goal, "
         "[w for w in spots if os.path.realpath(w) != home]):\n"
         '        return ""\n', "")),
    ("any copy at all counts as the job's own, so two jobs share one tree one "
     "directory further in", CLOSE,
     lambda s: s.replace("    inside, stood = stood_in(here, root)\n"
                         "    if inside == goal:",
                         "    inside, stood = stood_in(here, root)\n"
                         "    if inside:")),
    ("a second landing lets a job past the copy standing in this checkout", CLOSE,
     lambda s: s.replace(
         "    mine = own_copy(goal, "
         "[w for w in spots if os.path.realpath(w) == home])",
         "    mine = own_copy(goal, spots)\n"
         "    if mine and len(spots) > 1:\n"
         '        return ""')),
    # The refusal is read by the claim and by the run's own hand-over, and only
    # one of those was ever typed by anybody (bw-n1x5.3).
    ("the copy refusal tells a session to claim again a card that nothing ever "
     "claimed", CLOSE,
     lambda s: s.replace('"Then claim it from there."',
                         '"Then claim it again."')),
    # The two states bd does not ship. Both halves of the fault are here — the
    # board never told, and the refusal never said — because either one alone
    # puts the review half of a job back into silence (bw-n5k4).
    # The two faults the outside reader found on this job (bw-aisw.9, .10): a
    # file the project already commits is left in `git status` forever, and a
    # move that undoes itself leaves the server's own settings behind.
    ("a machine-local file the project already commits is left in `git status`",
     JOIN,
     lambda s: s.replace("        return unwatch_tracked(root, rel)\n",
                         "        return\n")),
    ("a board move that undoes itself leaves the server's settings file behind",
     JOIN,
     lambda s: s.replace("    putback(os.path.join(beads, CONFIG), settled)\n", "")),
    # And the two the second reader found (bw-aisw.11, .12): the landing guard
    # written before the board that decides where it goes, and a project's own
    # name written into its declaration as if nothing could be in it.
    ("the landing guard is written before the board that moves where it goes",
     JOIN,
     lambda s: s.replace("    install(said.append)\n    if a.forward:",
                         "    install(said.append)\n    guard(root, said.append)"
                         "\n    if a.forward:")
                .replace("    guard(root, said.append)\n    # After the board is "
                         "where it is going to be", "    # After the board is "
                         "where it is going to be")),
    ("a project's own path is written into the register unquoted", JOIN,
     lambda s: s.replace("quoted(root))", "'\"%s\"' % root)")),
    ("a project's own name is written into its declaration unquoted", JOIN,
     lambda s: s.replace("'name = ' + quoted(base)", "'name = \"%s\"' % base")),
    ("joining a project never tells its board about the review states", JOIN,
     lambda s: s.replace("    states(root, said.append)\n", "")),
    ("joining takes away the states a board already had of its own", JOIN,
     lambda s: s.replace('",".join(have + want)', '",".join(want)')),
    ("a board that was never told about the review states is not told so", JOIN,
     lambda s: s.replace("        said += unstated(root)\n", "")),
    # And the jobs the board refused while it was still refusing: telling it the
    # word does not go back for them, so each waits for a signature nobody can
    # see is owed (bw-n5k4, three of them on the beads app board).
    ("joining never puts back the jobs the board refused into the manager's "
     "column", JOIN,
     lambda s: s.replace("    replace(root, said.append)\n", "")),
    ("putting them back takes a job whose work reopened to the manager, asking "
     "him to sign something still being built", JOIN,
     lambda s: s.replace(
         '        if not meta.get("waiting_since") or meta.get("judge") != "manager":\n',
         '        if meta.get("judge") != "manager":\n')),
    ("a job waiting on the manager outside his column is not reported as "
     "waiting", JOIN,
     lambda s: s.replace("        said += unsigned(root)\n", "")),
    # And the reading of what the board answers. Asked plainly, a board told
    # nothing answers a sentence that reads as a state of its own name, and
    # joining would write that sentence onto it (mch-up1g.16.8).
    ("the states a board was told are asked for in words rather than as JSON",
     DECL, lambda s: s.replace(
         '["bd", "config", "get", CUSTOM_KEY, "--json"]',
         '["bd", "config", "get", CUSTOM_KEY]')),
    ("a board that could not be asked is read as having answered", DECL,
     lambda s: s.replace('if run.returncode == 0 else ""', 'if True else ""')),
    ("the run swallows the board refusing a card into a review column", RUN,
     lambda s: s.replace("    ok, _ = bc.bd([\"update\", goal_id, \"-s\", want], root)\n"
                         "    if ok:\n        return True\n",
                         "    ok, _ = bc.bd([\"update\", goal_id, \"-s\", want], root)\n"
                         "    if True:\n        return ok\n")),
    ("the opening text says a commit is what moves a card into the agents' "
     "review column", PRIME,
     lambda s: s.replace(
         "- Every commit names its card, and a card closes only once a commit "
         "naming it is on\n  main. That is why landing can close a work item for "
         "you: it can see which\n  commits it added and which of your items they "
         "name. A commit on its own moves\n  nothing on the board. A job reaches "
         "the agents'\n  review column when its last piece has closed and nobody "
         "is building it. That is\n  what the column means, and the run puts it "
         "there itself.\n",
         "- Every commit names its card; a commit that is not on main yet moves "
         "that card to\n  in_review, which is what that column means. A card "
         "closes only once a commit\n  naming it is on main.\n")),

    # A reader the account never let run, and both halves of what that costs: the
    # second attempt spent to be told the same sentence, and a job written up as
    # one whose reader answers nothing when nothing about it is broken (bw-aczr.7).
    ("a reader turned away by the account's own limit is fired straight at it again",
     REVIEW,
     lambda s: s.replace("        if parse(out) or limited(out):",
                         "        if parse(out):")),
    ("an account with nothing left to spend is written up as a reader that answers "
     "nothing", REVIEW,
     lambda s: s.replace("    if stopped:\n", "    if False:\n")),

    # One session, one board name, and the copy it works in written onto the card
    # instead (bw-aczr.2). Read the copy back off the name and every card claimed
    # since reads as claimed in the shared tree, so the copy is left on disk with
    # a branch nobody goes back to.
    ("the copy a claim wrote onto the card is never read, so the teardown goes by "
     "the name the card is held under", CLOSE,
     lambda s: s.replace(
         '    named = {l[len(bc.COPY):] for l in card.get("labels") or []\n'
         '             if l.startswith(bc.COPY)}\n',
         "    named = set()\n")),

    # The checks step, proved rather than asserted (bw-aczr.4). Thirty characters
    # and a digit used to close it, so "ran the suites, all green" closed it and
    # nobody could tell afterwards which suites ran, over which code, or whether
    # they were green.
    ("a checks step closes on its own words again, with nothing proving the suites "
     "ever ran", CLOSE,
     lambda s: s.replace('    tool = bc.tool(root, "checks", "")\n',
                         '    return ""\n'
                         '    tool = bc.tool(root, "checks", "")\n')),

    # And the half the gate reads: the note names the tree the suites ran over, so
    # a run that went green before three more commits landed cannot pass for a run
    # over the code standing now.
    ("the checks note names something other than the tree the suites ran over",
     CHECKS,
     lambda s: s.replace('    return git(["write-tree"])\n',
                         '    return "0" * 40\n')),
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
    """A copy of the machinery on its own, carrying what it answers for.

    The archive is the machinery directory alone — that is what a fault is put
    back into. But the suite answers for a project: its systems, its prefix and
    the branch it lands on all come off that project's declaration, and the
    report tools come off the machine's own registry. Neither is inside the
    machinery, so both are laid beside the copy; without them every case that
    pours a card reads a project with no systems at all.
    """
    tmp = tempfile.mkdtemp(prefix="inject-")
    tar = subprocess.Popen(["git", "-C", SRC, "archive", TREE],
                           stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", tmp], stdin=tar.stdout, check=True)
    tar.wait()
    # And a board. Every gate here asks whether the checkout it is standing in
    # has one before it says anything at all, and a copy with none is a copy
    # every one of them stands aside for.
    os.makedirs(os.path.join(tmp, ".beads"), exist_ok=True)
    said = os.path.join(project.root(SRC), project.DECLARATION)
    if os.path.exists(said):
        shutil.copyfile(said, os.path.join(tmp, project.DECLARATION))
    room = project.reports_dir()
    if room:
        with open(os.path.join(tmp, "projects.toml"), "w") as fh:
            fh.write("[home]\nreports = %r\n" % room)
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
