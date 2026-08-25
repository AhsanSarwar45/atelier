#!/usr/bin/env python3
"""Score replies on Biber's (1988) Dimension 1, Involved vs Informational Production.

Not a metric we invented. Biber measured 67 things about hundreds of real
recorded conversations and real written documents and found, statistically, the
one axis that separates talking from writing. Published reference points:

    Intimate interpersonal interaction   +45   (friends talking)
    Informational interaction            +30   (business-like talking)
    Imaginative narrative / persuasion    +5
    Situated reportage                     0
    General narrative exposition         -10
    Scientific exposition                -15
    Learned exposition                   -20   (academic writing)

Feature counts come from pybiber, which implements Biber's 67 features.
The norms, the formula and the reference points come out of Nini's
Multidimensional Analysis Tagger, and are stored verbatim in biber-1988.json.

Biber's norms are per 100 words; pybiber normalises per 1000, hence the /10.
MAT zeroes the type-token term for any text under 400 tokens because a short
text's ratio is not comparable. We keep that rule and report when it fires.

    style-score.py <file-or-dir> [more...] [--words N]

Every text is cut to the same word count before scoring, the shortest in the set
unless --words says otherwise. Without that, a style that happens to write more
keeps the type-token term that a shorter one had zeroed, and the number compares
lengths rather than styles.
"""
import json, sys, os
from pathlib import Path

# pybiber and spaCy live in their own environment, built once, kept outside any
# session scratchpad so it survives. Re-exec into it if we are not already there.
def _bootstrap():
    import subprocess, sys, os
    from pathlib import Path
    try:
        import pybiber  # noqa: F401
        return
    except ImportError:
        pass
    env = Path(os.path.expanduser("~/.cache/atelier/biberenv"))
    py = env / "bin" / "python"
    if not py.exists():
        print(f"building the Biber environment at {env} (once, a few minutes)", file=sys.stderr)
        subprocess.run([sys.executable, "-m", "venv", str(env)], check=True)
        subprocess.run([str(py), "-m", "pip", "install", "-q", "pybiber"], check=True)
        subprocess.run([str(py), "-m", "spacy", "download", "en_core_web_sm"], check=True)
    os.execv(str(py), [str(py), os.path.abspath(__file__)] + sys.argv[1:])



HERE = Path(__file__).resolve().parent
B = json.load(open(HERE / "biber-1988.json"))

# Biber's tag names, as MAT writes them, against pybiber's column for the same feature.
TAG = {
    "PRIV": "f_56_verb_private",      "THATD": "f_60_that_deletion",
    "CONT": "f_59_contractions",      "VPRT": "f_03_present_tense",
    "SPP2": "f_07_second_person_pronouns", "PROD": "f_12_proverb_do",
    "XX0": "f_67_neg_analytic",       "DEMP": "f_10_demonstrative_pronoun",
    "EMPH": "f_49_emphatics",         "FPP1": "f_06_first_person_pronouns",
    "PIT": "f_09_pronoun_it",         "BEMA": "f_19_be_main_verb",
    "CAUS": "f_35_because",           "DPAR": "f_50_discourse_particles",
    "INPR": "f_11_indefinite_pronouns", "AMP": "f_48_amplifiers",
    "POMD": "f_52_modal_possibility", "ANDC": "f_65_clausal_coordination",
    "STPR": "f_61_stranded_preposition",
    "NN": "f_16_other_nouns",         "AWL": "f_44_mean_word_length",
    "PIN": "f_39_prepositions",       "TTR": "f_43_type_token",
    "JJ": "f_40_adj_attr",
}
UNNORMALISED = {"AWL", "TTR"}   # pybiber leaves these two alone


def biber_ttr(text):
    """Biber counts type-token over the FIRST 400 words only, so that a long
    text is not punished for repeating itself. pybiber uses the whole text,
    which would put a 400-word reply and a 3000-word transcript on different
    scales. Returns None for a text too short to compare."""
    w = [t.lower() for t in text.split()][:400]
    return None if len(w) < 400 else 100.0 * len(set(w)) / len(w)


def score(rows, text):
    """rows: {pybiber column -> value}. Returns (D1, z, notes)."""
    ttr = biber_ttr(text)
    z, notes = {}, []
    for tag, col in TAG.items():
        v = rows[col]
        if tag not in UNNORMALISED:
            v = v / 10.0                      # per 1000 tokens -> per 100 words
        if tag == "TTR":
            if ttr is None:                   # MAT's own rule for short texts
                z[tag] = 0.0
                notes.append("type-token term zeroed, text under 400 words")
                continue
            v = ttr                           # Biber's first-400-words ratio
        z[tag] = (v - B["biber_means"][tag]) / B["biber_sds"][tag]
    d1 = sum(z[t] for t in B["dimension_1"]["positive"]) - \
         sum(z[t] for t in B["dimension_1"]["negative"])
    return d1, z, notes


def nearest(d1):
    return min(B["text_type_d1_centroids"].items(), key=lambda kv: abs(kv[1] - d1))


def main(paths, words=None):
    import polars as pl, spacy, pybiber as pb
    docs = []
    for p in paths:
        p = Path(p)
        for f in (sorted(p.glob("*")) if p.is_dir() else [p]):
            if f.is_file():
                docs.append((f.stem, f.read_text(errors="replace")))
    cut = words or min(len(t.split()) for _, t in docs)
    docs = [(d, " ".join(t.split()[:cut])) for d, t in docs]
    nlp = spacy.load("en_core_web_sm")
    df = pl.DataFrame({"doc_id": [d for d, _ in docs], "text": [t for _, t in docs]})
    feats = pb.biber(pb.CorpusProcessor().process_corpus(df, nlp)).to_dicts()
    by_id = {r["doc_id"]: r for r in feats}

    print(f"\n  every text cut to {cut} words so the numbers compare")
    print(f"\n{'text':28} {'words':>6} {'Biber D1':>9}   closest published register")
    print(f"{'':28} {'':>6} {'':>9}   (+45 friends talking, +30 business talk, -20 academic)")
    for doc_id, text in docs:
        n = len(text.split())
        d1, _, notes = score(by_id[doc_id], text)
        name, centre = nearest(d1)
        print(f"{doc_id[:28]:28} {n:6d} {d1:9.1f}   {name} ({centre:+.0f})")
        for note in dict.fromkeys(notes):
            print(f"{'':28} {'':>6} {'':>9}   note: {note}")
    print()


if __name__ == "__main__":
    _bootstrap()
    argv = sys.argv[1:]
    n = None
    if "--words" in argv:
        i = argv.index("--words")
        n = int(argv[i + 1])
        argv = argv[:i] + argv[i + 2:]
    main(argv or ["."], n)
