#!/usr/bin/env python3
"""Does a job's card count the pieces that count, and say what it dropped?

    board-counts-agree.py <project-path> [--url http://127.0.0.1:3008]
                          [--shot out.png] [--count-dropped]

Dropped work is not part of a job. A job of sixteen pieces with five dropped is a
job of eleven: it reads 11/11 and 100% once those eleven are done, and it says
"5 dropped" beside them — the manager's ruling, 2026-08-17. Counting the dropped
ones in the total is what left a job with nothing to do sitting at 69% with the
sign-off button withheld, and no test that stops at the code can see it: the
screen looked calm and drew the wrong number.

So this asks `bd` what each job holds, opens the project screen in a real
browser, reads the fraction, the percentage and the dropped note off every job
card, and compares. It also reads what each card says about its own pieces,
because a bar counting eleven over a list of sixteen is the disagreement the
rule exists to stop.

`--count-dropped` puts the old rule back on this side of the comparison, which
is how the check is shown to bite: run against the fixed screen it must name
every job that dropped anything.

A live screen never finishes loading — its updates stream forever — so a plain
headless screenshot never fires. This drives the browser over the debugging
protocol instead: navigate, settle, read the DOM.
"""
import argparse
import json
import re
import subprocess
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

PORT = 9336

# What the board stores for work that was dropped: closed, and marked.
DROPPED_LABEL = "cancelled"


def bd_list(project):
    out = subprocess.run(["bd", "list", "--all", "--json"],
                         cwd=project, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"bd list failed:\n{out.stderr.strip()}")
    return json.loads(out.stdout or "[]")


def screen_percent(done, total):
    """The percentage the screen draws, worked out the screen's own way.

    Python rounds a half to the even number and the browser rounds it up, so one
    piece of eight is 12 here and 13 there — the check would then call a board
    that is right wrong. And the two ends of the bar are held: a hundred means
    every piece is in, a zero means not one of them is, and the screen refuses
    to round its way to either.
    """
    if not total:
        return 0
    if done == total:
        return 100
    if done == 0:
        return 0
    return min(99, max(1, int(done / total * 100 + 0.5)))


def dropped(card):
    return (card.get("status") == "closed"
            and DROPPED_LABEL in (card.get("labels") or []))


def parent_of(card, known):
    """Which job a piece belongs to, the three ways the product decides it.

    server/src/routes/beads.rs reads a stated parent, then a parent-child
    dependency, then the piece's own dotted id. Reading only the first is how a
    whole job can drop out of this comparison while the run still goes green.
    """
    stated = card.get("parent") or card.get("parent_id")
    if stated:
        return stated
    for dep in card.get("dependencies") or []:
        if isinstance(dep, dict) and dep.get("type") == "parent-child":
            return dep.get("depends_on_id")
    # The LAST dot, the way the server does it (rfind): a piece numbered
    # bw-4gk.5.2 belongs to bw-4gk.5, not to bw-4gk. Cutting at the first dot
    # gives a different owner for every number with two of them.
    dot = card["id"].rfind(".")
    if dot != -1 and card["id"][:dot] in known:
        return card["id"][:dot]
    return None


def board_jobs(project, count_dropped):
    """Every card's expected numbers, keyed by id: pieces, finished, dropped.

    Every card the board holds gets an entry, including one with no pieces yet
    — a job is opened before its work items are poured, and its card draws a
    bar from the first moment, so an entry of nothing is the right answer for
    it rather than a hole in the comparison. Only a card the board has never
    heard of is a hole.

    `count_dropped` restores the rule this check exists to refuse, so the check
    can be shown going red against a screen that is right.
    """
    cards = bd_list(project)
    known = {c["id"] for c in cards}
    children = {}
    for card in cards:
        parent = parent_of(card, known)
        if parent:
            children.setdefault(parent, []).append(card)

    jobs = {}
    for card in cards:
        kids = children.get(card["id"]) or []
        gone = [k for k in kids if dropped(k)]
        counted = kids if count_dropped else [k for k in kids if not dropped(k)]
        # Dropped work is stored closed and marked, so "finished" is closed and
        # NOT marked — under the old rule too. That rule put dropped pieces in
        # the total and never in the finished count, which is exactly how a job
        # with nothing left to do sat at 10 of 14; counting them as finished as
        # well would ask for 14 of 14, a screen that never existed.
        done = [k for k in counted if k.get("status") == "closed" and not dropped(k)]
        jobs[card["id"]] = {
            "total": len(counted),
            "done": len(done),
            "dropped": len(gone),
            "pieces": len(kids),
        }
    return jobs


class Browser:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
             f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
             "--window-size=1500,1000", "--user-data-dir=/tmp/board-counts-profile",
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


