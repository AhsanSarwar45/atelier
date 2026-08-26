#!/usr/bin/env python3
"""Per-session bookkeeping and board queries shared by the board hooks.

State is machine-local, never in the repo: the working tree is shared by every
session and worktree, so session bookkeeping written there would collide.
"""
import json
import os
import re
import shlex
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
import project  # noqa: E402

STATE_DIR = os.path.join(
    os.environ.get("CLAUDE_CODE_TMPDIR") or "/tmp", "board-sessions"
)
BD_TIMEOUT = 20  # seconds; a hook must never outlive a hung board

# Edits here are not project work and never demand a card.
IGNORED = ("/.beads/", "/scratchpad/", "/.git/", "/node_modules/", "/target/")


# A command that starts by changing directory says where it runs. Anchored at
# the start and absolute only, so a `cd` buried mid-pipeline or a relative hop
# inside the session's own tree never re-points the whole command.
_CD_FIRST = re.compile(r"^\s*(?:rtk\s+)?cd\s+(?:--\s+)?(?P<path>/[^\s;&|<>]+|'(?P<sq>/[^']+)'|\"(?P<dq>/[^\"]+)\")")

# One hook process judges one call, so this never grows past a handful.
_HOPPED = {}


def _hop(data):
    """Split a command into the directory it opens by moving to, and the rest.

    Some shells report the directory the session was started in whatever
    directory the command names, and then every command looks like it belongs
    to the session's own project. A command that opens by changing into another
    checkout is telling us plainly where it runs, and that is taken at its word
    — but only when the path is a checkout the machinery knows, so a typo or a
    scratch directory falls back to the session's own tree rather than
    silently answering for nobody.

    Answered once per (directory, command): resolving the named path reads the
    registry and runs git, and every Bash gate asks for both halves of this.
    """
    cwd = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    cmd = (data.get("tool_input") or {}).get("command") or ""
    if (cwd, cmd) in _HOPPED:
        return _HOPPED[(cwd, cmd)]

    answer = (cwd, cmd)
    m = _CD_FIRST.match(cmd)
    if m:
        named = m.group("sq") or m.group("dq") or m.group("path")
        if os.path.isdir(named) and project.root(named) in project.registry().values():
            answer = (named, cmd[m.end():])
    _HOPPED[(cwd, cmd)] = answer
    return answer


def where(data):
    """The directory a hook's own call runs in — see `_hop`."""
    return _hop(data)[0]


def said(data):
    """What the command says, once the move that got it there is taken off.

    A path is not a sentence: a worktree named after the card it holds spells
    that card's id in every command run inside it, and a gate reading the whole
    line would take the directory as the commit's own words.
    """
    return _hop(data)[1]


def board_root(cwd):
    """The project whose board answers for work done here.

    The checkout the work lands in, never the directory the session was started
    from: a commit made in one project by a session whose home is another belongs
    to the first, and `CLAUDE_PROJECT_DIR` answers with the second (cor-up1g).
    Which directory that is, for a hook judging a shell command, is `where`.
    """
    return project.root(cwd)


def _brands():
    """Every name a switch of this machinery may be spelled with.

    The machinery's own, plus the brand each registered project declared. Read
    from the declarations so the list cannot drift from what a project calls
    itself, and cached: this stands in front of every tool call.
    """
    if not hasattr(_brands, "seen"):
        found = ["MACHINERY"]
        for path in project.registry().values():
            brand = project.of(path).brand
            if brand and brand not in found:
                found.append(brand)
        _brands.seen = found
    return _brands.seen


def switch(suffix):
    """What one of this machinery's switches is set to, under any of its names."""
    for brand in _brands():
        value = os.environ.get(brand + "_" + suffix)
        if value:
            return value
    return ""


def reviewing():
    """The review step a headless reviewer was fired at, if this is one.

    A reviewer is not a session doing work: it holds no card, changes no file,
    and must not be told whose cards are open — every board hook stands aside
    for it. `board/review` sets this.
    """
    return switch("REVIEWER")


