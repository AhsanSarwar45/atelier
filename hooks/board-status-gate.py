#!/usr/bin/env python3
"""PreToolUse (Bash) — a card's shape, and the moments its status may change.

Claiming, committing and closing are the three moments a card moves, and each
is checked against something outside the board: an unblocked graph, a commit
that names the card, and that commit sitting on the main line. Making a card is
the fourth: a hand-written card can skip every field the shape requires, so the
two tools that cannot are the only way in.
"""
import datetime
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "board"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
import board_common as bc  # noqa: E402
import reading  # noqa: E402
import run  # noqa: E402
import sections  # noqa: E402
import spine  # noqa: E402

# Anchored twice over: at a command start, so a document that merely quotes one
# of these is not one; and on the subcommand slot, so the same word appearing
# later — inside a card's own text — is text.
START = r"(?:^|[;&|(]\s*|^\s*)"
# The wrappers that put a word in front of `bd` without changing what it does,
# read from the one list every gate shares (`board_common.WRAPPERS`) — and with
# the carrier's OWN switches and their values eaten, up to the tool itself, so
# `nice -n 10` and `sudo -u me` reach the same answer as the bare word. Consuming
# only `NAME=value` covers `env` alone and leaves every other carrier's ordinary
# spelling through.
WRAP = r"(?:(?:%s)(?:\s+(?!(?:bd|git|rtk)\b)\S+)*\s+|\\)*" % "|".join(bc.WRAPPERS)
VERB = START + WRAP + r"bd\s+(?:--?\S+(?:[= ]\S+)?\s+)*"
# The newline belongs in these bounds as much as the separators do: unwrapping a
# shell puts each command on a line of its own, so a pattern that ran to the next
# `;` would otherwise run across two commands and judge a listing as a close.
CLOSE = re.compile(VERB + r"(?:close\b|update\b[^|;&\n]*(?:-s|--status)[= ]closed\b)",
                   re.M)
CLAIM = re.compile(VERB + r"update\b[^|;&\n]*--claim\b", re.M)
FORCE = re.compile(r"--force\b")
AMEND = re.compile(r"--amend\b")
CREATE = re.compile(VERB + r"(?:create|create-form|q|todo\s+add)\b", re.M)
RESOLVE = re.compile(VERB + r"gate\s+resolve\b", re.M)
RESTATUS = re.compile(VERB + r"(?:update\b[^|;&\n]*(?:-s|--status)[= ]|reopen\b)", re.M)
REVIEWING = re.compile(r"(?:-s|--status)[= ]in_review\b")
# Closing without a commit is legitimate only for cards that produce no code.
NO_CODE = ("no-code", "find", "question", "decision")
UNREPORTED = bc.UNREPORTED
# Said when a goal cannot close because nobody has read it. The reading has no card
# of its own, so "close the steps" is the wrong instruction for that one.
UNREAD = (
    " The reading is not one of them — it has no card. The board sends a reader when "
    "a job's last piece closes and it signs the goal itself; if that one died, "
    "`%s --rerun` sends another."
)


def commits(cmd):
    """Whether this line makes a commit, read the way both gates read a command.

    Through the shared reader rather than by a pattern of its own: git's leading
    switches, a carrier word, a shell keyword and a shell handed the line are all
    ways of writing the same commit, and a rule with its own reading is a rule
    that disagrees with the line guard about what a commit is. A commit quoted
    inside a card's note stays words — it is an argument of `bd`, never the first
    word of a command.
    """
    return any(bc.git_verb(bc.plain(bc.words(seg))[1]) == "commit"
               for seg in bc.segments(cmd))


# How much of a message file is read looking for a card id. A commit message is
# a screenful; anything past this is not one.
MESSAGE_CAP = 64 * 1024


def message_files(cmd, root):
    """The files a commit on this line takes its message from.

    A commit written with `-F` carries its card id in the file and not on the
    line, so a rule reading only the line refuses every one of them with no way
    through — which is the gate stopping correct work rather than wrong work.
    """
    out = []
    for seg in bc.segments(cmd):
        argv = bc.plain(bc.words(seg))[1]
        if bc.git_verb(argv) != "commit":
            continue
        i = 0
        while i < len(argv):
            name, eq, value = argv[i].partition("=")
            if name in ("-F", "--file"):
                if not eq and i + 1 < len(argv):
                    value, i = argv[i + 1], i + 1
                if value and value != "-":
                    out.append(value if os.path.isabs(value)
                               else os.path.join(root, value))
            i += 1
    return out


