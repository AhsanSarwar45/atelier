#!/usr/bin/env python3
"""Does the screen show the tags the board holds, and does the tag filter obey them?

    board-tags-agree.py <project-path> [--url http://127.0.0.1:3008] [--tag area:board]
                        [--shot out.png]

Every card carries two tags: one naming its system, one naming its kind of work.
This asks `bd` for them, opens the project screen in a real browser, reads the
chips each drawn card shows, then picks one tag in the filter and reads the board
again. Exits non-zero when the screen and the board disagree, so it can stand as
a gate.

A live screen never finishes loading — its updates stream forever — so a plain
headless screenshot never fires. This drives the browser over the debugging
protocol instead: navigate, settle, read the DOM.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request

import websocket  # pip install websocket-client

PORT = 9334

# The namespaces the screen draws. A label outside them is bookkeeping.
NAMESPACES = ("area", "kind")


def bd_list(project):
    out = subprocess.run(["bd", "list", "--all", "--json"],
                         cwd=project, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"bd list failed:\n{out.stderr.strip()}")
    return json.loads(out.stdout or "[]")


def board_tags(project):
    """The tags each card holds, keyed by card id, one per namespace."""
    tags = {}
    for card in bd_list(project):
        own = {}
        for label in card.get("labels") or []:
            namespace, _, value = label.partition(":")
            if namespace in NAMESPACES and value and namespace not in own:
                own[namespace] = label
        tags[card["id"]] = set(own.values())
    return tags


class Browser:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["google-chrome", "--headless=new", "--disable-gpu", "--no-sandbox",
             f"--remote-debugging-port={PORT}", "--remote-allow-origins=*",
             "--window-size=1500,1000", "--user-data-dir=/tmp/board-tags-profile",
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


# A card drawn in a column is a frame of its own; anything else carrying a card id
# is a step listed inside one, which counts as on the screen but not as a card.
READ_CARDS = """
(() => {
  const cards = {}, nested = [];
  for (const el of document.querySelectorAll('[data-bead-id]')) {
    const id = el.dataset.beadId;
    if (el.matches('[data-column] .theme-card')) {
      cards[id] = [...el.querySelectorAll('[data-bead-tag]')]
        .filter(t => t.closest('.theme-card[data-bead-id]') === el)
        .map(t => t.dataset.beadTag);
    } else {
      nested.push(id);
    }
  }
  return {cards, nested};
})()
"""

# The menu opens on the pointer going down, not on a click, so a bare click()
# leaves it shut and every item unreachable.
PRESS = """
const press = (el) => {
  for (const type of ['pointerdown', 'pointerup']) {
    el.dispatchEvent(new PointerEvent(type, {bubbles: true, button: 0, pointerType: 'mouse'}));
  }
  el.click();
};
"""

OPEN_TAG_FILTER = """
(() => {
  %s
  const trigger = document.querySelector('[aria-label="Filter by tag"]');
  if (!trigger) return 'no tag filter on the screen';
  press(trigger);
  return 'opened';
})()
""" % PRESS


def choose(browser, value):
    opened = browser.js(OPEN_TAG_FILTER)
    if opened != 'opened':
        return opened
    time.sleep(1)
    picked = browser.js("""
    (() => {
      %s
      const wanted = %s;
      for (const item of document.querySelectorAll('[role="menuitemcheckbox"]')) {
        if (item.textContent.trim() === wanted) { press(item); return 'picked'; }
      }
      return 'the filter offers no ' + wanted;
    })()
    """ % (PRESS, json.dumps(value)))
    time.sleep(2)
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--url", default="http://127.0.0.1:3008")
    ap.add_argument("--tag", default="area:board", help="tag to narrow the board to")
    ap.add_argument("--shot", help="also write a screenshot of the filtered board here")
    args = ap.parse_args()

    namespace, _, value = args.tag.partition(":")
    if namespace not in NAMESPACES or not value:
        sys.exit(f"{args.tag} is not a tag the screen draws")

    projects = json.load(urllib.request.urlopen(f"{args.url}/api/projects"))
    match = [p for p in projects if p["path"] == args.project]
    if not match:
        sys.exit(f"the screen does not know a project at {args.project}")

    held = board_tags(args.project)

    b = Browser()
    try:
        b.send("Page.enable")
        b.send("Runtime.enable")
        b.send("Page.navigate", url=f"{args.url}/project?id={match[0]['id']}")
        time.sleep(8)
        wide = b.js(READ_CARDS)
        picked = choose(b, value)
        narrow = b.js(READ_CARDS)
        if args.shot:
            import base64
            shot = b.send("Page.captureScreenshot", format="png")
            open(args.shot, "wb").write(base64.b64decode(shot["data"]))
    finally:
        b.close()

    if not wide or not wide["cards"]:
        sys.exit("no card on the screen says which card it is — is this the fork?")

    bad = []

    # 1. Every drawn card shows the tags its record holds.
    shown = 0
    for card, chips in wide["cards"].items():
        want = held.get(card)
        if want is None:
            continue
        if set(chips) != want:
            bad.append(f"{card} holds {sorted(want) or 'no tag'} "
                       f"but draws {sorted(chips) or 'none'}")
        shown += len(chips)
    print(f"cards drawn {len(wide['cards']):>4}   tag chips on them {shown:>4}")

    # 2. The filter narrows to exactly the cards that carry the chosen tag.
    if picked != "picked":
        print(f"\nthe filter could not be used: {picked}")
        return 1
    carriers = {c for c, tags in held.items() if args.tag in tags}
    drawn_now = set(narrow["cards"])
    intruders = {c for c in drawn_now if args.tag not in held.get(c, set())}
    was_on_screen = set(wide["cards"]) | set(wide["nested"])
    still_on_screen = drawn_now | set(narrow["nested"])
    lost = (carriers & was_on_screen) - still_on_screen
    print(f"filtered to {args.tag}   board holds {len(carriers):>4}   "
          f"screen draws {len(drawn_now):>4}   "
          f"drawn without it {len(intruders):>3}   carrying it but gone {len(lost):>3}")

    for card in sorted(intruders):
        bad.append(f"{card} is drawn under the {args.tag} filter without carrying it")
    for card in sorted(lost):
        bad.append(f"{card} carries {args.tag} but the filter dropped it off the screen")

    if bad:
        print("\nthe screen and the board disagree:")
        for line in bad[:20]:
            print("  " + line)
        if len(bad) > 20:
            print(f"  … and {len(bad) - 20} more")
        return 1
    print("\nevery card draws the tags it holds, and the filter keeps exactly its carriers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
