"""Whether a change left the codebase better or worse than it found it.

Six rules gate; everything else is reported and never blocks. Each rule and the
measurement its threshold came from is in `docs/code-quality.md`; nothing here
carries a number that was picked rather than derived.

`scripts/quality.py` is the command. This package is what it runs.
"""