def written_in(paths):
    """What those files say, or "" for one that cannot be read."""
    said = []
    for path in paths:
        try:
            with open(path) as fh:
                said.append(fh.read(MESSAGE_CAP))
        except Exception:
            continue
    return "\n".join(said)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def git(args, root):
    try:
        run = subprocess.run(["git"] + args, capture_output=True, text=True,
                             cwd=root, timeout=15)
        return run.stdout.strip() if run.returncode == 0 else ""
    except Exception:
        return ""


def show(cid, root):
    ok, out = bc.bd(["show", cid, "--json"], root)
    if not ok:
        return None
    try:
        card = json.loads(out or "{}")
        return card[0] if isinstance(card, list) else card
    except Exception:
        return None


def stamp(text):
    """A board timestamp in seconds, or None when there is none to read."""
    try:
        return datetime.datetime.fromisoformat(
            (text or "").replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def tally(name):
    """One row for the manager's count of what a refusal costs (board/cost.py).

    Counted after the refusal is already printed, and never at the cost of it: a
    full disk must not turn a gate into a gate that lets things through.
    """
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)),
                                        "..", "board"))
        import cost
        cost.record(name)
    except Exception:
        pass


def landing_names(cid, card, root):
    """The names a commit may use to land this card.

    Its own, and any ancestor that is a step: a step cannot be merged while a work
    item under it is open, so the commit that lands the step is the commit that
    lands every item of it. The goal never counts — one commit naming it used to
    close every step at once, so a step's status said what the job had done rather
    than what the step had. A work item poured today hangs off the goal and so
    widens to nothing, which is the strictness this keeps.

    Manager's ruling, 2026-08-13 (cor-z9qn): the price is that one commit makes
    every item of its step closable at once.
    """
    names = [cid]
    seen, parent = {}, cid
    while "." in parent:
        parent = parent.rsplit(".", 1)[0]
        seen[parent] = show(parent, root) or {}
        if any(l.startswith("step:") for l in seen[parent].get("labels") or []):
            names.append(parent)
    # A job poured before that ruling keeps the old goal-wide reading, because its
    # commits are already written and already on main.
    goal = next((l[3:] for l in card.get("labels") or [] if l.startswith("of:")), None)
    if goal and "build" in ((seen.get(goal) or show(goal, root) or {})
                            .get("metadata") or {}).get("spine", ""):
        names.append(goal)
    return list(dict.fromkeys(names))


# Answers that cost a git call and cannot change inside one refusal. This hook
# runs in front of the user's command, and the edit log it walks holds hundreds.
_ASKED = {}


def trees(root):
    """Every checkout of this repo, longest path first.

    A job is worked in a worktree, so most edits are made in one; git's own
    register is the list, since a worktree's files are ignored from the main
    checkout and invisible to any question asked there. Longest first because
    the worktrees live under the main checkout, whose path is a prefix of theirs.
    """
    if ("trees", root) not in _ASKED:
        out = [line.split(" ", 1)[1].rstrip("/")
               for line in git(["worktree", "list", "--porcelain"], root).splitlines()
               if line.startswith("worktree ")]
        if root.rstrip("/") not in out:
            out.append(root.rstrip("/"))
        _ASKED[("trees", root)] = sorted(out, key=len, reverse=True)
    return _ASKED[("trees", root)]


def submodules(tree):
    """The repositories checked out inside this one, by their place in it.

    A file inside one belongs to no index entry of the tree around it, so asking
    the outer repository about it answers nothing at all: what lands it is the
    submodule's own commit, and then the moved pointer to it.
    """
    if ("subs", tree) not in _ASKED:
        listed = git(["config", "--file", ".gitmodules", "--get-regexp", r"path$"], tree)
        _ASKED[("subs", tree)] = sorted(
            (line.split(" ", 1)[1].strip("/") for line in listed.splitlines() if " " in line),
            key=len, reverse=True)
    return _ASKED[("subs", tree)]


def in_repo(path, root):
    """The checkout a file was edited in, and its place inside that checkout.

    Every checkout holds the same file at its own absolute path, so a question
    asked about one of them alone is answered by whichever tree the command
    happened to run in.
    """
    for tree in trees(root):
        if path.startswith(tree + "/") and bc.project_edit(path, tree):
            return tree, path[len(tree) + 1:]
    return "", ""


