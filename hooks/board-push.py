#!/usr/bin/env python3
"""SessionEnd — copies the board to the project's remote storage.

Detached: the copy is worth a few seconds of network, never a few seconds of
the user waiting for their shell back.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import board_common as bc  # noqa: E402


def main():
    data = json.load(sys.stdin)
    root = bc.board_root(os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd"))
    try:
        subprocess.Popen(
            ["bd", "dolt", "push"], cwd=root, start_new_session=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


if __name__ == "__main__":
    main()