# The words that put something in front of a command without changing what the
# command does. A refusal a prefix walks around is not a refusal, so every gate
# that decides what a command IS reads this one list — kept twice, the two drift
# and a prefix one gate refuses the other lets straight through.
WRAPPERS = ("env", "command", "exec", "nice", "setsid", "stdbuf", "time",
            "sudo", "timeout", "rtk", "proxy", "nohup", "ionice", "xargs")

# Carriers that hand a command its arguments from somewhere else. What such a
# command writes to cannot be read off the command at all — the same position a
# name the shell works out leaves the reader in.
FEEDERS = ("xargs",)


def fed(seg):
    """Whether this command's arguments are handed to it from somewhere else."""
    return any(os.path.basename(w) in FEEDERS for w in words(seg))


# The shell's own words, which a command can be written behind. The line is cut
# at the separators, which leaves these standing in front of the command — and a
# prefix a gate does not strip is a prefix that walks around it, exactly as a
# carrier word was before the list above existed.
KEYWORDS = ("if", "then", "else", "elif", "while", "until", "do", "done", "fi",
            "case", "esac", "!", "{", "}", "[[", "]]")

# The git switches that swallow the word after them, so a value is never read as
# the verb. `-C` is the one that decides which checkout a command is judged in.
GIT_TAKES_VALUE = ("-C", "-c", "--git-dir", "--work-tree", "--namespace",
                   "--exec-path", "--super-prefix", "--config-env")

# Shells that take a whole command line as an argument. What they are handed is
# a command line and is read as one; anything less leaves every route open
# behind four characters.
SHELLS = ("bash", "sh", "zsh", "dash", "ksh")


# Reading a command line. One shared list of carrier words was not enough on its
# own: the gates have to take them OFF the same way too, or a prefix one gate
# refuses is one the other lets straight through. Both read a line through these.