def named_in(text, prefix):
    """The cards a commit message names."""
    return set(re.findall(r"\b%s-[0-9a-z.-]{2,16}\b" % re.escape(prefix), text))


def carried(names, cid, goal):
    """Whether a commit naming `names` puts this file on another card of the job.

    The step's own name carries nothing — that is the step doing the work it said
    it would not — and neither does a card belonging to some other job: the work
    has to sit where this job's reader will read it.
    """
    if cid in names:
        return False
    return any(n == goal or n.startswith(goal + ".") for n in names)


def standing(tree, rel, began, cid, goal, prefix):
    """Whether a change to this file is still standing under the step.

    Three ways it is. It is still sitting in the tree. It is committed but not in
    the game yet, which is work in progress by any other name. Or it reached main
    under the step's own name, which is the step making the code it said it would
    not. It is clear only when every commit that carries it since the step began
    belongs to another card of the same job.
    """
    if git(["status", "--porcelain", "--", rel], tree):
        return True
    window = ["--since=@%d" % int(began), "--format=%H"]
    if git(["log"] + window + ["HEAD", "--not", "main", "--", rel], tree):
        return True
    landed = git(["log"] + window + ["main", "--", rel], tree).split()
    if not landed:
        return False
    named = [named_in(git(["log", "-1", "--format=%B", sha], tree), prefix) for sha in landed]
    if any(cid in names for names in named):
        return True
    return not any(carried(names, cid, goal) for names in named)


def wrote_code(cid, card, session, root):
    """Project files this step left behind that belong to no other card.

    A step that declared it makes no code is proved by what it LEFT, not by what
    it touched: a file edited and put back is nothing at all, and a file whose
    change landed under another card of the job is that card's.
    """
    began = stamp(card.get("started_at"))
    if began is None:
        return []
    goal = next((l[3:] for l in card.get("labels") or [] if l.startswith("of:")), cid)
    prefix = bc.prefix(root)
    state = bc.load(session or "")
    touched = {}
    for e in state.get("edits") or []:
        if (e.get("t") or 0) >= began:
            tree, rel = in_repo(e.get("p") or "", root)
            if rel:
                touched.setdefault((tree, rel), e.get("p"))

    left = []
    for (tree, rel), path in sorted(touched.items()):
        sub = next((s for s in submodules(tree) if rel.startswith(s + "/")), "")
        if sub:
            # Its own repository answers for the file; the tree around it only
            # ever sees the pointer, and moving that pointer is its own landing.
            if git(["status", "--porcelain", "--", rel[len(sub) + 1:]],
                   os.path.join(tree, sub)):
                left.append(path)
                continue
            rel = sub
        if standing(tree, rel, began, cid, goal, prefix):
            left.append(path)
    return left


def copies(root):
    """Every separate checkout registered here except the main one, keyed by path.

    Read from git rather than from the folder, so a directory somebody left
    behind by hand is not mistaken for a live copy and vice versa. Keyed by the
    whole path, not the folder name: an agent-made copy lands under
    `.claude/worktrees/<name>`, so two copies share a name often enough, and a
    name-keyed answer hands out an `rm -rf` for the wrong one (cor-futg.17).
    """
    main = root.split("/worktrees/")[0].rstrip("/")
    found = {}
    for block in git(["worktree", "list", "--porcelain"], main).split("\n\n"):
        path = branch = ""
        for line in block.splitlines():
            if line.startswith("worktree "):
                path = line[len("worktree "):]
            elif line.startswith("branch "):
                # Only the ref namespace comes off. Splitting on the last slash
                # would turn `fix/copy-lifetime` into `copy-lifetime`, and the
                # removal this prints would end on a branch that does not exist.
                branch = re.sub(r"^refs/heads/", "", line[len("branch "):])
        if path and path.rstrip("/") != main:
            found[path.rstrip("/")] = branch
    return found


# A board query that came back empty and one that failed are the same value and
# must never be the same answer: every rule below reads "no copies" as "let it
# through", so a bad flag or a timeout would quietly switch the rule off
# (cor-futg.15). `--status all` is not optional either — without it a closed step
# is invisible, and by the teardown every step claimed inside the copy is closed,
# which is exactly when the question is asked (cor-futg.13).
UNREADABLE = object()


def rows_of(args, root):
    """The cards a query names, or UNREADABLE if the board could not answer."""
    ok, out = bc.bd(args, root)
    if not ok:
        return UNREADABLE
    try:
        return json.loads(out or "[]")
    except Exception:
        return UNREADABLE


