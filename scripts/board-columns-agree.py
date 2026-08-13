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

# The column each board status answers to. A status named nowhere here is one the
# screen deliberately folds into Open with a badge, and is not compared.
COLUMN_OF = {"in_progress": "in_progress", "in_review": "inreview",
             "manager_review": "manager_review", "closed": "closed"}

# Live work pulls the card it belongs to along, the first of these that is found:
# the earliest place work is still standing, so a job with one piece being written
# and one waiting on the manager reads as being written.
LIVE = ["in_progress", "in_review", "manager_review"]

# Dropped work is a closed card carrying this mark, never a status of its own.
CANCELLED = "cancelled"


def bd_list(project, *args):
    out = subprocess.run(["bd", "list", *args, "--all", "--json"],
                         cwd=project, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"bd list {' '.join(args)} failed:\n{out.stderr.strip()}")
    return json.loads(out.stdout or "[]")


def board_says(project):
    """Which column each card of the board's own belongs in.

    The screen draws one card per job: a step is not a card of its own, so a
    goal stands in for whatever is happening below it. A goal with live work
    under it belongs in that work's column however open its own record still
    says it is; with nothing live under it, its own status decides. The card's
    own status is live work of the same kind and ranks alongside what is below.
    """
    cards = bd_list(project)
    kids = {}
    for b in cards:
        if b.get("parent"):
            kids.setdefault(b["parent"], []).append(b["id"])
    status = {b["id"]: b["status"] for b in cards}

    def live_below(card, seen=None):
        seen = seen or set()
        if card in seen:
            return None
        seen.add(card)
        below = [status[k] for k in kids.get(card, [])]
        below += [d for d in (live_below(k, seen) for k in kids.get(card, [])) if d]
        return next((s for s in LIVE if s in below), None)

    want = {}
    for b in cards:
        if b.get("parent"):
            continue
        here = [b["status"], live_below(b["id"])]
        if b["status"] == "closed" and CANCELLED in (b.get("labels") or []):
            want.setdefault(CANCELLED, set()).add(b["id"])
            continue
        column = COLUMN_OF.get(next((s for s in LIVE if s in here), b["status"]))
        if column:
            want.setdefault(column, set()).add(b["id"])
    return want


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

# A card's report is one of the card's own facts, so it is drawn inside the
# card's frame. Anything hanging below the frame reads as a separate object
# stuck to the card, which is how this last went wrong.
READ_REPORTS = """
(() => {
  const out = [];
  for (const btn of document.querySelectorAll('button')) {
    if (btn.textContent.trim() !== 'Manager report') continue;
    const frame = btn.closest('.theme-card[data-bead-id]');
    if (!frame) {
      out.push({id: '(loose)', inside: false, why: 'it hangs outside every card'});
      continue;
    }
    const f = frame.getBoundingClientRect(), r = btn.getBoundingClientRect();
    out.push({
      id: frame.dataset.beadId,
      inside: r.top >= f.top && r.bottom <= f.bottom && r.left >= f.left && r.right <= f.right,
      why: `the card spans ${f.top.toFixed(0)}-${f.bottom.toFixed(0)} and the report sits at ` +
           `${r.top.toFixed(0)}-${r.bottom.toFixed(0)}`,
    });
  }
  return out;
})()
"""


# The menu that sets a card's state has to offer every state the board draws a
# column for, or a card can be moved into a column by hand and never out of it.
# The columns on screen are the expected set, so this holds no list of its own.
OPEN_A_CARD = """
(() => {
  const card = document.querySelector('[data-bead-id]');
  if (!card) return false;
  card.click();
  return true;
})()
"""

READ_STATE_MENU = """
(() => {
  const columns = [...document.querySelectorAll('[data-column]')].map(c => c.dataset.column);
  const menus = [...document.querySelectorAll('select')].filter(
    s => [...s.options].some(o => columns.includes(o.value)));
  return {
    columns,
    offered: menus.length ? [...menus[0].options].map(o => o.value) : null,
  };
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

    before = board_says(args.project)

    b = Browser()
    try:
        b.send("Page.enable")
        b.send("Runtime.enable")
        b.send("Page.navigate", url=f"{args.url}/project?id={match[0]['id']}")
        time.sleep(8)
        drawn = b.js(READ_COLUMNS)
        reports = b.js(READ_REPORTS)
        if args.shot:
            import base64
            shot = b.send("Page.captureScreenshot", format="png")
            open(args.shot, "wb").write(base64.b64decode(shot["data"]))
        menu = {"columns": [], "offered": None}
        if b.js(OPEN_A_CARD):
            time.sleep(3)
            menu = b.js(READ_STATE_MENU) or menu
            if args.shot:
                import base64
                shot = b.send("Page.captureScreenshot", format="png")
                open(args.shot.replace(".png", "-card.png"), "wb").write(
                    base64.b64decode(shot["data"]))
    finally:
        b.close()

    if not drawn:
        sys.exit("no column on the screen says which cards it drew — is this the fork?")

    # Other sessions are working the same board, and the screen shows whatever it
    # read when it loaded. A card that moved while this was looking is not
    # evidence of anything, so only cards the board placed the same way both
    # before and after the screen was read are compared.
    after = board_says(args.project)
    steady = {c: ids & after.get(c, set()) for c, ids in before.items()}
    moved = sum(len(ids) for ids in before.values()) - sum(len(ids) for ids in steady.values())
    if moved:
        print(f"({moved} card{'s' if moved > 1 else ''} moved while this was looking, "
              f"and {'they are' if moved > 1 else 'it is'} left out)")

    bad = []
    for column in list(COLUMN_OF.values()) + [CANCELLED]:
        want = steady.get(column, set())
        here = set(drawn.get(column, []))
        elsewhere = {c: set(ids) for c, ids in drawn.items() if c != column}
        for card in sorted(want - here):
            where = next((c for c, ids in elsewhere.items() if card in ids), None)
            bad.append(f"{card} belongs under {column} but is "
                       + (f"drawn under {where}" if where else "drawn nowhere"))
        print(f"{column:<12} board {len(want):>3}   screen {len(here):>3}")

    if bad:
        print("\nthe screen and the board disagree:")
        for line in bad:
            print("  " + line)
        return 1
    print("\nevery card the board holds is drawn in its own column")

    outside = [r for r in reports if not r["inside"]]
    print(f"\nreports on cards  {len(reports):>3}   drawn outside their card  {len(outside):>3}")
    if not reports:
        print("no card on this board carries a report, so that rule checked nothing")
        return 1
    if outside:
        for r in outside:
            print(f"  a report is drawn outside its card ({r['id']}) — {r['why']}")
        return 1
    print("every card's report is drawn inside the card")

    offered, columns = menu.get("offered"), menu.get("columns") or []
    print(f"\nstates on the board {len(columns):>3}   offered by the menu  "
          f"{len(offered) if offered else 0:>3}")
    if offered is None:
        print("no card opened a menu that sets its state, so that rule checked nothing")
        return 1
    missing = [c for c in columns if c not in offered]
    if missing:
        print("  the menu cannot set: " + ", ".join(missing))
        return 1
    print("the menu offers every state the board draws")
    return 0


if __name__ == "__main__":
    sys.exit(main())
