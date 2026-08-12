#!/usr/bin/env python3
"""The block shelf: every graphic a report may contain.

A block is a dict with a `kind`. Adding a kind here adds it to every future
report — that is the only place a new graphic may be defined
(`docs/reporting.md#shelf`). Colour and type come from `page.css`; nothing here
emits a colour literal.
"""
from __future__ import annotations

TONES = ("grey", "blue", "green", "amber", "red", "violet", "teal")
VAR = {t: f"var(--{t})" for t in TONES if t != "grey"} | {"grey": "var(--muted)"}


class ReportError(Exception):
    pass


def _tone(value: str, where: str) -> str:
    if value not in TONES:
        raise ReportError(f"{where}: tone {value!r} is not one of {', '.join(TONES)}")
    return value


def _need(block: dict, key: str, kind: str):
    if key not in block:
        raise ReportError(f"{kind} block needs a {key!r}")
    return block[key]


# ── plain content ────────────────────────────────────────────────────────────

def _text(b, ctx):
    s = _need(b, "text", "text")
    if "\n\n" in s or len(s) > 240:
        raise ReportError("a text block is ONE short sentence — say it in a table, list or chart instead")
    return f'<p class="lead">{ctx.text(s)}</p>'


def _list(b, ctx):
    tag = "ol" if b.get("ordered") else "ul"
    items = "".join(f"<li>{ctx.text(i)}</li>" for i in _need(b, "items", "list"))
    return f'<{tag} class="bul">{items}</{tag}>'


def _rows(b, ctx):
    out = []
    for r in _need(b, "rows", "rows"):
        cls = " " + r["tone"] if r.get("tone") in ("hot", "gone") else ""
        note = f'<span class="m">{ctx.text(r["note"])}</span>' if r.get("note") else ""
        out.append(
            f'<div class="row{cls}"><span class="n">{ctx.text(r.get("n", ""))}</span>'
            f'<span><b>{ctx.text(_need(r, "title", "rows"))}</b>{note}</span></div>'
        )
    return '<div class="rows">' + "".join(out) + "</div>"


def _note(b, ctx):
    tone = b.get("tone", "info")
    if tone not in ("info", "good", "warn", "bad"):
        raise ReportError("note tone is one of info, good, warn, bad")
    label = f'<b>{ctx.text(b["label"])}</b>' if b.get("label") else "<b></b>"
    return f'<div class="notebox n-{tone}">{label}<span>{ctx.text(_need(b, "text", "note"))}</span></div>'


# ── table ────────────────────────────────────────────────────────────────────

def _cell(c, ctx) -> str:
    if isinstance(c, dict):
        if "pill" in c:
            tone = _tone(c.get("tone", "grey"), "table pill")
            return f'<span class="pill p-{tone}">{ctx.text(c["pill"])}</span>'
        if "num" in c:
            return ctx.text(str(c["num"]))
        if "bold" in c:
            return f'<b>{ctx.text(c["bold"])}</b>'
        raise ReportError(f"table cell {c!r} — a cell is a string, or {{pill}}, {{num}} or {{bold}}")
    return ctx.text(str(c))


def _table(b, ctx):
    cols = _need(b, "columns", "table")
    names, kinds = [], []
    for c in cols:
        if isinstance(c, str):
            names.append(c)
            kinds.append("text")
        else:
            names.append(c.get("name", ""))
            kinds.append(c.get("align", "text"))
    head = "".join(
        f'<th class="r">{ctx.text(n)}</th>' if k in ("right", "num") else f"<th>{ctx.text(n)}</th>"
        for n, k in zip(names, kinds)
    )
    body = []
    for row in _need(b, "rows", "table"):
        if len(row) != len(names):
            raise ReportError(f"table row has {len(row)} cells, the header has {len(names)}")
        cells = []
        for cell, kind in zip(row, kinds):
            cls = ' class="n"' if kind == "num" else (' class="r"' if kind == "right" else "")
            cells.append(f"<td{cls}>{_cell(cell, ctx)}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    return (
        '<div class="scroll"><table><thead><tr>' + head + "</tr></thead><tbody>"
        + "".join(body) + "</tbody></table></div>"
    )


