#!/usr/bin/env python3
"""PreToolUse hook (Artifact) — a report page is built, never hand-written.

Every published HTML page must carry the builder's stamp and hash exactly the
content the builder emitted. A page written by hand, or edited after building,
is refused: the slot order, the look and the plain-words gate all live in the
builder, and a hand-cut page silently escapes all three.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

HOW = (
    "Write the spec (reporting/README.md), then: "
    "report <spec>.report.json -o <page>.html — and publish the file it writes."
)


def deny(reason: str) -> None:
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }))


def main() -> None:
    data = json.load(sys.stdin)
    ti = data.get("tool_input", {})
    if ti.get("action") == "list":
        return
    path = str(ti.get("file_path", ""))
    if not path.endswith((".html", ".htm")):
        return

    p = Path(path)
    if not p.is_file():
        return

    try:
        from build import verify
    except Exception as e:
        deny(f"the report builder will not load ({e}) — fix it before publishing")
        return

    page = p.read_text(encoding="utf-8", errors="replace")
    if "@@REPORT-BUILD@@" in page:
        deny("this page still carries the unfilled build stamp — rebuild it. " + HOW)
        return
    if not verify(page):
        deny(
            "this page was not produced by the report builder, or was edited after it was built. "
            "Agents fill a report, they do not write one. " + HOW
        )


if __name__ == "__main__":
    main()
