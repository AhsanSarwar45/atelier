#!/usr/bin/env python3
"""Build a manager report page from its spec.

    report <slug>.report.json            # page lands beside the spec
    report <slug>.report.json -o page.html

The agent writes the spec — words, numbers, pictures. This writes the page.
Slot order, look and interaction are not the agent's to choose, and an
incomplete spec does not build. Format: reporting/README.md.

Specs live here, under the project they are about; the pictures they name live
in that project, so an image path is resolved against the directory the command
was run from before the spec's own.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import html
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from blocks import OPAQUE, ReportError, render as render_block  # noqa: E402
from board import status as board_status  # noqa: E402
from jargon import jargon, markup  # noqa: E402

HERE = Path(__file__).resolve().parent
STAMP = "@@REPORT-BUILD@@"
MAX_BYTES = 15_500_000
DECISION_REF = re.compile(r"\bD\d+\b")
SLOTS = ("title", "actions", "status", "content", "decisions", "next")

# A count of the work, typed. True the day it is written and wrong by the next
# morning, while the board beside it keeps moving.
# Only a count OF STEPS: a measurement that happens to be "48 of 166" is a
# number the report is allowed to carry.
NUMBER = r"\d+|one|two|three|four|five|six|seven|eight|nine|ten"
COUNTED = re.compile(rf"\b(?:{NUMBER})\s+steps?\b", re.I)
# A section that sets out the work in order is the checklist written twice. The
# label has to BE the list's name; a section merely about the plan is fine.
STEP_LIST = re.compile(r"^(the )?(work|plan|steps|roadmap)\b[\s,]*(in order|so far|ahead)?$", re.I)
BOARD_URL = os.environ.get("BOARD_URL", "http://127.0.0.1:3008").rstrip("/")


def handover(spec: Path, out: Path) -> tuple[str, str]:
    """The link to hand the manager, and a word about it when it is second best.

    A path on disk is a path on disk: an editor claims it before any browser
    sees it. The screen serves the same report over http, rebuilt from this
    spec as it opens, so that link is the one worth handing over.
    """
    slug = spec.name.replace(".report.json", "")
    # No `path` here: the server looks the project's folder up from its own
    # project list by this name, so the link keeps working after the folder
    # it was built in — often a worktree — is gone.
    query = urllib.parse.urlencode({"project": spec.resolve().parent.name, "slug": slug})
    try:
        urllib.request.urlopen(f"{BOARD_URL}/api/reports", timeout=1.0).read(1)
    except Exception:
        return out.resolve().as_uri(), "the board screen is not up, so this is the file itself"
    return f"{BOARD_URL}/api/reports/page?{query}", ""


# ── the spec, walked ─────────────────────────────────────────────────────────

def strings(node, path="") -> list[tuple[str, str]]:
    """Every manager-facing string in the spec, with where it sits."""
    out = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k in OPAQUE or k == "glossary":
                continue
            out += strings(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += strings(v, f"{path}[{i}]")
    elif isinstance(node, str):
        out.append((path, node))
    return out


class Ctx:
    def __init__(self, glossary: list[dict], base: Path, project: Path | None = None):
        self.base = base
        self.project = project or base
        self.gloss = {g["term"]: g["plain"] for g in glossary}
        self.bytes = 0
        self._cache: dict[str, str] = {}
        # Plain-words hits found while building, from text the spec does not hold.
        self.warnings: list[str] = []

    def text(self, s: str) -> str:
        out = html.escape(str(s))
        for term, plain in self.gloss.items():
            out = re.sub(
                rf"\b{re.escape(html.escape(term))}\b",
                f'<abbr class="gloss" title="{html.escape(plain)}">{html.escape(term)}</abbr>',
                out,
                count=1,
            )
        return out

    def image(self, shot: dict) -> str:
        if "src" in shot:
            return html.escape(shot["src"])
        if "path" not in shot:
            raise ReportError("an image needs a 'path' to a local file")
        key = shot["path"]
        if key in self._cache:
            return self._cache[key]
        if Path(key).is_absolute():
            p = Path(key)
        else:
            p = next((c for c in ((self.project / key), (self.base / key)) if c.is_file()),
                     self.project / key).resolve()
        if not p.is_file():
            raise ReportError(f"image not found: {key} — looked in {self.project} and {self.base}")
        mime = mimetypes.guess_type(p.name)[0] or "image/png"
        raw = p.read_bytes()
        self.bytes += len(raw)
        uri = f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")
        self._cache[key] = uri
        return uri


# ── validation ───────────────────────────────────────────────────────────────

def previous(spec_path: Path) -> dict | None:
    """The committed version of this spec, so decision numbers cannot move."""
    try:
        root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True, cwd=spec_path.parent,
        ).stdout.strip()
        rel = spec_path.resolve().relative_to(Path(root))
        out = subprocess.run(
            ["git", "show", f"HEAD:{rel.as_posix()}"],
            capture_output=True, text=True, cwd=root,
        )
        return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else None
    except Exception:
        return None


def validate(spec: dict, spec_path: Path) -> tuple[list[str], list[str]]:
    """Faults that stop the page, and plain-words warnings that do not.

    Jargon warns rather than blocks — the manager's call, so an unfamiliar term
    never costs a report. Everything shaping the page stays a hard refusal.
    """
    bad = []

    for slot in SLOTS:
        if slot not in spec:
            bad.append(f"slot {slot!r} is missing — a report has all six, in order")
    if bad:
        return bad, []

    title = str(spec["title"]).strip()
    if len(title.split()) > 6:
        bad.append(f"title is {len(title.split())} words — a short noun phrase, six or fewer")
    if title.endswith((".", "?", "!")) or ":" in title or " - " in title:
        bad.append("title is a name, not a sentence and not a name with an explainer after it")

    actions = spec["actions"]
    questions = actions.get("questions", [])
    if not questions and not actions.get("none"):
        bad.append("the action slot needs questions, or none:true for an FYI report")
    for i, q in enumerate(questions, 1):
        for _, s in strings(q):
            if DECISION_REF.search(s):
                bad.append(
                    f"question {i} points at {DECISION_REF.search(s).group(0)} — "
                    "spell the question out; the manager never hunts for it"
                )
        if len(q.get("options", [])) < 2:
            bad.append(f"question {i} needs at least two answers to click")
        if sum(1 for o in q.get("options", []) if o.get("pick")) != 1:
            bad.append(f"question {i} needs exactly one recommended answer")
        # A question outlives its own answer unless something can kill it. The
        # card it is holding up does that: the work lands, the board closes it,
        # and the next build refuses to print the question again.
        if not str(q.get("holds", "")).strip():
            bad.append(
                f"question {i} names no card it is holding up — add "
                '"holds": "<card id>", or it will still be on the page long '
                "after the answer stopped mattering"
            )

    status = spec["status"]
    if status.get("card"):
        typed = [k for k in ("now", "next_up", "items") if status.get(k)]
        if typed:
            bad.append(
                f"the status slot names a card AND types {', '.join(typed)} — the board owns all "
                "three when a card is named; delete them from the spec"
            )
        # The board owns the list of the work, so nothing else may set it out
        # again: a second copy freezes the day it is typed.
        for where, s in strings(spec):
            hit = COUNTED.search(s)
            if hit:
                bad.append(
                    f"{where} counts the work itself ({hit.group(0)!r}) while this report reads a "
                    "card — say what is happening, and let the checklist carry the count"
                )
        for sec in spec["content"]:
            if STEP_LIST.search(str(sec.get("label", ""))):
                bad.append(
                    f"section {sec.get('label')!r} sets out the work in order, and the checklist "
                    "already does that from the card — cut the section, or drop status.card and "
                    "own the list by hand"
                )
    else:
        if not status.get("now"):
            bad.append("the status slot needs a 'now' line")
        if not status.get("next_up"):
            bad.append("the status slot needs 'next_up' — name the very next piece of work")
    for it in status.get("items", []):
        if it.get("state") not in ("done", "draft", "todo"):
            bad.append(f"checklist item {it.get('text', '')!r} needs state done, draft or todo")

    ids = [d.get("id", "") for d in spec["decisions"]]
    if len(set(ids)) != len(ids):
        bad.append("two decisions share a number")
    order = []
    for d in spec["decisions"]:
        if not re.fullmatch(r"D\d+", d.get("id", "")):
            bad.append(f"decision id {d.get('id')!r} is not D followed by a number")
        else:
            order.append(int(d["id"][1:]))
    if order != sorted(order):
        bad.append("decisions are out of order — numbers only ever go up")

    old = previous(spec_path)
    if old:
        was = {d["id"]: d.get("title", "") for d in old.get("decisions", [])}
        now = {d["id"]: d.get("title", "") for d in spec["decisions"]}
        for did, was_title in was.items():
            if did not in now:
                bad.append(f"{did} vanished — a decision number is never withdrawn or reused")
            elif now[did] != was_title and "revised" not in str(
                next(d for d in spec["decisions"] if d["id"] == did).get("tag", "")
            ):
                bad.append(f"{did} now says something else — mark it tag:'revised' or give the new call a new number")

    nxt = spec["next"]
    if not nxt.get("if_nothing"):
        bad.append("the next slot needs 'if_nothing' — what happens if the manager says nothing")
    for s in nxt.get("steps", []):
        if not s.get("cost"):
            bad.append(f"step {s.get('step', '')!r} needs a cost")

    glossary = spec.get("glossary", [])
    if len(glossary) > 6:
        bad.append(f"{len(glossary)} glossed terms — six is the ceiling; say the rest in plain words")
    glossed = {g["term"] for g in glossary}

    warn = []
    for where, s in strings(spec):
        for problem in markup(s):
            bad.append(f"{where}: carries {problem} — the look is not yours to write")
        for problem in jargon(s, glossed):
            warn.append(f"{where}: {problem}")

    return bad, warn


# ── rendering ────────────────────────────────────────────────────────────────

def card(kind: str, cid: str, label: str, body: str, ctx: Ctx) -> str:
    return f'<div class="card {kind}" id="{cid}"><p class="label">{ctx.text(label)}</p>{body}</div>'


def action_card(spec: dict, ctx: Ctx) -> str:
    a = spec["actions"]
    if a.get("none") and not a.get("questions"):
        body = '<div class="notebox n-good"><b>No action needed</b><span>' + ctx.text(
            a.get("fyi", "For your information only.")
        ) + "</span></div>"
        return card("c-act", "act", "What I need from you", body, ctx)

    parts = []
    for i, q in enumerate(a["questions"], 1):
        chips = []
        for o in q["options"]:
            say = o.get("say") or (o["label"].rstrip(".") + ".")
            chips.append(
                f'<button class="chip" role="radio" aria-checked="{str(bool(o.get("pick"))).lower()}" '
                f'data-say="{ctx.text(say)}">{ctx.text(o["label"])}</button>'
            )
        if q.get("note"):
            chips.append(f'<span class="note">{ctx.text(q["note"])}</span>')
        parts.append(
            f'<div class="q"><span class="badge">{i}</span><span>'
            f'<p class="ask">{ctx.text(q["ask"])}</p>'
            f'<div class="chips" role="radiogroup" aria-label="{ctx.text(q["ask"])}">'
            + "".join(chips) + "</div></span></div>"
        )
    parts.append('<div class="replyrow"><div class="prev" id="prev"></div>'
                 '<button class="send" id="send">Copy my reply</button></div>')
    return card("c-act", "act", "What I need from you", "".join(parts), ctx)


def starting_step(spec: dict) -> str:
    """The step the plan marks as starting, or "" when the plan has run out.

    Without a mark the first step is it. Why this line rather than the board's:
    README, "Next-up is the exception".
    """
    steps = [s for s in ((spec.get("next") or {}).get("steps") or []) if s.get("step")]
    if not steps:
        return ""
    return next((s["step"] for s in steps if s.get("starting")), steps[0]["step"])


def status_card(spec: dict, ctx: Ctx) -> str:
    s = spec["status"]
    if s.get("card"):
        s = board_status(s["card"], ctx.project, ctx.base)
        # README, "Next-up is the exception". A job with nothing left keeps the
        # list's own last word: a plan step advertised under a full set of ticks
        # reads as work still to come.
        if any(i["state"] != "done" for i in s.get("items", [])):
            s["next_up"] = starting_step(spec) or s["next_up"]
        # A card's title is written on the board and reaches the manager here
        # unedited, so it answers to the same phrasebook as the rest of the page.
        glossed = set(ctx.gloss)
        for where, text in [("now", s["now"]), ("next up", s["next_up"])] + \
                [("a checklist row", i["text"]) for i in s.get("items", [])]:
            for problem in jargon(text, glossed):
                ctx.warnings.append(f"{where} {text[:44]!r}: {problem}")
    items = s.get("items", [])
    n = max(len(items), 1)
    done = sum(1 for i in items if i["state"] == "done") / n * 100
    draft = sum(1 for i in items if i["state"] == "draft") / n * 100
    glyph = {"done": "✓", "draft": "", "todo": ""}
    rows = []
    for it in items:
        tag = f' <span class="pill p-amber">{ctx.text(it["tag"])}</span>' if it.get("tag") else ""
        rows.append(
            f'<li class="{it["state"]}"><span class="box">{glyph[it["state"]]}</span>'
            f'<span>{ctx.text(it["text"])}{tag}</span></li>'
        )
    body = (
        '<div class="strip">'
        f'<div class="now"><b>Now</b> <span>{ctx.text(s["now"])}</span></div>'
        f'<div class="now up"><b>Next up</b> <span>{ctx.text(s["next_up"])}</span></div>'
        "</div>"
        '<div class="progress">'
        f'<div class="bar"><i style="width:{done:.0f}%"></i><u style="width:{draft:.0f}%"></u></div>'
        '<div class="barkey">'
        '<span><b style="background:var(--green)"></b>Settled</span>'
        '<span><b style="background:var(--amber)"></b>Started, not finished</span>'
        '<span><b style="background:var(--line)"></b>Not started</span>'
        "</div></div>"
        '<ul class="check">' + "".join(rows) + "</ul>"
    )
    return card("c-stat", "stat", "Where we are", body, ctx)


def decisions_card(spec: dict, ctx: Ctx) -> str:
    rows = []
    for d in spec["decisions"]:
        tag = f' <span class="pill p-violet">{ctx.text(d["tag"])}</span>' if d.get("tag") else ""
        why = f'<span class="m">{ctx.text(d["why"])}</span>' if d.get("why") else ""
        if d.get("needs_you"):
            rows.append(
                f'<div class="d hot"><span class="id">{d["id"]}</span>'
                f'<span><b>{ctx.text(d["title"])}</b> <span class="pill p-amber">needs you</span>{why}</span>'
                "<span></span></div>"
            )
        else:
            rows.append(
                f'<div class="d"><span class="id">{d["id"]}</span>'
                f'<span><b>{ctx.text(d["title"])}</b>{tag}{why}</span>'
                f'<button class="ovr" aria-pressed="false" data-d="{d["id"]}">override</button></div>'
            )
    return card("c-dec", "dec", "Decisions · press override on any you want changed",
                '<div class="dec">' + "".join(rows) + "</div>", ctx)


def next_card(spec: dict, ctx: Ctx) -> str:
    n = spec["next"]
    rows = []
    for i, s in enumerate(n.get("steps", []), 1):
        mark = ' <span class="pill p-green">starting here</span>' if s.get("starting") else ""
        cost = {"tiny": "green", "small": "blue", "medium": "amber", "large": "red"}.get(s["cost"], "grey")
        rows.append(
            f'<tr><td class="idx">{i}</td><td>{ctx.text(s["step"])}{mark}</td>'
            f'<td class="r"><span class="pill p-{cost}">{ctx.text(s["cost"])}</span></td></tr>'
        )
    body = (
        f'<div class="idle"><b>If you say nothing</b> <span>{ctx.text(n["if_nothing"])}</span></div>'
        '<div class="scroll"><table><thead><tr><th>#</th><th>Step</th><th class="r">Cost</th></tr></thead>'
        "<tbody>" + "".join(rows) + "</tbody></table></div>"
    )
    return card("c-next", "next", "Next", body, ctx)


def build(spec: dict, ctx: Ctx) -> str:
    cards, nav = [], []
    nav.append(('act', 'What I need', True))
    cards.append(action_card(spec, ctx))
    nav.append(('stat', 'Where we are', False))
    cards.append(status_card(spec, ctx))

    for i, section in enumerate(spec["content"], 1):
        cid = f"s{i}"
        lead = f'<p class="lead">{ctx.text(section["lead"])}</p>' if section.get("lead") else ""
        body = lead + "".join(render_block(b, ctx) for b in section.get("blocks", []))
        cards.append(card("c-info", cid, section["label"], body, ctx))
        nav.append((cid, section["label"], False))

    nav.append(('dec', 'Decisions', False))
    cards.append(decisions_card(spec, ctx))
    nav.append(('next', 'Next', False))
    cards.append(next_card(spec, ctx))

    link_html = []
    for i, (cid, label, flag) in enumerate(nav):
        on = ' class="on"' if i == 0 else ""
        dot = '<span class="flag" title="waiting on you"></span>' if flag else ""
        link_html.append(
            f'<li><a href="#{cid}"{on}><span class="n">{i + 1}</span>'
            f"<span>{ctx.text(label)}{dot}</span></a></li>"
        )
    links = "".join(link_html)

    eyebrow = f'<p class="label">{ctx.text(spec["eyebrow"])}</p>' if spec.get("eyebrow") else ""
    css = (HERE / "page.css").read_text(encoding="utf-8")
    js = (HERE / "page.js").read_text(encoding="utf-8")

    return (
        '<meta charset="utf-8">\n'
        f"<title>{ctx.text(spec['title'])}</title>\n"
        f"<!-- built by scripts/report/build.py — {STAMP} -->\n"
        f"<style>{css}</style>\n"
        '<div class="shell">'
        f'<nav aria-label="Contents"><p class="label">Contents</p><ol>{links}</ol></nav>'
        f"<main><header>{eyebrow}<h1>{ctx.text(spec['title'])}</h1></header>"
        + "".join(cards) +
        "</main></div>"
        '<div class="lb" id="lb"><div class="bar2">'
        '<button id="lbreset">Fit</button><button id="lbclose">Close</button></div>'
        '<div class="hint">Scroll to zoom · drag to pan · Esc to close</div></div>'
        f"<script>{js}</script>\n"
    )


def stamped(page: str) -> str:
    digest = hashlib.sha256(page.encode("utf-8")).hexdigest()[:32]
    return page.replace(STAMP, digest)


def verify(page: str) -> bool:
    """True when this page is exactly what the builder emitted."""
    m = re.search(r"<!-- built by scripts/report/build\.py — ([0-9a-f]{32}) -->", page)
    if not m:
        return False
    return hashlib.sha256(page.replace(m.group(1), STAMP).encode("utf-8")).hexdigest()[:32] == m.group(1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("spec", type=Path)
    ap.add_argument("-o", "--out", type=Path,
                    help="where the page lands; beside the spec by default")
    ap.add_argument("--project", type=Path, default=Path.cwd(),
                    help="the project the report is about; its pictures resolve from here")
    args = ap.parse_args()
    if args.out is None:
        args.out = args.spec.resolve().with_name(
            args.spec.name.replace(".report.json", "").replace(".json", "") + ".html"
        )

    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        print(f"the spec is not valid JSON: {e}", file=sys.stderr)
        return 2

    problems, warnings = validate(spec, args.spec)
    if problems:
        print("this report does not build:", file=sys.stderr)
        for p in problems:
            print(f"  · {p}", file=sys.stderr)
        return 1

    ctx = Ctx(spec.get("glossary", []), args.spec.resolve().parent, args.project.resolve())
    try:
        page = stamped(build(spec, ctx))
    except ReportError as e:
        print(f"this report does not build: {e}", file=sys.stderr)
        return 1

    warnings += ctx.warnings
    if warnings:
        print(f"WORDS THE MANAGER WOULD HAVE TO DECODE — {len(warnings)}:", file=sys.stderr)
        for w in warnings:
            print(f"  · {w}", file=sys.stderr)
        print("  Rewrite them, or gloss the ones that must stay.", file=sys.stderr)

    if len(page.encode("utf-8")) > MAX_BYTES:
        print(f"the page is {len(page) / 1e6:.1f} MB — shrink the pictures", file=sys.stderr)
        return 1

    args.out.write_text(page, encoding="utf-8")
    parts = [f"{len(page) / 1024:.0f} KB", f"{len(spec['content'])} content sections"]
    if warnings:
        parts.append(f"{len(warnings)} words to plain up")
    link, why = handover(args.spec, args.out)
    if why:
        parts.append(why)
    # The link IS the deliverable: it is what the manager is handed in chat.
    print(f"{link}  ({', '.join(parts)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
