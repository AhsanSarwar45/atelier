#!/usr/bin/env python3
"""PreToolUse hook (Artifact) — a report is a file here, never a page out there.

A report the builder made is refused: it is already written to disk, and the
link the build printed is the whole delivery. Pages the builder did not make
are none of this hook's business.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

HOW = (
    "Build it with `report <slug>` and hand over the link it prints. "
    "The manager reads reports from this machine."
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
        from build import STAMP, verify
    except Exception as e:
        deny(f"the report builder will not load ({e}) — fix it before publishing")
        return

    page = p.read_text(encoding="utf-8", errors="replace")
    if verify(page) or STAMP in page:
        deny("a report is not published — it is a file on this machine. " + HOW)


if __name__ == "__main__":
    main()
