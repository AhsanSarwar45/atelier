#!/usr/bin/env python3
"""Where a session's gates may be written down, and how they may be spelled.

Two faults, both of which cost real money before this existed:

  a gate spelled as a folder
      A rule written as `/home/somebody/dev/thing/machinery/hooks/x.py` runs
      that one checkout's gates in every unrelated project on that computer, and
      runs nowhere at all on anyone else's. The two spellings that travel are
      `$CLAUDE_PROJECT_DIR/...`, which each project resolves to itself, and the
      program's own name, which every computer that installed it has.

  a gate written down twice
      A rule registered in both the personal settings and a project's own fires
      twice on every turn, and everything it hands over — the opening briefing
      among it — arrives doubled. Ten sessions paid about fourteen dollars for
      the same fifteen rules running twice.

Run with no arguments to judge this computer. `--selftest` runs the cases
instead, and needs nothing on the disk.
"""

from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

# The two spellings that survive being moved to another computer.
TRAVELS = ("$CLAUDE_PROJECT_DIR", "${CLAUDE_PROJECT_DIR}")


def commands(settings: dict):
    """Every gate a settings file registers: event, what it matches, command."""
    for event, groups in (settings.get("hooks") or {}).items():
        for group in groups or []:
            for hook in group.get("hooks") or []:
                command = hook.get("command")
                if command:
                    yield event, group.get("matcher", "*"), command


def in_a_checkout(word: str) -> str | None:
    """The checkout a path leads into, if it leads into one.

    Asked of the disk rather than of a list of folder names, so it holds on any
    computer and says nothing about whose it is.
    """
    if not word.startswith(("/", "~")):
        return None
    here = Path(os.path.expanduser(word))
    for step in [here] + list(here.parents):
        if (step / ".git").exists():
            return str(step)
    return None


def folder_spelled(command: str) -> list[tuple[str, str]]:
    """Every part of one command that names a path inside a checkout."""
    if any(word in command for word in TRAVELS):
        return []
    found = []
    try:
        words = shlex.split(command)
    except ValueError:
        words = command.split()
    for word in words:
        where = in_a_checkout(word)
        if where:
            found.append((word, where))
    return found


def named(command: str) -> str:
    """What a gate is, with the way it was spelled taken off.

    Two settings files naming the same gate through different folders are the
    same gate registered twice, and comparing the commands as written would miss
    it. What is left is the last word of the path, which is the gate's name.
    """
    try:
        words = shlex.split(command)
    except ValueError:
        words = command.split()
    for word in reversed(words):
        if word.startswith("-"):
            continue
        return os.path.basename(word)
    return command


def read(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text())
    except ValueError:
        return None


def judge(personal: dict | None, projects: dict[str, dict]) -> list[str]:
    """Every refusal, in the words the reader needs to fix it."""
    said: list[str] = []

    for whose, settings in [("the personal settings", personal)] + sorted(projects.items()):
        if not settings:
            continue
        for event, matcher, command in commands(settings):
            for word, checkout in folder_spelled(command):
                said.append(
                    f"{whose}: the {event} gate on {matcher} is spelled as a folder — {word}\n"
                    f"    that is inside {checkout}, so it runs that one checkout's gates "
                    f"everywhere on this computer and nowhere on anyone else's.\n"
                    f"    Write it as $CLAUDE_PROJECT_DIR/... in that project's own settings, "
                    f"or as the program's name."
                )

    if personal:
        mine = {(event, named(command)): matcher
                for event, matcher, command in commands(personal)}
        for whose, settings in sorted(projects.items()):
            for event, matcher, command in commands(settings or {}):
                key = (event, named(command))
                if key in mine:
                    said.append(
                        f"the personal settings and {whose} both register the {event} gate "
                        f"{key[1]}\n"
                        f"    so it runs twice on every turn, and everything it hands over "
                        f"arrives doubled.\n"
                        f"    A project carries its own copy; take this one out of the "
                        f"personal settings."
                    )
    return said