# How a here-document opens, and the word that ends it. The body between is DATA
# handed to a command, never shell.
_HEREDOC = re.compile(r"(?<!<)<<(?!<)-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def _openers(line):
    """The here-document delimiters this line opens, and whether each is quoted.

    Found with the quoting around the `<<` and never around the word after it:
    the delimiter is quoted on purpose — that is how a body is kept literal — but
    a shift operator inside a commit message is an argument, and reading it as an
    opener makes every line after it data that nobody judges.
    """
    out, quote, i = [], "", 0
    while i < len(line):
        ch = line[i]
        if quote:
            quote = "" if ch == quote else quote
            i += 1
            continue
        if ch in "'\"":
            quote = ch
            i += 1
            continue
        got = _HEREDOC.match(line, i)
        if got:
            out.append((got.group(2), bool(got.group(1))))
            i = got.end()
            continue
        i += 1
    return out


def _to_a_shell(line):
    """Whether the command on this line is a shell, so what it is handed on its
    own input is a command line rather than data."""
    argv = plain(words(line))[1]
    return bool(argv) and os.path.basename(argv[0]) in SHELLS


def _without_heredocs(cmd):
    """The line with every here-document body taken out, and the command lines
    that still run from inside the unquoted ones.

    A body is what a command is being HANDED, not what the shell runs: a script
    written with `cat > x <<'EOF'` is full of text that reads like commands and
    is none of them, and reading it as commands refuses the writing of any script
    that mentions one. With the delimiter left unquoted the shell does still work
    substitutions out inside the body, and those do run.
    """
    kept, ran, waiting = [], [], []
    for line in cmd.split("\n"):
        if waiting:
            want, quoted, shell = waiting[0]
            if line.strip() == want:
                waiting.pop(0)
            elif shell:
                # What a SHELL is handed on its own input is a command line, and
                # every route is open behind four characters if it is not read.
                ran.append(line)
            elif not quoted:
                ran += grown_in(line)
            continue
        kept.append(line)
        shell = _to_a_shell(line)
        waiting += [(name, quoted, shell) for name, quoted in _openers(line)]
    if waiting:
        # An opener whose closing word never arrives is not a here-document at
        # all, and dropping the rest of the line for it is the one failure
        # direction this guard must not have. Read the whole thing instead.
        return cmd, []
    return "\n".join(kept), ran


def split(cmd):
    """Each command on the line with the separator that came before it.

    Quoted stretches, escapes and nested commands are stepped over rather than
    searched: a card note quoting a fold is words, a bracket in prose is not a
    separator, and the brackets of a nested command belong to the command around
    them. Reading any of those as a separator cuts a command in half and lets the
    harmless-looking half stand for the whole.

    The separator is kept because two questions need it: a command handed its
    input by a pipe cannot be read at all, and a directory change made inside
    brackets does not outlive them.
    """
    cmd, ran = _without_heredocs(cmd)
    out, cur, sep, quote, depth, i = [], [], "", "", 0, 0
    while i < len(cmd):
        ch = cmd[i]
        if ch == "\\" and i + 1 < len(cmd) and quote != "'":
            cur.append(cmd[i:i + 2])
            i += 2
            continue
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = ""
        elif depth:
            cur.append(ch)
            depth += 1 if ch == "(" else (-1 if ch == ")" else 0)
        elif cmd[i:i + 2] == "$(":
            cur.append("$(")
            depth, i = 1, i + 2
            continue
        elif ch in "'\"`":
            quote = ch
            cur.append(ch)
        elif ch in ";&|()\n":
            out.append((sep, "".join(cur).strip()))
            cur, sep = [], ch
        else:
            cur.append(ch)
        i += 1
    out.append((sep, "".join(cur).strip()))
    for inside in ran:
        out += split(inside)
    return out


def segments(cmd):
    """Each command on the line, in the order the shell would run them."""
    return [seg for _, seg in split(cmd) if seg]


def piped_into_shell(cmd):
    """Whether any pipeline on this line ends by handing a shell its commands.

    What is piped in is whatever the left-hand side prints, and that is not
    settled until it runs — so the commands that shell will run cannot be read
    here at all. Saying so is the only honest answer; letting it past leaves
    every route open behind a pipe and four characters.
    """
    for sep, seg in split(cmd):
        if sep != "|" or not seg:
            continue
        argv = plain(words(seg))[1]
        if argv and os.path.basename(argv[0]) in SHELLS and handed_on(argv) is None:
            return True
    return False


# Stands in for a space inside a stretch the shell works out, so the splitter
# leaves that stretch whole. Never a character a command carries.
HELD = "\x00"


def _held(seg):
    """The same text with the spaces inside `$(…)` and backquotes held.

    A stretch the shell works out becomes ONE word when the shell runs it, so it
    is one word here. Split into several, it inflates the count of arguments that
    decides which line a command writes to — and the argument that decides then
    comes out as a word from the middle of the substitution (mch-mkp.59).
    """
    out, depth, tick, i = [], 0, False, 0
    while i < len(seg):
        ch = seg[i]
        if not tick and seg[i:i + 2] == "$(":
            depth, i = depth + 1, i + 2
            out.append("$(")
            continue
        if depth and ch in "()":
            depth += 1 if ch == "(" else -1
        elif ch == "`":
            tick = not tick
        out.append(HELD if (depth or tick) and ch.isspace() else ch)
        i += 1
    return "".join(out)


def words(seg):
    """One command as the shell would hand it over, quotes taken off.

    A line naming its target in quotes names the same target, and reading the
    quoted spelling as no target at all is how every refusal is walked past.
    """
    try:
        split = shlex.split(_held(seg))
    except ValueError:
        split = _held(seg).split()
    return [w.replace(HELD, " ") for w in split]


def plain(argv):
    """The command itself and the settings put in front of it.

    Once a carrier has been seen its own switches and values are carried too, so
    `nice -n 10 git push …` and `sudo -u me git commit …` reach the same answer as
    the bare command. The settings are handed back rather than dropped: two of
    them aim a command at a checkout of its own.
    """
    put, carried = {}, False
    while argv:
        head = argv[0]
        if "=" in head and not head.startswith("-"):
            name, _, value = head.partition("=")
            put[name] = value
            argv = argv[1:]
        elif head in KEYWORDS:
            argv = argv[1:]
        elif head in WRAPPERS:
            argv, carried = argv[1:], True
        elif carried and os.path.basename(head) not in ("git", "gh", "eval") + SHELLS:
            argv = argv[1:]
        else:
            break
    return put, argv


def handed_on(argv):
    """The command line a shell was handed to run, or None if it was not one.

    The switch is read out of a bundle rather than matched whole: `sh -euc …` and
    `bash -lc …` are the everyday spellings of what `sh -c` spells long-hand, and
    a shell whose switches are bundled runs the same command. `eval` is the same
    thing without a shell in front of it: what it is handed is a command line,
    however many words it is typed in.
    """
    if not argv:
        return None
    if os.path.basename(argv[0]) == "eval":
        return " ".join(argv[1:]) or None
    if os.path.basename(argv[0]) not in SHELLS:
        return None
    for i, arg in enumerate(argv[1:], 1):
        if arg.startswith("-") and not arg.startswith("--") and "c" in arg[1:] \
                and i + 1 < len(argv):
            return argv[i + 1]
    return None


def git_verb(argv):
    """The git subcommand this command is, or "" when it is not git.

    Git's own switches come before the verb and several swallow the word after
    them, so a verb picked out by pattern is a verb missed the moment one is
    used. Both gates ask this, and asking it in two places is how they came to
    disagree about what a commit is.
    """
    if not argv or os.path.basename(argv[0]) != "git":
        return ""
    i = 1
    while i < len(argv):
        arg = argv[i]
        if not arg.startswith("-"):
            return arg
        if "=" not in arg and arg in GIT_TAKES_VALUE:
            i += 1
        i += 1
    return ""


def _unkeyed(seg):
    """The same command with the shell's own words in front of it taken off."""
    while True:
        head, _, rest = seg.partition(" ")
        if head in KEYWORDS and rest.strip():
            seg = rest.lstrip()
        else:
            return seg


def grown_in(cmd):
    """Every command line written as a substitution inside this one.

    A substitution RUNS what is inside it, wherever it stands: `$(git push origin
    main)` pushes, and so does `echo $(git push origin main)`. The reader keeps a
    substitution as one word so the count of arguments stays right, which is
    exactly what would leave the command inside it read by nobody.
    """
    out, i = [], 0
    while i < len(cmd):
        if cmd[i:i + 2] == "$(":
            depth, j = 1, i + 2
            while j < len(cmd) and depth:
                depth += 1 if cmd[j] == "(" else (-1 if cmd[j] == ")" else 0)
                j += 1
            out.append(cmd[i + 2:j - 1] if not depth else cmd[i + 2:j])
            i = j
            continue
        if cmd[i] == "`":
            j = cmd.find("`", i + 1)
            if j < 0:
                break
            out.append(cmd[i + 1:j])
            i = j + 1
            continue
        i += 1
    return [t for t in (part.strip() for part in out) if t]


# How deep a shell handed to a shell is followed. Each hop is a real spelling;
# past a handful it is somebody testing the reader rather than running work.
HANDS = 8


def unshelled(cmd, depth=0):
    """The same line with what a shell was handed put back on it as commands.

    Quoted words are a card's own text everywhere a gate looks, which is what
    keeps a note quoting a close from being read as one — the word a shell is
    handed is the single exception, because it is a command line and it runs. A
    gate that reads the line as text unwraps it here before reading anything.
    """
    out = []
    for seg in segments(cmd):
        script = handed_on(plain(words(seg))[1]) if depth < HANDS else None
        out.append(unshelled(script, depth + 1) if script is not None
                   else _unkeyed(seg))
        if script is None and depth < HANDS:
            # What a substitution holds runs too, wherever on the line it stands.
            out += [unshelled(inside, depth + 1) for inside in grown_in(seg)]
    return "\n".join(out)


# Seconds a waiver stands before the board comes back on by itself. A waiver is
# given for one piece of work, and a session still alive this long after is on
# different work than the one he waived.
WAIVER_KEEP = 4 * 3600


def waiver_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "nosession")
    return os.path.join(STATE_DIR, "waived-" + safe + ".json")


