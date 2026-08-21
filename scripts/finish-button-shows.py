#!/usr/bin/env python3
"""Is the button that finishes a job actually drawn on the manager's screen?

    finish-button-shows.py [--url http://127.0.0.1:3008] [--shot out.png] [--keep]

The whole of bw-4gk was opened so that a job whose every counted piece is done
— with some of its pieces dropped — reads 100% and offers the manager the
button that signs it off. Every proof of that button was a jsdom unit case, and
this project's own rule says a unit case is not a verified change: the Manager
Review column on the running board is empty, so nobody had ever seen the button
on a real screen.

Waiting for such a job to appear on the manager's own board is not a check, so
this builds one. It stands up a throwaway board in a temp directory, pours two
jobs into it — one waiting for the manager, one still waiting to be read, both
with every counted piece finished and one piece dropped — registers it with the
running app as a project, opens it in a real browser and looks.

What it asserts:
  * the job in Manager Review draws 'Mark Done';
  * the job in Agent Review does not — a job nobody has read yet has been
    signed by nobody, and a finish offered there is how unsigned work reached
    Done;
  * both draw the dropped-work count and read 100%, which is the counting rule
    the button hangs off.

The throwaway project and its directory are removed on the way out, whether the
check passed or not, unless --keep is given.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

CHECK_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, CHECK_DIR)

# The browser driver already written for the other screen check, rather than a
# second copy of it.
_counts = open(os.path.join(CHECK_DIR, "board-counts-agree.py")).read()
_ns = {"__name__": "board_counts_agree"}
exec(compile(_counts.split("def main()")[0], "board-counts-agree.py", "exec"), _ns)
Browser = _ns["Browser"]

WHEN = "2026-01-01T00:00:00Z"


def piece(job, n, status, dropped=False):
    return {
        "_type": "issue",
        "id": f"{job}.{n}",
        "title": f"A piece of {job}",
        "description": "",
        "status": status,
        "priority": 1,
        "issue_type": "task",
        "owner": "probe",
        "created_at": WHEN,
        "updated_at": WHEN,
        "closed_at": WHEN if status == "closed" else None,
        "labels": ["cancelled"] if dropped else [],
        "dependencies": [{
            "issue_id": f"{job}.{n}",
            "depends_on_id": job,
            "type": "parent-child",
            "created_at": WHEN,
            "created_by": "probe",
            "metadata": "{}",
        }],
    }


def job(ident, status, title):
    return {
        "_type": "issue",
        "id": ident,
        "title": title,
        "description": "",
        "status": status,
        "priority": 1,
        "issue_type": "epic",
        "owner": "probe",
        "created_at": WHEN,
        "updated_at": WHEN,
        "labels": [],
        "dependencies": [],
    }


# Two jobs of the same shape — three pieces finished, one dropped — sitting in
# the two columns that must answer differently.
BOARD = [
    job("probe-m", "manager_review", "A job waiting for the manager"),
    piece("probe-m", 1, "closed"), piece("probe-m", 2, "closed"),
    piece("probe-m", 3, "closed"), piece("probe-m", 4, "closed", dropped=True),
    job("probe-r", "in_review", "A job still waiting to be read"),
    piece("probe-r", 1, "closed"), piece("probe-r", 2, "closed"),
    piece("probe-r", 3, "closed"), piece("probe-r", 4, "closed", dropped=True),
]


def run(cmd, cwd):
    out = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"{' '.join(cmd)} failed in {cwd}:\n{out.stdout}\n{out.stderr}")
    return out.stdout


def build_board(root):
    """A board of two jobs and eight pieces, in a directory nobody else uses."""
    run(["git", "init", "-q", "."], root)
    run(["bd", "init"], root)
    # `manager_review` and `in_review` are columns this product added; bd --actor bw-4gk-b4c5580c has to
    # be told they are statuses before it will hold a card in either.
    run(["bd", "config", "set", "status.custom",
         "manager_review:wip,in_review:wip"], root)
    lines = "\n".join(json.dumps(rec) for rec in BOARD) + "\n"
    path = os.path.join(root, "probe.jsonl")
    open(path, "w").write(lines)
    run(["bd", "import", path], root)


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    return json.load(urllib.request.urlopen(req))


def delete(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, method="DELETE"))
    except urllib.error.HTTPError:
        pass


# Every job card the board draws, with the column it sits in, what its bar says
# and whether the finish is offered on it.
READ = """
(() => {
  const out = {};
  for (const col of document.querySelectorAll('[data-column]')) {
    for (const el of col.querySelectorAll('.theme-card[data-bead-id]')) {
      const bar = el.querySelector('[aria-label^="Epic progress:"]');
      if (!bar) continue;
      const label = bar.getAttribute('aria-label');
      const block = bar.parentElement;
      const percent = block.innerText.match(/(\\d+)%/);
      const drop = block.innerText.match(/(\\d+) dropped/);
      out[el.dataset.beadId] = {
        column: col.getAttribute('data-column'),
        bar: label,
        percent: percent ? Number(percent[1]) : null,
        dropped: drop ? Number(drop[1]) : 0,
        finish: [...el.querySelectorAll('button')]
          .some(b => /mark done/i.test(b.textContent || '')),
      };
    }
  }
  return out;
})()
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:3008")
    ap.add_argument("--shot", help="also write a screenshot of the board here")
    ap.add_argument("--keep", action="store_true",
                    help="leave the throwaway project standing, to look at it")
    args = ap.parse_args()

    # Under the home directory: the server refuses to read a board from
    # anywhere else, and the system temp directory is not under it.
    holding = os.path.expanduser("~/.cache/atelier-checks")
    os.makedirs(holding, exist_ok=True)
    root = tempfile.mkdtemp(prefix="finish-button-", dir=holding)
    project = None
    try:
        build_board(root)
        project = post(f"{args.url}/api/projects",
                       {"name": "finish-button probe", "path": root})

        b = Browser()
        try:
            b.send("Page.enable")
            b.send("Runtime.enable")
            b.send("Page.navigate", url=f"{args.url}/project?id={project['id']}")
            time.sleep(8)
            drawn = b.js(READ)
            if args.shot:
                import base64
                shot = b.send("Page.captureScreenshot", format="png")
                open(args.shot, "wb").write(base64.b64decode(shot["data"]))
        finally:
            b.close()
    finally:
        if project and not args.keep:
            delete(f"{args.url}/api/projects/{project['id']}")
        if not args.keep:
            shutil.rmtree(root, ignore_errors=True)

    if not drawn:
        sys.exit("no job card on the screen draws a count — is this the fork?")

    bad = []
    for ident, want_finish, where in (("probe-m", True, "manager_review"),
                                      ("probe-r", False, "inreview")):
        shown = drawn.get(ident)
        if shown is None:
            bad.append(f"{ident} was never drawn on the screen at all")
            continue
        if shown["column"] != where:
            bad.append(f"{ident} sits in {shown['column']}, not {where}")
        if shown["bar"] != "Epic progress: 3 of 3 completed":
            bad.append(f"{ident} draws '{shown['bar']}' where 3 of 3 was poured")
        if shown["percent"] != 100:
            bad.append(f"{ident} calls three of three {shown['percent']}%")
        if shown["dropped"] != 1:
            bad.append(f"{ident} dropped one piece but says {shown['dropped'] or 'nothing'}")
        if shown["finish"] != want_finish:
            bad.append(f"{ident} in {where} "
                       + ("offers no finish" if want_finish
                          else "offers the finish, which only the manager's column may"))

    for ident in sorted(drawn):
        s = drawn[ident]
        print(f"  {ident:<10} {s['column']:<16} {s['bar']:<32} "
              f"{s['percent']}%  {s['dropped']} dropped  "
              f"finish {'drawn' if s['finish'] else 'not drawn'}")

    if bad:
        print("\nthe screen is not what the job was opened for:")
        for line in bad:
            print("  " + line)
        return 1
    print("\nthe manager is offered the finish on his own column, and nowhere else")
    return 0


if __name__ == "__main__":
    sys.exit(main())