def waits_only_on_its_own_reading(cid, root):
    """Whether all this card waits on is a reading holding a job it belongs to.

    A reading that turned a job down is waiting for exactly the answers it asked
    for, and those answers are the job's own pieces — so a piece it holds shut
    could otherwise never be started (docs/board.md#4b). Only that one shape is
    excused: a piece waiting on an ordinary card is still waiting.
    """
    seen, frontier, reading_found = set(), [cid], False
    while frontier:
        here = frontier.pop()
        if here in seen:
            return False  # a cycle is not a reading
        seen.add(here)
        deps = rows_of(["dep", "list", here, "--json"], root)
        if deps is UNREADABLE:
            return False
        for dep in deps or []:
            if dep.get("status") == "closed":
                continue
            if dep.get("issue_type") == "gate":
                # On this very card the reading is waiting for a reader, not for
                # this card to be picked up; only an ancestor's is excused.
                if here == cid or dep.get("title") != run.GATE_TITLE:
                    return False
                reading_found = True
            elif dep.get("dependency_type") == "parent-child" \
                    and cid.startswith(dep.get("id", "\0") + "."):
                frontier.append(dep["id"])
            else:
                return False
    return reading_found


def places(rows):
    """The copy each card was claimed in: a board name opens with its tree."""
    return {(r.get("assignee") or "").rsplit("-", 1)[0] for r in rows} - {"", "main"}


def owned_copies(cid, card, root):
    """The copies this job worked in that are still on disk, keyed by path.

    Asked of the board, not of a note: every step a session claimed carries the
    name it claimed under, and that name opens with the copy it was standing in
    (board_common.actor). A job that never left the main tree owns none.
    """
    goal = next((l[3:] for l in card.get("labels") or [] if l.startswith("of:")), cid)
    rows = rows_of(["list", "--json", "--limit", "0", "--status", "all",
                    "--label", "of:" + goal], root)
    if rows is UNREADABLE:
        return UNREADABLE
    named = places(rows)
    return {path: branch for path, branch in sorted(copies(root).items())
            if os.path.basename(path) in named}


# The command git accepts. `git worktree remove` is refused outright for any copy
# holding a populated submodule — "working trees containing submodules cannot be
# moved or removed" — and every copy of this project carries vendor/iced, so the
# obvious instruction is one almost nobody here can follow (cor-futg).
REMOVE = ("rm -rf %(path)s && git -C %(main)s worktree prune"
          "%(branch)s")


def removal(path, branch, root):
    main = root.split("/worktrees/")[0].rstrip("/")
    return REMOVE % {"path": path, "main": main,
                     "branch": (" && git -C %s branch -d %s" % (main, branch)) if branch else ""}


LOOKABLE = re.compile(r"https?://|\b[\w./~-]+\.(?:png|jpg|jpeg|webp|gif|mp4|html)\b", re.I)


def looked_at(goal):
    """Whether a job the manager signs off carries the thing he is to look at.

    His column is only worth having if every card in it can be acted on, and he
    judges by looking: a render, or the page a result was handed over on.
    """
    if ((goal.get("metadata") or {}).get("judge")) != "manager":
        return True
    return bool(LOOKABLE.search(goal.get("notes") or ""))


def page_stale(cid, card, session, root):
    """Whether this card's page is older than the work being ticked off.

    The bar is when the card was claimed, or the last project file this session
    changed while holding it, whichever is later: a page built before that cannot
    be carrying what is closing. A card nobody ever claimed still needs a page —
    there is no moment to measure, but there is still something to report.
    """
    began = stamp(card.get("started_at")) or 0.0
    bar = began
    for e in bc.load(session or "").get("edits") or []:
        t = e.get("t") or 0
        if t >= began and bc.project_edit(e.get("p"), root):
            bar = max(bar, t)
    built = bc.page_built(bc.page_names(cid, card))
    return not built or built < bar


def slot_holder(root):
    """Who holds the board's single merge slot, if anyone."""
    slot = show(bc.prefix(root) + "-merge-slot", root) or {}
    return (slot.get("metadata") or {}).get("holder") if slot.get("status") != "open" else None


