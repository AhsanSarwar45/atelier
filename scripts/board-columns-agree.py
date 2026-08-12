#!/usr/bin/env python3
"""Does the screen draw what the board says?

    board-columns-agree.py <project-path> [--url http://127.0.0.1:3008] [--shot out.png]

Asks `bd` what it holds, opens the project screen in a real browser, reads back
which card each column drew, and reports every card that is missing or in the
wrong place. Exits non-zero when they disagree, so it can stand as a gate.

A live screen never finishes loading — its updates stream forever — so a plain
headless screenshot never fires. This drives the browser over the debugging
protocol instead: navigate, settle, read the DOM.

The screen names its third column `inreview`; the board calls that status
`in_review`. Both spellings mean the same column and are compared as one.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

PORT = 9333

# What each column owes the board. `steps` says whether a card with a parent has
# to be drawn there in its own right: work under way must be visible wherever it
# sits, while a finished step belongs inside the goal it finished, not as its own
# tombstone in Closed. A status named nowhere here is one the screen deliberately
# folds into Open with a badge, and is not compared.
COLUMN_OF = {
    "in_progress": ("in_progress", True),
    "in_review": ("inreview", True),
    "closed": ("closed", False),
}


def board_says(project, status, steps):
    """The ids `bd` holds at this status, and that this column owes a card."""
    out = subprocess.run(
        ["bd", "list", "--status", status, "--json"],
        cwd=project, capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"bd list --status {status} failed:\n{out.stderr.strip()}")
    return {b["id"] for b in json.loads(out.stdout or "[]")
            if steps or not b.get("parent")}


class Browser:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
             f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
             "--window-size=1500,1000", "--user-data-dir=/tmp/board-check-profile",
             "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(40):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
                break
            except Exception:
                time.sleep(0.5)
        else:
            sys.exit("the browser never came up")
        page = [t for t in tabs if t["type"] == "page"][0]
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=60)
        self.n = 0

    def send(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                return msg.get("result", {})

    def js(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True,
                      awaitPromise=True)
        return r.get("result", {}).get("value")

    def close(self):
        self.proc.terminate()


READ_COLUMNS = """
(() => {
  const out = {};
  for (const col of document.querySelectorAll('[data-column]')) {
    out[col.dataset.column] =
      [...col.querySelectorAll('[data-bead-id]')].map(e => e.dataset.beadId);
  }
  return out;
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--url", default="http://127.0.0.1:3008")
    ap.add_argument("--shot", help="also write a screenshot here")
    args = ap.parse_args()

    projects = json.load(urllib.request.urlopen(f"{args.url}/api/projects"))
    match = [p for p in projects if p["path"] == args.project]
    if not match:
        sys.exit(f"the screen does not know a project at {args.project}")

    b = Browser()
    try:
        b.send("Page.enable")
        b.send("Runtime.enable")
        b.send("Page.navigate", url=f"{args.url}/project?id={match[0]['id']}")
        time.sleep(8)
        drawn = b.js(READ_COLUMNS)
        if args.shot:
            import base64
            shot = b.send("Page.captureScreenshot", format="png")
            open(args.shot, "wb").write(base64.b64decode(shot["data"]))
    finally:
        b.close()

    if not drawn:
        sys.exit("no column on the screen says which cards it drew — is this the fork?")

    bad = []
    for status, (column, steps) in COLUMN_OF.items():
        want = board_says(args.project, status, steps)
        if not want:
            continue
        here = set(drawn.get(column, []))
        elsewhere = {c: set(ids) for c, ids in drawn.items() if c != column}
        for card in sorted(want - here):
            where = next((c for c, ids in elsewhere.items() if card in ids), None)
            bad.append(f"{card} is {status} on the board but "
                       + (f"drawn under {where}" if where else "drawn nowhere"))
        print(f"{status:<12} board {len(want):>3}   screen {len(here):>3}")

    if bad:
        print("\nthe screen and the board disagree:")
        for line in bad:
            print("  " + line)
        return 1
    print("\nevery card the board holds is drawn in its own column")
    return 0


if __name__ == "__main__":
    sys.exit(main())