# A job's card is a frame in a column that draws a progress bar.
#
# The numbers are read off the bar itself and off the block around it, never off
# the card's whole text: a job whose own title says "reads 100% on the board"
# would otherwise be measured against its own description.
READ_JOBS = """
(() => {
  const jobs = {};
  for (const el of document.querySelectorAll('[data-column] .theme-card[data-bead-id]')) {
    const bar = el.querySelector('[aria-label^="Epic progress:"]');
    if (!bar) continue;
    const fraction = bar.getAttribute('aria-label')
      .match(/^Epic progress: (\\d+) of (\\d+) completed$/);
    if (!fraction) continue;
    const block = bar.parentElement;
    const percent = block.innerText.match(/(\\d+)%/);
    const drop = block.innerText.match(/(\\d+) dropped/);
    const header = [...el.querySelectorAll('button')]
      .map(b => b.textContent.match(/Child Tasks \\(([^)]*)\\)/))
      .find(Boolean);
    jobs[el.dataset.beadId] = {
      done: Number(fraction[1]),
      total: Number(fraction[2]),
      percent: percent ? Number(percent[1]) : null,
      dropped: drop ? Number(drop[1]) : 0,
      list: header ? header[1] : null,
    };
  }
  return jobs;
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--url", default="http://127.0.0.1:3008")
    ap.add_argument("--shot", help="also write a screenshot of the board here")
    ap.add_argument("--count-dropped", action="store_true",
                    help="expect the old rule, to show this check going red")
    args = ap.parse_args()

    projects = json.load(urllib.request.urlopen(f"{args.url}/api/projects"))
    match = [p for p in projects if p["path"] == args.project]
    if not match:
        sys.exit(f"the screen does not know a project at {args.project}")

    held = board_jobs(args.project, args.count_dropped)

    b = Browser()
    try:
        b.send("Page.enable")
        b.send("Runtime.enable")
        b.send("Page.navigate", url=f"{args.url}/project?id={match[0]['id']}")
        time.sleep(8)
        drawn = b.js(READ_JOBS)
        if args.shot:
            import base64
            shot = b.send("Page.captureScreenshot", format="png")
            open(args.shot, "wb").write(base64.b64decode(shot["data"]))
    finally:
        b.close()

    if not drawn:
        sys.exit("no job card on the screen draws a count — is this the fork?")

    bad, checked, with_dropped, skipped = [], 0, 0, []
    for job, shown in sorted(drawn.items()):
        want = held.get(job)
        if want is None:
            # A card drawn with a progress bar that the board has no pieces for
            # is a hole in the comparison, not a card to pass over: this used to
            # be a bare `continue`, and the run still ended by saying every job
            # counts the pieces that count.
            skipped.append(job)
            continue
        checked += 1
        if want["dropped"]:
            with_dropped += 1
        if (shown["done"], shown["total"]) != (want["done"], want["total"]):
            bad.append(f"{job} holds {want['done']}/{want['total']} "
                       f"({want['pieces']} pieces, {want['dropped']} dropped) "
                       f"but draws {shown['done']}/{shown['total']}")
            continue
        if shown["dropped"] != want["dropped"]:
            bad.append(f"{job} dropped {want['dropped']} pieces "
                       f"but the card says {shown['dropped'] or 'nothing'}")
        expect_percent = screen_percent(shown["done"], shown["total"])
        if shown["percent"] is not None and shown["percent"] != expect_percent:
            bad.append(f"{job} draws {shown['done']}/{shown['total']} "
                       f"but calls it {shown['percent']}%")
        # A bar counting eleven over a list of sixteen is the disagreement the
        # rule exists to stop, so the list says the same two numbers.
        if shown["list"] is not None:
            want_list = (f"{want['total']} · {want['dropped']} dropped"
                         if want["dropped"] else str(want["pieces"]))
            if shown["list"].strip() != want_list:
                bad.append(f"{job} lists its pieces as ({shown['list']}) "
                           f"where the count above says ({want_list})")

    print(f"job cards read {checked:>4}   of them with dropped work {with_dropped:>4}"
          f"   not compared {len(skipped):>4}")
    if args.count_dropped:
        print("expecting the OLD rule: dropped work counted towards the job")

    if skipped:
        print("\nthese job cards draw a count the board holds no pieces for, so "
              "nothing about them was checked:")
        for job in skipped[:20]:
            print("  " + job)
        if len(skipped) > 20:
            print(f"  … and {len(skipped) - 20} more")
        return 1

    if bad:
        print("\nthe screen and the board disagree:")
        for line in bad[:20]:
            print("  " + line)
        if len(bad) > 20:
            print(f"  … and {len(bad) - 20} more")
        return 1
    if with_dropped == 0:
        print("\nno job on this board has dropped work, so nothing was actually compared")
        return 1
    print("\nevery job counts the pieces that count, and says what it dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