def unfinished_spine(card, root, me=None):
    """Steps this job's own order names that have not closed. A goal poured
    before the order was recorded has none, and is left alone.

    The reading is the exception: it has no card, so nothing closes to record it
    and the goal's own signature is what says it ran. `me` is the session asking,
    which the board does not yet hold against the job — the test this replaces
    compared the signature against a set the closing session is never in, so no
    signature could fail it (cor-dqth).
    """
    meta = card.get("metadata") or {}
    order = spine.stored(meta.get("spine"))
    if not order:
        return []
    ok, out = bc.bd(["list", "--parent", card.get("id"), "--status", "all", "--json"],
                    root)
    try:
        # bd says `null` for an empty result, which json turns into nothing at all
        # rather than into no cards.
        rows = (json.loads(out or "[]") if ok else []) or []
    except Exception:
        return []
    # Every card of a step, not the first of them to close: the work step holds
    # many at once, and a reader's objections arrive under a step whose earlier
    # cards are all closed (cor-bqca.5).
    at_step = {}
    for r in rows:
        for l in r.get("labels") or []:
            if l.startswith("step:"):
                at_step.setdefault(spine.now(l[5:]), []).append(r)
    done = {s for s, cards in at_step.items()
            if all(c.get("status") == "closed" for c in cards)}
    if "review" in order and "review" not in done and reading.read_by(
            card, card.get("id"), root, also=[me] if me else ()):
        done.add("review")
    return [s for s in order if s not in done]


def spent_copies(session, root):
    """Copies this session owns whose job has nothing left to build in them.

    The teardown refusal only ever fires for a job that reaches its last step,
    and most never do — so the same rule stands in front of the NEXT job instead:
    a session carries at most one live copy, and the one it abandoned is the one
    it is asked about (cor-futg).
    """
    sid = (session or "nosession")[:8]
    out = {}
    for path, branch in sorted(copies(root).items()):
        name = os.path.basename(path)
        cards = rows_of(["list", "--json", "--limit", "0", "--status", "all",
                         "--assignee", "%s-%s" % (name, sid)], root)
        if cards is UNREADABLE:
            return UNREADABLE
        goals = {l[3:] for c in cards for l in c.get("labels") or []
                 if l.startswith("of:")}
        for goal in goals:
            if spent(goal, root):
                out[path] = (branch, goal)
                break
    return out


def spent(goal, root):
    """Whether this job has nothing left to build in its copy.

    An order nobody recorded, and a board that did not answer, both come back
    from `unfinished_spine` as the empty list — and an empty list otherwise
    means every step is closed. Read that as spent and a job whose order was
    never stored has its owner refused the next job for no reason, while the
    land gate reads the same empty value as permissive (cor-futg.14). So the
    question is asked of the order itself: no order, nothing to conclude.
    """
    card = show(goal, root) or {}
    if not spine.stored((card.get("metadata") or {}).get("spine")):
        return False
    return "work" not in unfinished_spine(card, root)


def open_gates(cid, root):
    """Every gate still holding this card shut.

    Asked here rather than left to the board's own refusal, because the two ways
    on are not the same thing and the board cannot tell them apart: a job that is
    being LANDED owes a reading, and a job that is being CALLED OFF owes none. A
    refusal that only says "blocked" sends an agent looking for a reader it does
    not need (cor-0fhq).
    """
    rows = rows_of(["gate", "list", cid, "--json"], root)
    if rows is UNREADABLE:
        return []
    return [r["id"] for r in rows if r.get("id") and r.get("status") != "closed"]


def open_children(cid, root):
    ok, out = bc.bd(["list", "--parent", cid, "--brief", "--json"], root)
    if not ok:
        return False
    try:
        rows = json.loads(out or "[]")
    except Exception:
        return False
    return any(r.get("id") != cid and r.get("status") != "closed" for r in rows)


