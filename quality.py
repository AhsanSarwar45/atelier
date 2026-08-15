#!/usr/bin/env python3
"""Whether a change left the codebase better or worse than it found it.

    scripts/quality.py                 the rules against the working tree
    scripts/quality.py --at <ref>      the same, against an earlier commit
    scripts/quality.py --against <ref> both, and the difference between them
    scripts/quality.py --json          the numbers, for another tool to read

Exit 1 means a rule refused something. `--against` exits 1 only for a place
refused now and not before, named by file and by rule: a run already red stays
red, and this says whether THIS change is what made it so.

The rules, and the measurement each threshold came from, are in
`docs/code-quality.md`.
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))

from quality import changed  # noqa: E402
from quality.baseline import Extracted  # noqa: E402
from quality.corpus import Corpus  # noqa: E402
from quality.registry import MEASURES, Result, Scope, run_all  # noqa: E402
from repo import root as repo_root  # noqa: E402
import project  # noqa: E402

import quality.trends  # noqa: E402,F401  (importing is what registers a measure)
from quality.drift import pairs as drift_pairs  # noqa: E402


def load_rules(root: str) -> None:
    """This project's own measures, imported by filename after the shared ones
    so import order — which fixes report order — always prints them last.

    A project's rules live outside the `quality` package under their own bare
    names, the same names a rule-directory tool such as a calibrator or a
    self-test imports its companions by; loading each under that same name,
    and skipping one such a tool has already pulled in, means either order —
    this loop first, or the tool first — registers a measure exactly once.
    """
    decl = project.of(root)
    if not decl.rules:
        print("quality: %s declares no rules directory; running with the shared "
              "measures only" % decl.name, file=sys.stderr)
        return
    for path in sorted(glob.glob(os.path.join(root, decl.rules, "*.py"))):
        name = os.path.splitext(os.path.basename(path))[0]
        if name in sys.modules:
            continue
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)


load_rules(repo_root())


def collect(root: str, since: str | None = None) -> dict[str, Result]:
    if not since:
        return run_all(Scope(Corpus(root), root))
    with Extracted(root, since) as before:
        return run_all(Scope(Corpus(root), root, since, Corpus(before)))


def numbers(results: dict[str, Result]) -> dict[str, float]:
    out: dict[str, float] = {}
    for rid, res in results.items():
        for key, value in res.numbers.items():
            out[f"{rid}.{key}"] = value
    return out


def refusals(results: dict[str, Result]) -> list[tuple[str, str, str]]:
    gating = {m.id for m in MEASURES if m.gates}
    return [(rid, r.where, r.says)
            for rid, res in results.items() if rid in gating
            for r in res.refusals]


def report(results: dict[str, Result], where: str) -> int:
    bad = refusals(results)
    for m in MEASURES:
        res = results[m.id]
        head = m.title if m.gates else f"{m.title} (reported only)"
        print(f"\n── {head}")
        for key, value in sorted(res.numbers.items()):
            print(f"   {key:<34} {value:>12,}")
        for row in res.listing:
            print(f"   {row}")
    if bad:
        print(f"\n{len(bad)} refusal(s) in {where}:")
        for rid, at, says in bad:
            print(f"  [{rid}] {at}: {says}")
        return 1
    print(f"\nnothing refused in {where}")
    return 0


def compare(before: dict[str, Result], after: dict[str, Result], sha: str) -> int:
    """What this change moved, and where.

    Only a place refused now and not before decides the exit: a run already red
    stays red, and a number moving on its own says how big the tree is rather than
    how bad it is. Which way each rule counts is the rule's own business, and it
    says so by refusing.
    """
    was_all, now_all = numbers(before), numbers(after)
    print(f"\n── against {sha[:8]}")
    # A number only one side could answer is not a movement. Some of these say what
    # a change did, and an earlier point of the tree has no change to be asked about.
    silent = sorted(set(was_all) ^ set(now_all))
    for key in sorted(set(was_all) & set(now_all)):
        was, now = was_all[key], now_all[key]
        if was != now:
            print(f"   {key:<34} {was:>12,} -> {now:>12,}  {now - was:>+10,}")
    for key in silent:
        print(f"   {key:<34} {'not readable at both points':>38}")

    # Recognised by rule and file, never by the sentence: a rule that writes a size
    # into its words would otherwise report the same standing refusal as fresh every
    # time that size moved. The price is that a second refusal from the same rule in
    # an already-refused file is not called out — `docs/code-quality.md#9-debt`.
    stood = {(rid, at.split(":")[0]) for rid, at, _ in refusals(before)}
    fresh = [r for r in refusals(after) if (r[0], r[1].split(":")[0]) not in stood]
    if fresh:
        print(f"\n{len(fresh)} place(s) refused now and not at {sha[:8]}:")
        for rid, at, says in fresh:
            print(f"  [{rid}] {at}: {says}")
        return 1
    print(f"\nno rule this change made worse")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--at", metavar="REF", help="measure this commit instead of the working tree")
    ap.add_argument("--against", metavar="REF", help="measure both and print the difference")
    ap.add_argument("--json", action="store_true", help="print the numbers and nothing else")
    ap.add_argument("--list-drift", action="store_true",
                    help="every pair of copies that has drifted, most alike first")
    ap.add_argument("--top", type=int, default=40, metavar="N",
                    help="how many rows a listing prints; 0 for all")
    ap.add_argument("--only", metavar="PATH", help="listing rows touching this path")
    ap.add_argument("--since", metavar="REF",
                    help="what counts as this change; default is where this branch left main")
    args = ap.parse_args()

    root = repo_root()

    if args.list_drift:
        ranked, counted = drift_pairs(Corpus(root))
        kept = [(n, p) for n, p in enumerate(ranked, 1)
                if not args.only or args.only in p.left.path or args.only in p.right.path]
        shown = kept if args.top == 0 else kept[:args.top]
        for rank, pair in shown:
            print(f"{rank:>5}. {pair}")
        print(f"\n{len(ranked)} pairs of copies disagree, most alike first; "
              f"{len(shown)} shown" + (f" of {len(kept)} matching --only" if args.only else "")
              + f". {counted['crowded']} fingerprints were too common to pair.")
        return 0

    if args.at:
        asked = Extracted(root, args.at)
        with asked as where:
            results = collect(where)
        label = f"{args.at} ({asked.sha[:8]})"
    else:
        # What a change is measured from is what was asked for. Judging against the
        # merge-base whatever `--against` says makes a worsening that is already
        # committed compare the tree with itself and read as clean.
        since = args.since or args.against or changed.base(root)
        results = collect(root, since)
        label = "the working tree"

    if args.against:
        earlier = Extracted(root, args.against)
        with earlier as where:
            before = collect(where)
        if args.json:
            print(json.dumps({"before": numbers(before), "after": numbers(results)},
                             indent=2, sort_keys=True))
            return 0
        report(results, label)
        return compare(before, results, earlier.sha)

    if args.json:
        print(json.dumps(numbers(results), indent=2, sort_keys=True))
        return 0
    return report(results, label)


if __name__ == "__main__":
    sys.exit(main())