def waived(session_id):
    """What the manager said when he took the board off this session, or None.

    One session's and never the machine's: keyed on the session id, so a waiver
    given here cannot strip the refusals off a session he never spoke to.
    `board/waive` writes it and is the only thing that may.
    """
    try:
        with open(waiver_path(session_id)) as fh:
            row = json.load(fh)
    except Exception:
        return None
    return None if now() - (row.get("t") or 0) > WAIVER_KEEP else row


# Where a job waits for the manager's own signature. A custom board status rather
# than a label, because a label can be taken off by whoever put it on. The word
# itself is declared once, with the other state bd does not ship (project.py).
MANAGER_REVIEW = project.MANAGER_REVIEW
# Where a job waits for a reader who did not write it. Custom for the same reason,
# and refused by the same board that was never told about either.
AGENT_REVIEW = project.AGENT_REVIEW

# What a goal wears to say its change lands somewhere else.
LANDS = "lands:"


def elsewhere(root):
    """The repositories a job here may say its change lands in, by the name it
    declares and the branch each one calls main.

    Two answers at once, and both are needed: the project's own declaration says
    where its work may go, and the registry says whether that project is on this
    machine. A repository nobody registered is not somewhere a card's commit may
    hide, and one this project never declared is not somewhere its work goes.
    """
    return project.elsewhere(project.of(root))