def main():
    data = json.load(sys.stdin)
    # What a shell was handed comes back onto the line as commands first. Every
    # rule below reads quoted words as a card's own text, which is what keeps a
    # note quoting a close from being read as one — and is exactly what would hide
    # `sh -c "git commit -m x"` from all of them (board_common.unshelled).
    # The line as typed, and the line as the shell would run it. The rules below
    # read the second — but a card id is read from the FIRST, because a message
    # written in a here-document is data to the reader and still names its card.
    raw = bc.said(data)
    cmd = bc.unshelled(raw)
    root = bc.board_root(bc.where(data))
    if not os.path.isdir(os.path.join(root, ".beads")) or bc.reviewing() \
            or bc.waived(data.get("session_id")):
        return
    sections.use(root)
    # Every card the board of THIS checkout answers for. A commit is judged by the
    # project it is being made in, so one made here while the session's home is
    # another project is still a commit here (cor-up1g) — and a job whose own
    # declaration says its change lands here may name its own board's ids, because
    # a change split across two repositories is one job.
    card_id = re.compile(r"\b(?:%s)-[0-9a-z.-]{2,16}\b"
                         % "|".join(re.escape(p) for p in bc.prefixes(root)))
    ids = card_id.findall(raw)
    if not ids:
        # A message written in a file names its card there.
        ids = card_id.findall(written_in(message_files(cmd, bc.where(data))))
    # A quoted value is a card's own words, and a card's words are about commands
    # as often as not: a note that quotes one, in brackets, reads exactly like the
    # command it describes. Every refusal below fires at what is left once the
    # quotes are gone. A commit message is the exception: naming the card there is
    # how a commit declares what it lands, so `ids` stays whole.
    bare = re.sub(r"(['\"]).*?\1", " ", cmd, flags=re.S)
    acted_on = card_id.findall(bare)

    if CREATE.search(bare):
        deny(
            "Cards are not written by hand — that is how the board filled up with work "
            "nobody could confirm. A job: %(pour)s new --what … --evidence … "
            "--done … --area … --kind …, which pours the goal and its steps together. "
            "A fault this job's own change would touch: %(pour)s under <goal> "
            "--do \"<what to do>|<how we know it is done>\". "
            "Something you noticed and are not doing now: %(pour)s find "
            "\"<what>\" \"<where it is, how it shows>\" --area … --kind …."
            % {"pour": bc.tool(root, "job")}
        )
        return

    if commits(cmd) and not AMEND.search(bare) and not ids:
        deny(
            "A commit has to name the card it belongs to, because that is what lets "
            "the board tell a written change from a landed one. This commit is being "
            "made in %s, whose board issues %s — put one of those ids in the message. "
            "A card from another project's board does not land a change here."
            % (root, " or ".join(p + "-…" for p in bc.prefixes(root)))
        )
        return

    if RESOLVE.search(bare):
        deny(
            "A gate is not opened from the session it is holding — that is the whole "
            "of its value. The board's own reader opens the one on a job when it has "
            "read the change; if it died, fire another: "
            "`%s <the goal> --rerun`." % bc.tool(root, "review")
        )
        return

    if RESTATUS.search(bare) and not CLOSE.search(bare):
        reading = REVIEWING.search(bare)
        for cid in acted_on:
            card = show(cid, root) or {}
            if card.get("status") == bc.MANAGER_REVIEW:
                deny(
                    "%s is waiting on the manager, and no session moves a card out of "
                    "his column — not forward, not back. He signs it on his own "
                    "screen." % cid
                )
                return
            if reading and "job" not in (card.get("labels") or []):
                deny(
                    "%s is a piece of work, and a piece is never read on its own: it is "
                    "open, being worked, or closed. Its job goes to Agent Review once "
                    "every piece under it has closed, and the board puts it there "
                    "itself. Leave this one where it is." % cid
                )
                return

    if CLOSE.search(bare):
        if FORCE.search(bare):
            deny(
                "Forcing a close walks past the two things the board guarantees: that "
                "a goal's children are all finished, and that nothing still blocks it. "
                "Close the children first, or drop the blocker."
            )
            return
        for cid in acted_on:
            card = show(cid, root)
            if card is None:
                continue
            if card.get("issue_type") == "gate":
                deny(
                    "%s is a gate, and closing it is how a gate is opened. The session "
                    "being held by one never opens it: the board's own reader does, "
                    "once it has read the change." % cid
                )
                return
            if card.get("status") == bc.MANAGER_REVIEW:
                deny(
                    "%s is waiting on the manager, and no session moves a card out of "
                    "his column — not to done, not back to the start. He signs it on "
                    "his own screen. If something is wrong with it, say so and leave "
                    "it where it is." % cid
                )
                return
            shut = open_gates(cid, root)
            if shut:
                deny(
                    "%s is held shut by %s, and this close says the work landed. A "
                    "gate is a reading somebody is owed: it opens when a reader that "
                    "did not write the job has read it, and there is no other way to "
                    "land.\n\nIf this job is not being delivered at all, that is a "
                    "different thing and has its own route — it resolves the gate in "
                    "writing and marks the job as never delivered, so the manager's "
                    "board never counts it as something he got:\n  %s cancel %s "
                    "--reason=\"<why this is being dropped>\"\n\nIf it is being "
                    "delivered, let the reader finish; if the reader died, "
                    "`%s %s --rerun` sends another."
                    % (cid, " and ".join(shut), bc.tool(root, "job"), cid,
                       bc.tool(root, "review"), cid)
                )
                tally("landing-gated")
                return
            me = bc.actor(data.get("session_id"), bc.where(data))
            left = unfinished_spine(card, root, me) \
                if "job" in (card.get("labels") or []) else []
            if left:
                deny(
                    "%s is a goal whose own order still has %s to run. A job that "
                    "closes early is how most of this board's work reached done without "
                    "ever being read: close the steps, and the next one opens itself.%s"
                    % (cid, " and ".join(left),
                       UNREAD % ("%s %s" % (bc.tool(root, "review"), cid))
                       if "review" in left else "")
                )
                return
            step = next((l for l in card.get("labels") or [] if l.startswith("step:")), None)
            notes = (card.get("notes") or "").strip()
            if step and len(notes) < 30:
                deny(
                    "%s is the %s step and has not said what it did here. Every step of "
                    "every job says the same thing otherwise, which is what made the last "
                    "board unreadable: `bd update %s --append-notes=\"<what you actually "
                    "ran, decided or found>\"`." % (cid, step[5:], cid)
                )
                return
            if step:
                which = step[5:]
                shaped, wanted = spine.note_ok(which, notes)
                if not shaped:
                    deny(
                        "%s is the %s step and its note does not carry %s. Thirty "
                        "characters of anything is not proof that the step ran: write "
                        "what would let someone else believe it." % (cid, which, wanted)
                    )
                    return
                if spine.evidence(which) == spine.NOTE:
                    wrote = wrote_code(cid, card, data.get("session_id"), root)
                    if wrote:
                        deny(
                            "%s is the %s step, which makes no code — and %d project "
                            "file(s) it changed are still standing under it, starting "
                            "with %s. Put that work on a work item of its own, land it "
                            "under that card, and this step is clear."
                            % (cid, which, len(wrote), wrote[0])
                        )
                        return
                if which == "worktree" and "/worktrees/" not in bc.where(data):
                    deny(
                        "%s is the worktree step and this session is not standing in "
                        "one. Cut it under worktrees/ and work there: two jobs editing "
                        "one tree is what the step exists to stop." % cid
                    )
                    return
                if which == "land":
                    goal = next((l[3:] for l in card.get("labels") or []
                                 if l.startswith("of:")), None)
                    left = [s for s in unfinished_spine(show(goal, root) or {}, root, me)
                            if s != "land"] if goal else []
                    if left:
                        deny(
                            "%s cannot land while %s of its own order is still open. "
                            "Landing is the teardown, not the merge: every code step "
                            "merged as it closed." % (cid, " and ".join(left))
                        )
                        return
                    if "/worktrees/" in bc.where(data):
                        deny(
                            "%s is the teardown and cannot be closed from inside the "
                            "tree it removes. Step out to the main tree, take the "
                            "branch and the worktree away, then close it." % cid
                        )
                        return
                    if bc.held_by(slot_holder(root), data.get("session_id")):
                        deny(
                            "%s still holds the merge slot. Release it — `bd merge-slot "
                            "release` — so the next job can land." % cid
                        )
                        return
                    mine = owned_copies(cid, card, root)
                    if mine is UNREADABLE:
                        deny(
                            "%s is the teardown and the board could not say which "
                            "copies this job worked in, so whether they are gone is "
                            "unknown. A check that cannot run is not a check that "
                            "passed. Try again; if the board is down, that is the "
                            "thing to fix first." % cid
                        )
                        return
                    for path, branch in mine.items():
                        loose = git(["status", "--porcelain"], path)
                        if loose:
                            deny(
                                "%s is the teardown and %s still holds work nobody "
                                "committed:\n%s\nDeal with those first — commit them "
                                "under a card, or put them on a branch of their own. "
                                "Nothing here will delete them for you."
                                % (cid, path, loose[:600])
                            )
                            return
                        deny(
                            "%s cannot close while %s is still on the disk: this step "
                            "means the copy is gone, and saying so is not the same as "
                            "doing it. `git worktree remove` will refuse — git rejects "
                            "any copy carrying a submodule, and every copy here carries "
                            "vendor/iced. This is the route that works:\n  %s"
                            % (cid, path, removal(path, branch, root))
                        )
                        return
                    if goal and not looked_at(show(goal, root) or {}):
                        deny(
                            "%s belongs to a job the manager signs off, and its goal "
                            "carries nothing for him to look at. Put the page or the "
                            "picture on the goal — `bd update %s --append-notes=\"…\"` "
                            "— before it reaches his column; a card he cannot act on "
                            "is worse there than not there." % (cid, goal)
                        )
                        return
            if not set(card.get("labels") or []) & set(UNREPORTED) \
                    and page_stale(cid, card, data.get("session_id"), root):
                deny(
                    "%s cannot be ticked off while its page is behind the work. The "
                    "manager hears about finished work through the page, so writing it "
                    "is part of finishing rather than a debt owed afterwards: "
                    "`report list` finds the one for this job, `report <slug>` brings it "
                    "up to date, and the link it prints is what goes to him — last in "
                    "the message, so he does not scroll for it. Then close." % cid
                )
                return
            if set(card.get("labels") or []) & set(NO_CODE):
                continue
            if card.get("issue_type") in ("decision", "epic"):
                continue
            names = landing_names(cid, card, root)
            proved = [where for where, branch in bc.landings(root, cid)
                      if any(git(["log", branch, "--grep", name, "--max-count", "1",
                                  "--format=%H"], where) for name in names)]
            if not proved:
                away = bc.unreachable(cid, root)
                if away:
                    deny(
                        "%s belongs to a job that says its change lands in %s, and that "
                        "checkout is not on this machine — so nothing here can tell "
                        "whether it landed. Bring the checkout back, or take the "
                        "%s%s label off the goal if the work no longer lands there."
                        % (cid, " and ".join(away), bc.LANDS, away[0])
                    )
                    return
                deny(
                    "%s cannot close: no commit naming it has reached the main line. "
                    "A card is done when its change is merged, not when the work feels "
                    "finished. Land it first, or — if this card was never going to "
                    "produce code — label it no-code and say why in the reason."
                    % cid
                )
                return
            standing = [] if root in proved \
                else wrote_code(cid, card, data.get("session_id"), root)
            if standing:
                deny(
                    "%s is proved only by a commit in %s, and %d file(s) it changed in "
                    "this repository are still standing, starting with %s. A change "
                    "split across two repositories lands in both or in neither."
                    % (cid, ", ".join(proved), len(standing), standing[0])
                )
                return

    if CLAIM.search(bare) and acted_on:
        ok, out = bc.bd(["blocked", "--json"], root)
        try:
            stuck = {r["id"] for r in json.loads(out or "[]")} if ok else set()
        except Exception:
            stuck = set()
        for cid in acted_on:
            if cid in stuck and not waits_only_on_its_own_reading(cid, root):
                deny(
                    "%s is waiting on something else and cannot be claimed until that "
                    "clears. `bd blocked` says what is in the way; `bd ready` only ever "
                    "lists work with nothing in its way." % cid
                )
                return
            card = show(cid, root) or {}
            if card.get("issue_type") == "epic" or open_children(cid, root):
                deny(
                    "%s has work broken out underneath it, so it is a container rather "
                    "than a job: it finishes when its children do, not when someone "
                    "decides it has. Claim one of them — `bd list --parent %s`."
                    % (cid, cid)
                )
                return
            if "find" in (card.get("labels") or []):
                deny(
                    "%s is something noticed, not yet a job: it has no proof, no "
                    "definition of done and no steps. Promote it — %s "
                    "new --source %s --what … --evidence … --done … --area … — or "
                    "close it as not real." % (cid, bc.tool(root, "job"), cid)
                )
                return
            if "step:worktree" in (card.get("labels") or []):
                spent_ones = spent_copies(data.get("session_id"), root)
                if spent_ones is UNREADABLE:
                    deny(
                        "%s starts a job in a new copy of the work, and the board "
                        "could not say whether this session already owns a finished "
                        "one. A check that cannot run is not a check that passed: try "
                        "again, or fix the board first." % cid
                    )
                    return
                for path, (branch, goal) in spent_ones.items():
                    deny(
                        "%s starts a job in a new copy of the work, and this session "
                        "still owns %s, whose job (%s) has nothing left to build in "
                        "it. Copies are the largest thing this project leaves behind: "
                        "they were 59 GB before anyone counted. Finish that one, then "
                        "start this. If it holds work worth keeping, put it on a "
                        "branch of its own first; otherwise:\n  %s"
                        % (cid, path, goal, removal(path, branch, root))
                    )
                    return


if __name__ == "__main__":
    main()
