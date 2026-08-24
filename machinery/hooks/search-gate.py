#!/usr/bin/env python3
"""PreToolUse — a search over a tree is run by the tool that reads the ignore list.

`grep -r` reads every file in the tree byte by byte. It has no idea which of
those folders are build output, and no search result has ever come out of one.

Measured on this computer, in a built copy of a project (91,146 files, 11 GB of
build output inside it): one string cost 23.94 s with `grep -rn` and 0.011 s
with `rg -n`. In a larger project with no build output checked in: 9.20 s
against 0.009 s. Two thousand times, in both, and the whole of it is that `rg`
reads the `.gitignore` the project already wrote.

It is registered in the personal settings rather than any one project's, so it
stands in front of every project on this computer and its words name none of
them (bw-2x54.2).

A session reaches for `grep` because it is told to. In bypassPermissions mode
Claude Code puts a line in front of every turn that says to work through Bash
— "search with grep and find" — which overrides the built-in instruction never
to run `grep` as a Bash command. That line cannot be edited, so the habit is
answered here instead.

Only a recursive walk is refused. `grep` reading a pipe, a named file, or
`git grep` is untouched: none of them walks a tree.

Fails open. A command that cannot be parsed is allowed through.
"""
import json
import re
import sys

# The grep family, however it is spelled and wherever it is installed.
GREP = re.compile(r"^(?:/\S*/)?(e|f|r)?grep$")

# The token proxy, which stands in front of every Bash call on this computer
# and renames a bare `grep` to `rtk grep` before anything else sees it. Its
# own walk of a built copy of this project cost 7.93 s against ripgrep's
# 0.011 s, so the renamed form is refused exactly like the plain one.
PROXY = re.compile(r"^(?:/\S*/)?rtk$")

# A flag that turns grep into a tree walk. Long forms, and short ones that may
# arrive bundled with anything else (`-rn`, `-Rin`, `-rIl`).
LONG = {"--recursive", "--dereference-recursive"}

# Everything that ends one command and starts another. A heredoc body is cut
# out before this runs, so a `grep -r` written inside one is not a command.
BREAK = re.compile(r"\|\||&&|[|;&\n]")

# `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` and the body that follows it.
HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1.*?^\s*\2\s*$",
                     re.DOTALL | re.MULTILINE)

# A leading `VAR=value` or two, which a command may carry before its own name.
ASSIGN = re.compile(r"^[A-Za-z_]\w*=")

# This doorman stands in front of every project on the computer, so its words
# name no one project's folders and quote no one project's measurement
# (bw-2x54.5).
REASON = (
    "`{name}` walks the tree file by file and reads every byte of it, the "
    "build output included. Measured on this computer: 23.94 s for one "
    "string in a project carrying its build folders, 9.20 s in one that does "
    "not, against 0.011 s and 0.009 s for the same strings with `rg` — which "
    "reads the .gitignore the project already wrote and skips everything "
    "named in it for free.\n\n"
    "Run it as:\n"
    "    {fixed}\n\n"
    "Patterns are ripgrep's regex. That is what `grep -E` speaks too. `grep` "
    "down a pipe or over a named file is untouched — only a walk of a tree "
    "is refused."
)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))


def words(segment):
    """The tokens of one command, with any leading VAR=value dropped."""
    try:
        out = segment.split()
    except AttributeError:
        return []
    while out and ASSIGN.match(out[0]):
        out.pop(0)
    return out


def unproxied(tokens):
    """The same command with the token proxy's name taken off the front.

    `rtk grep -r x .` and `rtk proxy grep -r x .` are the proxy's two ways of
    saying `grep -r x .`, and both walk the tree.
    """
    if tokens and PROXY.match(tokens[0]):
        rest = tokens[1:]
        if rest and rest[0] == "proxy":
            rest = rest[1:]
        return rest
    return tokens


def recursive(flags):
    """Whether these argument tokens turn grep into a tree walk."""
    for tok in flags:
        if tok in LONG:
            return True
        if tok == "--":
            return False
        if tok.startswith("--"):
            continue
        if tok.startswith("-") and len(tok) > 1 and set("rR") & set(tok[1:]):
            return True
    return False