# ── numbers ──────────────────────────────────────────────────────────────────

def _tiles(b, ctx):
    out = []
    for t in _need(b, "tiles", "tiles"):
        tone = _tone(t.get("tone", "grey"), "tile")
        delta = f'<div class="d" style="color:{VAR[tone]}">{ctx.text(t["delta"])}</div>' if t.get("delta") else ""
        out.append(
            f'<div class="tile"><div class="v">{ctx.text(str(_need(t, "value", "tiles")))}</div>'
            f'<div class="k">{ctx.text(_need(t, "key", "tiles"))}</div>{delta}</div>'
        )
    return '<div class="tiles">' + "".join(out) + "</div>"


def _bars(b, ctx):
    series = _need(b, "series", "bars")
    unit = b.get("unit", "")
    peak = max([abs(float(s["value"])) for s in series] + [1e-9])
    rowh, pad, labw, valw, w = 34, 6, 150, 78, 640
    barw = w - labw - valw
    parts = []
    for i, s in enumerate(series):
        y = i * rowh
        tone = _tone(s.get("tone", "blue"), "bars")
        length = max(2.0, abs(float(s["value"])) / peak * barw)
        parts.append(f'<text x="{labw - 10}" y="{y + rowh / 2 + 4}" text-anchor="end">{ctx.text(s["label"])}</text>')
        parts.append(
            f'<rect x="{labw}" y="{y + pad}" width="{length:.1f}" height="{rowh - 2 * pad}" '
            f'rx="2" fill="{VAR[tone]}"/>'
        )
        shown = ctx.text("{}{}".format(s["value"], unit))
        parts.append(f'<text class="vlab" x="{labw + length + 8:.1f}" y="{y + rowh / 2 + 4}">{shown}</text>')
    h = len(series) * rowh
    return (
        f'<svg class="chart" viewBox="0 0 {w} {h}" role="img" '
        f'aria-label="{ctx.text(b.get("alt", "bar comparison"))}">' + "".join(parts) + "</svg>"
    )


def _breakdown(b, ctx):
    parts = _need(b, "parts", "breakdown")
    unit = b.get("unit", "")
    total = sum(float(p["value"]) for p in parts) or 1.0
    w, h = 640, 34
    x, seg, legend = 0.0, [], []
    for p in parts:
        tone = _tone(p.get("tone", "blue"), "breakdown")
        width = float(p["value"]) / total * w
        seg.append(f'<rect x="{x:.1f}" y="0" width="{max(width, 1):.1f}" height="{h}" fill="{VAR[tone]}"/>')
        shown = ctx.text("{}{}".format(p["value"], unit))
        legend.append(f'<span><b style="background:{VAR[tone]}"></b>{ctx.text(p["label"])} {shown}</span>')
        x += width
    return (
        '<div class="chartwrap">'
        f'<svg class="chart" viewBox="0 0 {w} {h}" role="img" '
        f'aria-label="{ctx.text(b.get("alt", "breakdown"))}">' + "".join(seg) + "</svg>"
        '<div class="legend">' + "".join(legend) + "</div></div>"
    )


