#!/usr/bin/env python3
"""PreToolUse hook (Edit|Write|MultiEdit) — keeps plan docs being plans.

A plan doc states intent; git owns history. Denies edits that turn a plan
document (any docs/ path containing "plan") into a changelog: done-markers,
dated progress bullets, session/update headings.
"""
import json
import re
import sys

CHANGELOG = [
    (re.compile(r"^\s*#+\s*(changelog|progress|status|update|session \d)", re.I), "changelog-style heading"),
    (re.compile(r"^\s*[-*]\s*20\d\d-\d\d-\d\d\b"), "date-stamped progress bullet"),
    (re.compile(r"✅|✔|\[x\]", re.I), "done-marker"),
    (re.compile(r"\b(DONE|COMPLETED|SHIPPED|IMPLEMENTED)\b\s*[:.—-]"), "done-record"),
]


def applies(path: str) -> bool:
    return path.endswith(".md") and "plan" in path.lower()


def main() -> None:
    data = json.load(sys.stdin)
    ti = data.get("tool_input", {})
    if not applies(str(ti.get("file_path", ""))):
        return
    added = [ti.get("new_string") or ti.get("content") or ""]
    added += [e.get("new_string", "") for e in ti.get("edits", [])]
    problems = []
    for text in added:
        for i, line in enumerate(text.splitlines(), 1):
            for rx, label in CHANGELOG:
                if rx.search(line):
                    problems.append(f"{label} (added line {i})")
                    break
    if problems:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    "plan docs are plans, git owns history: " + "; ".join(problems)
                    + ". Session state goes on the card, not into a doc."
                ),
            }
        }))


if __name__ == "__main__":
    main()