def declared(cid, root):
    """The other repositories the job owning this card says its change lands in.

    Read off the goal, so it is the job that declares it and not the card: a
    global list would let any card on the board close on the strength of a commit
    in a repository its job never touched.
    """
    goal = (cid or "").split(".")[0]
    if not goal:
        return []
    ok, out = bd(["show", goal, "--json"], root)
    if not ok:
        return []
    try:
        card = json.loads(out or "{}")
        card = card[0] if isinstance(card, list) else card
    except Exception:
        return []
    return [l[len(LANDS):] for l in card.get("labels") or [] if l.startswith(LANDS)]


def here(name, root):
    """Whether a declared repository is on this machine. `.git` is a file in a
    checkout that is itself a worktree, so its kind is not asked."""
    path = (elsewhere(root).get(name) or (None,))[0]
    return bool(path) and os.path.exists(os.path.join(path, ".git"))


def landings(root, cid=None):
    """Every (repository, main branch) this card's commit may have reached.

    This checkout always, on whatever branch this project calls main; one its job
    declared, when that one is on this machine. A card whose job declares nothing
    is judged here alone.
    """
    known = elsewhere(root)
    return [(root, project.of(root).lands_on)] \
        + [known[n] for n in declared(cid, root) if n in known]


def searched(root):
    """Every (repository, main branch) a reading looks in for a job's commits.

    Wider than `landings`, and deliberately: what a card may CLOSE against is a
    rule and stays narrow, but what a reader is SHOWN is only a search, and a
    search that misses a commit signs off on a change nobody read. The label was
    the only thing that widened it, nothing writes the label, and so a job whose
    change lands in another checkout was read as having produced nothing at all
    (mch-4cl). Every checkout this project declared it may land in is searched,
    label or no label; a `git log --grep` in a checkout the job never touched
    finds nothing and costs a moment.
    """
    seen = [(root, project.of(root).lands_on)]
    for where, main in elsewhere(root).values():
        if where not in {w for w, _ in seen} and os.path.isdir(where):
            seen.append((where, main))
    return seen