def _trend(b, ctx):
    lines = _need(b, "lines", "trend")
    xs = _need(b, "x", "trend")
    unit = b.get("unit", "")
    w, h, l, r, t, bot = 640, 240, 54, 14, 12, 34
    values = [float(v) for ln in lines for v in ln["values"]]
    if not values:
        raise ReportError("a trend block needs at least one value")
    lo, hi = min(values), max(values)
    if hi == lo:
        hi = lo + 1
    span = hi - lo

    def px(i):
        return l + (w - l - r) * (i / max(len(xs) - 1, 1))

    def py(v):
        return t + (h - t - bot) * (1 - (float(v) - lo) / span)

    parts, legend = [], []
    for k in range(4):
        y = t + (h - t - bot) * k / 3
        val = hi - span * k / 3
        parts.append(f'<line class="grid" x1="{l}" y1="{y:.1f}" x2="{w - r}" y2="{y:.1f}"/>')
        parts.append(f'<text x="{l - 8}" y="{y + 4:.1f}" text-anchor="end">{val:.4g}{ctx.text(unit)}</text>')
    for i, label in enumerate(xs):
        parts.append(f'<text x="{px(i):.1f}" y="{h - 10}" text-anchor="middle">{ctx.text(str(label))}</text>')
    for ln in lines:
        if len(ln["values"]) != len(xs):
            raise ReportError(f"trend line {ln.get('label')!r} has {len(ln['values'])} values for {len(xs)} steps")
        tone = _tone(ln.get("tone", "blue"), "trend")
        pts = " ".join(f"{px(i):.1f},{py(v):.1f}" for i, v in enumerate(ln["values"]))
        parts.append(f'<polyline fill="none" stroke="{VAR[tone]}" stroke-width="2.5" points="{pts}"/>')
        parts.append(
            f'<circle cx="{px(len(xs) - 1):.1f}" cy="{py(ln["values"][-1]):.1f}" r="4" fill="{VAR[tone]}"/>'
        )
        legend.append(f'<span><b style="background:{VAR[tone]}"></b>{ctx.text(ln["label"])}</span>')
    return (
        '<div class="chartwrap">'
        f'<svg class="chart" viewBox="0 0 {w} {h}" role="img" '
        f'aria-label="{ctx.text(b.get("alt", "trend"))}">' + "".join(parts) + "</svg>"
        '<div class="legend">' + "".join(legend) + "</div></div>"
    )


# ── images ───────────────────────────────────────────────────────────────────

def _figure(shot, ctx):
    src = ctx.image(shot)
    cap = f'<figcaption>{ctx.text(shot["caption"])}</figcaption>' if shot.get("caption") else ""
    alt = ctx.text(shot.get("caption", "report image"))
    return f'<figure><img src="{src}" alt="{alt}" loading="lazy">{cap}</figure>'


def _images(b, ctx):
    shots = _need(b, "shots", "images")
    cls = "shots two" if len(shots) == 2 else "shots"
    return f'<div class="{cls}">' + "".join(_figure(s, ctx) for s in shots) + "</div>"


def _compare(b, ctx):
    before, after = _need(b, "before", "compare"), _need(b, "after", "compare")
    before.setdefault("caption", "Before")
    after.setdefault("caption", "After")
    return (
        '<div class="shots two" data-pair>'
        + _figure(before, ctx) + _figure(after, ctx) + "</div>"
    )


def _wipe(b, ctx):
    before, after = _need(b, "before", "wipe"), _need(b, "after", "wipe")
    return (
        '<div class="wipe">'
        f'<img src="{ctx.image(after)}" alt="{ctx.text(after.get("caption", "after"))}">'
        f'<div class="top"><img src="{ctx.image(before)}" alt="{ctx.text(before.get("caption", "before"))}"></div>'
        '<div class="handle"></div>'
        f'<span class="tag l">{ctx.text(before.get("caption", "Before"))}</span>'
        f'<span class="tag r">{ctx.text(after.get("caption", "After"))}</span>'
        "</div>"
    )


SHELF = {
    "text": _text,
    "list": _list,
    "rows": _rows,
    "note": _note,
    "table": _table,
    "tiles": _tiles,
    "bars": _bars,
    "breakdown": _breakdown,
    "trend": _trend,
    "images": _images,
    "compare": _compare,
    "wipe": _wipe,
}

# Fields holding a machine value, never manager-facing prose. The jargon check
# and the markup check both skip these.
OPAQUE = {"kind", "tone", "align", "src", "path", "id", "url", "favicon", "ordered", "n"}


def render(block: dict, ctx) -> str:
    kind = block.get("kind")
    if kind not in SHELF:
        raise ReportError(
            f"no block called {kind!r}. The shelf holds: {', '.join(sorted(SHELF))}. "
            "A graphic nobody has built yet gets added to scripts/report/blocks.py "
            "so every future report has it — never hand-written into one page."
        )
    return SHELF[kind](block, ctx)
