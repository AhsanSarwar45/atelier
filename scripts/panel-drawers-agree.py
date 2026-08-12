#!/usr/bin/env python3
"""Do the screen's side panels behave like one another?

    panel-drawers-agree.py <project-path> [--url http://127.0.0.1:3008] [--shots DIR]

Two rules, and this checks both by opening each panel and sampling it while it
should still be moving:

  every drawer slides    — one already in place is one that never animated, and
                           one still fully off-screen is one that never started
  no drawer takes more
  than half the screen   — the board behind it is what the reader came back to

Their widths need not match: a drawer holding a document is not the same thing
as a drawer holding a card's details. Swallowing the screen is the fault, and
that is what is measured.
"""
import argparse
import base64
import json
import subprocess
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

PORT = 9336

# Each panel: an expression picking what to click to open it, and how to find the
# panel that opened.
PANELS = [
    {
        "name": "report",
        "open": "[...document.querySelectorAll('[data-bead-id] button')]"
                ".find(b => (b.innerText || '').includes('Manager report'))",
        "find": "[role=dialog]",
    },
    {
        "name": "card detail",
        "open": "document.querySelector('[data-bead-id] > *')",   # the card itself
        "find": "[role=dialog], .fixed.inset-y-0.right-0",
    },
]

# Early enough that a drawer which animates is neither arrived nor still parked.
SAMPLE_MS = 120


class Browser:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
             f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
             "--window-size=1500,1000", "--user-data-dir=/tmp/panel-check-profile",
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

    def shoot(self, path):
        shot = self.send("Page.captureScreenshot", format="png")
        open(path, "wb").write(base64.b64decode(shot["data"]))

    def close(self):
        self.proc.terminate()


def sample(b, panel):
    """Click the panel open and measure it one frame later."""
    return b.js("""
    (async () => {
      const opener = %s;
      if (!opener) return {error: 'nothing on the screen opens the %s panel'};
      opener.click();
      await new Promise(r => setTimeout(r, %d));
      const els = [...document.querySelectorAll(%s)]
        .filter(e => e.getBoundingClientRect().width > 200);
      if (!els.length) return {error: 'the %s panel did not open'};
      const r = els[els.length - 1].getBoundingClientRect();
      return {width: Math.round(r.width),
              offscreen: Math.round(Math.max(0, r.right - window.innerWidth)),
              viewport: window.innerWidth};
    })()
    """ % (panel["open"], panel["name"], SAMPLE_MS,
           json.dumps(panel["find"]), panel["name"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--url", default="http://127.0.0.1:3008")
    ap.add_argument("--shots", help="write a screenshot of each panel into this folder")
    args = ap.parse_args()

    projects = json.load(urllib.request.urlopen(f"{args.url}/api/projects"))
    match = [p for p in projects if p["path"] == args.project]
    if not match:
        sys.exit(f"the screen does not know a project at {args.project}")
    page = f"{args.url}/project?id={match[0]['id']}"

    seen = {}
    b = Browser()
    try:
        b.send("Page.enable")
        b.send("Runtime.enable")
        for panel in PANELS:
            b.send("Page.navigate", url=page)   # a fresh page per panel, so one
            time.sleep(8)                       # opening cannot hide the next
            seen[panel["name"]] = sample(b, panel)
            if args.shots:
                b.shoot(f"{args.shots}/panel-{panel['name'].replace(' ', '-')}.png")
    finally:
        b.close()

    bad = []
    for name, s in seen.items():
        if not s or s.get("error"):
            bad.append((s or {}).get("error", f"the {name} panel could not be measured"))
            print(f"{name:<12} —")
            continue
        share = s["width"] / s["viewport"]
        print(f"{name:<12} width {s['width']:>5}px  ({share:4.0%} of the screen)"
              f"   still off-screen {s['offscreen']:>4}px")
        if s["offscreen"] == 0:
            bad.append(f"the {name} panel is already in place one frame in — it does not slide")
        elif s["offscreen"] >= s["width"]:
            bad.append(f"the {name} panel has not moved at all")
        if share > 0.5:
            bad.append(f"the {name} panel takes {share:.0%} of the screen")

    if bad:
        print("\nthese are not drawers:")
        for line in bad:
            print("  " + line)
        return 1
    print("\nevery panel slid, and none of them swallowed the screen")
    return 0


if __name__ == "__main__":
    sys.exit(main())