def rewritten(tokens):
    """The same command with ripgrep in it, as a line anyone can paste."""
    out = ["rg"]
    for tok in tokens[1:]:
        if tok in LONG:
            continue
        if tok.startswith("--") or not tok.startswith("-") or tok == "-":
            out.append(tok)
            continue
        kept = "".join(c for c in tok[1:] if c not in "rR")
        if kept:
            out.append("-" + kept)
    return " ".join(out)


def judge(tool, tool_input):
    """The refusal this call earns, or None."""
    if tool != "Bash":
        return None
    command = (tool_input or {}).get("command") or ""
    for segment in BREAK.split(HEREDOC.sub("", command)):
        tokens = words(segment.strip().lstrip("("))
        tokens = unproxied(tokens)
        if not tokens:
            continue
        name = GREP.match(tokens[0])
        if not name:
            continue
        if name.group(1) == "r" or recursive(tokens[1:]):
            return REASON.format(name=tokens[0], fixed=rewritten(tokens))
    return None


def selftest():
    failed = []

    def check(name, command, want):
        got = judge("Bash", {"command": command})
        if bool(got) != want:
            failed.append("%s: wanted %s" % (
                name, "a refusal" if want else "no refusal"))

    def says(name, command, wanted):
        got = judge("Bash", {"command": command}) or ""
        if wanted not in got:
            failed.append("%s: wanted %r in the refusal, got %r" % (
                name, wanted, got))

    check("a recursive search", "grep -rn 'thing' .", True)
    check("the capital form", "grep -Rn 'thing' .", True)
    check("the long form", "grep --recursive 'thing' src", True)
    check("the symlink-following long form",
          "grep --dereference-recursive 'thing' .", True)
    check("the recursive spelling of the binary", "rgrep 'thing' .", True)
    check("a full path to the binary", "/usr/bin/grep -rn 'thing' .", True)
    check("flags bundled together", "grep -rIl 'thing' .", True)
    check("a search after a move", "cd src && grep -rn 'thing' .", True)
    check("a search behind a pipe", "cat x | grep -r 'thing' .", True)
    check("an environment set in front of it",
          "LC_ALL=C grep -rn 'thing' .", True)

    check("the proxy's renamed form", "rtk grep -rn 'thing' .", True)
    check("the proxy's explicit passthrough", "rtk proxy grep -r thing .", True)

    check("grep reading a pipe", "cat x.ts | grep thing", False)
    check("the proxy over one named file", "rtk grep -n thing src/x.ts", False)
    check("the proxy over ripgrep", "rtk rg -n thing .", False)
    check("grep over one named file", "grep -n thing src/x.ts", False)
    check("counting matches in a pipe", "ls | grep -c thing", False)
    check("git's own search", "git grep -n thing", False)
    check("ripgrep itself", "rg -n thing .", False)
    check("the word grep inside a string", "echo 'run grep -r later'", False)
    check("a recursive grep inside a heredoc",
          "cat > f.py <<'PY'\ngrep -r thing .\nPY", False)
    check("an r that belongs to another flag", "grep -e thing -f pats x.ts", False)
    check("an r after the end of the flags", "grep -- -r x.ts", False)

    says("the rewrite drops the recursive flag and keeps the rest",
         "grep -rn 'thing' .", "rg -n 'thing' .")
    says("the rewrite keeps long flags",
         "grep -r --include=*.ts thing src", "rg --include=*.ts thing src")
    says("the rewrite of the recursive binary",
         "rgrep thing .", "rg thing .")
    says("the rewrite of the proxy's renamed form",
         "rtk grep -rn 'thing' .", "rg -n 'thing' .")

    # It speaks in every project, so it names no one project's folders.
    said = judge("Bash", {"command": "grep -rn thing ."}) or ""
    for folder in ("server/target", "node_modules", ".next", "worktrees"):
        if folder in said:
            failed.append("the refusal names one project's folder: %s" % folder)

    if failed:
        for line in failed:
            print("FAILED  " + line)
        return 1
    print("all 28 cases pass")
    return 0


def main():
    if "--selftest" in sys.argv:
        return selftest()
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    reason = judge(data.get("tool_name"), data.get("tool_input"))
    if reason:
        deny(reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