def every_project() -> dict[str, dict]:
    """Each registered project's own settings, by the name it registered under."""
    out: dict[str, dict] = {}
    try:
        import project  # noqa: PLC0415  — beside this file, and only wanted here
        for name, root in project.registry().items():
            found = read(Path(root) / ".claude" / "settings.json")
            if found:
                out[f"{name}'s own settings"] = found
    except Exception:
        pass
    return out


def on_this_computer(everywhere: bool = False) -> list[str]:
    """What this computer's settings are refused for.

    Held to what this checkout owns unless asked otherwise: its own settings,
    and the personal ones, which belong to no project and are the file that
    leaks one project's gates into every other. Another project's own settings
    are its own board's business, and a fault found in one is filed there —
    `--everywhere` is how it is found.
    """
    personal = read(Path.home() / ".claude" / "settings.json")
    projects = every_project()
    if not everywhere:
        here = read(HERE.parent / ".claude" / "settings.json")
        mine = {name: found for name, found in projects.items()
                if here is not None and found == here}
        if here is not None and not mine:
            mine = {"this project's own settings": here}
        # Doubling is a fault of the personal file against ANY project, so every
        # project still counts for that half; only the spelling half narrows.
        said = judge(personal, mine)
        doubled = [line for line in judge(personal, projects) if "both register" in line]
        return said + [line for line in doubled if line not in said]
    return judge(personal, projects)


def selftest() -> int:
    failed = []

    def gate(command, event="Stop", matcher="*"):
        return {"hooks": {event: [{"matcher": matcher, "hooks": [{"command": command}]}]}}

    checkout = str(HERE.parent)  # this file's own repository, which has a .git

    # A gate spelled as a folder inside a checkout is refused.
    said = judge(gate(f"{checkout}/machinery/hooks/board-gate.py"), {})
    if len(said) != 1 or "spelled as a folder" not in said[0]:
        failed.append(f"a folder-spelled gate was not refused: {said}")

    # The spelling that travels is not.
    if judge(gate("$CLAUDE_PROJECT_DIR/machinery/hooks/board-gate.py"), {}):
        failed.append("$CLAUDE_PROJECT_DIR was refused")
    if judge(gate("atelier hook board-gate.py"), {}):
        failed.append("the program's own name was refused")

    # A personal tool that is not in any checkout is left alone.
    if judge(gate(f"bash {Path.home()}/.claude/hooks/notify.sh"), {}):
        failed.append("a personal tool outside every checkout was refused")

    # The same gate in both files is refused, through different spellings.
    said = judge(gate("atelier hook board-gate.py"),
                 {"a project": gate("$CLAUDE_PROJECT_DIR/machinery/hooks/board-gate.py")})
    if len(said) != 1 or "both register" not in said[0]:
        failed.append(f"a gate registered twice was not refused: {said}")

    # Different gates in the two files are not.
    if judge(gate("atelier hook completion-gate.py"),
             {"a project": gate("$CLAUDE_PROJECT_DIR/machinery/hooks/board-gate.py")}):
        failed.append("two different gates were refused")

    # The same gate on different events is two gates, not one written twice.
    if judge(gate("atelier hook board-touch.py", event="Stop"),
             {"a project": gate("$CLAUDE_PROJECT_DIR/machinery/hooks/board-touch.py",
                                event="SubagentStop")}):
        failed.append("one gate on two events was read as a doubled gate")

    if failed:
        for line in failed:
            print("FAILED  " + line)
        return 1
    print("all 7 cases pass")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    said = on_this_computer("--everywhere" in sys.argv)
    if not said:
        print("every gate is spelled so it travels, and none is written down twice")
        return 0
    for line in said:
        print(line)
        print()
    print(f"{len(said)} refused")
    return 1


if __name__ == "__main__":
    sys.exit(main())