def unreachable(cid, root):
    """Declared repositories this machine cannot answer for.

    Named rather than skipped: a card whose only proof is there would otherwise be
    refused as never landed, which is a different thing and sends the reader to
    look for a commit that exists.
    """
    return [n for n in declared(cid, root) if not here(n, root)]


# What a card says about the copy the work on it is being done in. The claim
# writes it (hooks/board-actor.py, board/run.py `hand_over`); the teardown and
# the next job's claim read it back.
COPY = "copy:"


def actor(session_id, cwd):
    """Board identity of one session: which session it is, and nothing else.

    A claim is exclusive per actor name, so two live sessions sharing a name
    would both believe they hold the same card. A session id is unique, so the
    session alone keeps them apart.

    The folder used to open this name, and that is what made a card claimed in
    the shared tree impossible to close from the job's copy: bd refuses a close
    whose actor is not the assignee, and it refused 89 of them over 537 sessions.
    So the copy is written on the card instead (`copy_label`). `cwd` is still
    taken, because every caller has one and because it is what says which copy.
    """
    return "s-%s" % (session_id or "nosession")[:8]


def copy_label(cwd):
    """What the card is told about the copy this work is being done in.

    The folder the copy sits in, which is the goal it was cut for, or `main` for
    the checkout every session shares. On the card rather than in the name,
    because a card outlives the directory a session happened to type from and the
    name has to stay the same wherever the session stands (`actor`).
    """
    place = re.search(r"/worktrees/([^/]+)", cwd or "")
    return COPY + (place.group(1) if place else "main")


def held_by(name, session_id):
    """Whether a board name recorded earlier belongs to this session.

    Its own name, and also the names it used before a name carried only the
    session: `main-<sid>` and `<copy>-<sid>` are this session too, so a claim made
    before the change is not orphaned by it. Compat, and the only thing keeping
    the split here — it can go once no old-style claim is open.
    """
    return bool(name) and name.rsplit("-", 1)[-1] == (session_id or "nosession")[:8]


def _path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "nosession")
    return os.path.join(STATE_DIR, safe + ".json")


def load(session_id):
    try:
        with open(_path(session_id)) as fh:
            return json.load(fh)
    except Exception:
        return {"edits": [], "created": [], "last_stop": 0.0, "last_beat": 0.0}


def save(session_id, state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = _path(session_id) + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh)
    os.replace(tmp, _path(session_id))


# Where the reading of the manager's own message leaves its answer, one file per
# prompt (hooks/habit-reading.py writes it, board-gate.py reads it back).
# A directory of its own: cost.py counts every loose `*.json` here as a session
# record it could not parse.
HABIT_DIR = os.path.join(STATE_DIR, "habit")
# The kill switch, in two reaches: the variable is one session's, the file is every
# session on this machine at once. docs/board.md#5 says which to use. The variable
# answers to its branded spelling in every project too (`switch`).
HABIT_OFF_VAR = "MACHINERY_NO_HABIT_GATE"
HABIT_OFF_FILE = os.path.join(STATE_DIR, "no-habit-gate")
HABIT_KEEP = 6 * 3600  # seconds an answer is kept before the next reading sweeps it


def habit_off():
    return bool(switch("NO_HABIT_GATE")) or os.path.exists(HABIT_OFF_FILE)


def habit_path(prompt_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", prompt_id or "noprompt")
    return os.path.join(HABIT_DIR, safe + ".json")


def habit_write(prompt_id, row):
    """Record what the reading knows so far. Never raises: this hook stands in front
    of every message the manager sends, and a full disk must not swallow one."""
    try:
        os.makedirs(HABIT_DIR, exist_ok=True)
        tmp = habit_path(prompt_id) + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(row, fh)
        os.replace(tmp, habit_path(prompt_id))
    except Exception:
        pass


def habit_read(prompt_id, wait=0.0):
    """The reading's answer, or `{}` for none.

    `wait` seconds are given to one still running. The reading is fired the moment
    the message arrives and a turn is normally far longer than it takes, so this is
    the short tail rather than the usual case. No answer, an unreadable one and one
    that never arrives are the same thing here, and all three let the turn end: a
    gate that cannot be sure must not refuse.
    """
    until = time.time() + max(0.0, wait)
    while True:
        try:
            with open(habit_path(prompt_id)) as fh:
                row = json.load(fh)
        except Exception:
            row = {}
        if not isinstance(row, dict):
            return {}
        if row.get("state") != "reading" or time.time() >= until:
            return row
        time.sleep(0.5)


def habit_sweep():
    """Drop answers older than the span above. Never raises."""
    try:
        for name in os.listdir(HABIT_DIR):
            full = os.path.join(HABIT_DIR, name)
            if time.time() - os.path.getmtime(full) > HABIT_KEEP:
                os.remove(full)
    except Exception:
        pass


def bd(args, cwd=None):
    """Run bd; return (ok, stdout). Never raises — a board hiccup must not take
    the session's tool call down with it."""
    try:
        run = subprocess.run(
            ["bd"] + args, capture_output=True, text=True,
            cwd=cwd or os.environ.get("CLAUDE_PROJECT_DIR") or None,
            timeout=BD_TIMEOUT,
        )
        return run.returncode == 0, run.stdout
    except Exception:
        return False, ""


def machine_name(cwd=None):
    """The name bd falls back to when a command escaped the actor stamp — shared
    by every session on this machine, so a claim under it owns nothing."""
    try:
        run = subprocess.run(["git", "config", "user.name"], capture_output=True,
                             text=True, cwd=cwd, timeout=5)
        return run.stdout.strip() or os.environ.get("USER") or ""
    except Exception:
        return os.environ.get("USER") or ""


def holders(session_id, cwd=None):
    """The cards this session holds, keyed by the name each is held under.

    Keyed rather than flattened because bd refuses to heartbeat or close a claim
    under any name but the one it was made with, and a session that was in flight
    when the board name lost its folder holds cards under the old spelling as
    well as the new (`held_by`). The keying goes once no old-style claim is open.

    None when the board could not answer, which is never the same as no cards.
    """
    ok, out = bd(["list", "--status", "in_progress", "--brief", "--json"], cwd)
    if not ok:
        return None
    try:
        rows = json.loads(out or "[]") or []
    except Exception:
        return {}
    got = {}
    for row in rows:
        who = (row or {}).get("assignee") or ""
        if row.get("id") and held_by(who, session_id):
            got.setdefault(who, []).append(row["id"])
    return got


def held(actor_name, cwd=None, session_id=None):
    """Cards this session holds in progress.

    `session_id` widens the question to every name this session has ever held a
    card under, which is what keeps a claim made before the name lost its folder
    from reading as somebody else's. Without it one exact name is asked after,
    which is what `machine_name` needs: that name is nobody's session and matches
    no session id at all.
    """
    if session_id:
        got = holders(session_id, cwd)
        return None if got is None else sorted(c for ids in got.values() for c in ids)
    ok, out = bd(["list", "--status", "in_progress", "--assignee", actor_name,
                  "--brief", "--json"], cwd)
    if not ok:
        return None
    try:
        return [row["id"] for row in json.loads(out or "[]")]
    except Exception:
        return []


def _covered(cid, when, claims, closes, held):
    """Whether this card was standing over an edit made at `when`."""
    before = sorted(t for t in claims.get(cid, ()) if t <= when)
    if not before:
        # No claim on record: the card is still held, or its claim aged out of a
        # log that keeps the last 200 — trust it up to the moment it was closed.
        return cid in held or any(t >= when for t in closes.get(cid, ()))
    return not any(before[-1] <= t < when for t in closes.get(cid, ()))


def unowned(state, edits, held, since):
    """The edits no card was standing over at the moment they were made.

    A card is judged where the edit falls, never by what is left held when the
    turn ends: closing the last step of a job empties the held set while the
    turn's work stands, so a clean finish would otherwise look exactly like work
    done under no card at all. A claim made mid-turn covers the whole turn, which
    is the leniency the held-set answer had.
    """
    claims, closes = {}, {}
    for c in state.get("claims") or []:
        t = c.get("t") or 0
        claims.setdefault(c.get("id"), []).append(since if t >= since else t)
    for c in state.get("closed") or []:
        closes.setdefault(c.get("id"), []).append(c.get("t") or 0)
    held = set(held or [])
    cards = set(claims) | set(closes) | held
    return [e for e in edits
            if not any(_covered(c, e.get("t") or 0, claims, closes, held) for c in cards)]


def prefix(root):
    """Card id prefix this project issues.

    Declared, because a gate has to know it before it may run a board command and
    because it is the one fact every refusal is written against. A project that
    has not declared one is asked of its board, and that answer is cached: this
    runs behind every tool call.
    """
    said = project.of(root).prefix
    if said:
        return said
    cache = os.path.join(STATE_DIR, "prefix-" + re.sub(r"\W", "_", root))
    try:
        with open(cache) as fh:
            return fh.read().strip() or "bd"
    except Exception:
        pass
    ok, out = bd(["config", "get", "issue_prefix"], root)
    name = (out or "").strip() if ok else ""
    if name:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(cache, "w") as fh:
            fh.write(name)
    return name or "bd"


def project_edit(path, root):
    """True when a path is project work rather than bookkeeping or scratch."""
    if not path:
        return False
    full = path if os.path.isabs(path) else os.path.join(root, path)
    if not full.startswith(root.rstrip("/")):
        return False
    return not any(part in full for part in IGNORED)


def now():
    return time.time()


def tool(root, name, where="board"):
    """How a session standing in this project types one of the machinery's tools.

    A refusal that names a command the agent cannot run teaches nothing, and the
    tools live outside every project: one carrying a forwarder at the old path is
    told that path, one without is told the tool's own (`project.tool`).
    """
    return project.tool(project.of(root), name, where)


def prefixes(root):
    """Every card id prefix a commit made in this checkout may name.

    This project's own, and that of any project whose declaration says its work
    lands here. Both, because a change split across two repositories is one job:
    the card is the first project's and the commit is in the second.
    """
    return project.prefixes(project.of(root)) or [prefix(root)]


def specs_dir():
    """Where this machine keeps report specs and the pages built from them.

    A report is one person's own work about their own projects, so it lives
    where this computer keeps a program's data and never inside a copy of the
    product — the same three cases the report tool itself follows
    (reporting/bin/report). Read here rather than asked of it: this runs inside
    a gate, and a gate that shells out for a path is a gate that hangs while the
    tool it asks is being edited.
    """
    said = os.environ.get("REPORTS_DIR")
    if said:
        return os.path.expanduser(said)
    home = _app_home("atelier", ("com.weselow.atelier", ("weselow", "atelier")))
    # A machine where the renamed product has not been run yet still has its
    # reports under the earlier folder; the program moves them across on its
    # first run, and until then this reads where they actually are.
    if not os.path.isdir(home):
        earlier = _app_home("kanban-ui", ("com.beads.kanban-ui", ("beads", "kanban-ui")))
        if os.path.isdir(earlier):
            home = earlier
    return os.path.join(home, "reports")


def _app_home(name, windows_and_mac):
    """Where a program of this name keeps its data, per platform."""
    mac, (org, app) = windows_and_mac
    if sys.platform == "darwin":
        home = "~/Library/Application Support/" + mac
    elif os.name == "nt":
        roaming = os.environ.get("APPDATA") or "~/AppData/Roaming"
        home = os.path.join(roaming, org, app, "data")
    else:
        home = os.path.join(os.environ.get("XDG_DATA_HOME") or "~/.local/share", name)
    return os.path.expanduser(home)


# Cards on which nothing was implemented: something merely noticed, a question
# put to the manager, or a ruling the manager made.
NO_FINISHED_WORK = ("find", "question", "decision")
