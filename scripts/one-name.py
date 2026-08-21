#!/usr/bin/env python3
"""The product answers to ONE name, and that name is defined in one place.

A rename that only reaches the places somebody remembered leaves the product
answering to two names: the binary is called one thing, the folder its data
lives in another, and the install command a third. Every one of those is a
person typing the name they read and getting nothing (bw-8um.3.8).

So the name is not written down here. It is READ from the one place that
defines it — `server/src/identity.rs` — and every other spelling of it is
derived and then looked for. A rename is finished when this reports nothing:
change the one constant, run this, and it names every file still on the old
name.

Three halves, and all of them have to hold:

  AGREEMENT   every place that must carry the name carries the derived
              spelling — the cargo package, the binary, the npm package, the
              nix output, the scoop manifest, the homebrew formula, the winget
              package, the data folder the shell tool falls back to.

  ONE SPELLING  no tracked file carries an older spelling of the product name,
              except where an older spelling is the right answer and the reason
              is written down below.

  THE BUILT SCREEN  the page the program actually serves says the name in its
              browser tab, and carries no older spelling anywhere a reader can
              see it. Source that reads right and a build that reads wrong is
              exactly the failure a person meets first, so the built page is
              read rather than the file it came from (bw-8um.3.16).

## What is NOT the product name

Three things share the old spelling and are not it, so each is exempt by a
named rule rather than by being quietly skipped:

  the repository        `github.com/weselow/beads-web` is an address. Renaming
                        the product does not move a repository, and an address
                        that has moved is a redirect, not a rename.
  the checkout          the folder on disk and the project's name on the board
                        and in report paths. The project is not the product.
  what came before      the earlier data folder, the earlier switch names and
                        the earlier binary name, all still answered to on
                        purpose so an existing install keeps working.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
IDENTITY = os.path.join("server", "src", "identity.rs")


def defined_name():
    """The one value the whole product is named from."""
    text = open(os.path.join(HERE, IDENTITY), encoding="utf-8").read()
    found = re.search(r'pub const NAME: &str = "([^"]+)";', text)
    if not found:
        sys.exit("%s defines no NAME, so there is nothing to check against" % IDENTITY)
    return found.group(1)


def defined_display():
    """The same name as a person reads it, in a tab or a sentence."""
    text = open(os.path.join(HERE, IDENTITY), encoding="utf-8").read()
    found = re.search(r'pub const DISPLAY: &str = "([^"]+)";', text)
    if not found:
        sys.exit("%s defines no DISPLAY, so the screens have no name to carry" % IDENTITY)
    return found.group(1)


def tracked():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=HERE, capture_output=True,
                         text=True, timeout=120)
    return [p for p in out.stdout.split("\0") if p]


# ---------------------------------------------------------------- agreement

def agreements(name):
    """(file, the string it must carry, what it is) — every one derived."""
    return [
        ("server/Cargo.toml", 'name = "%s"' % name, "the cargo package"),
        ("server/Cargo.toml", 'name = "%s"\npath = "src/main.rs"' % name, "the binary"),
        ("package.json", '"name": "%s"' % name, "the npm package"),
        ("flake.nix", 'pname = "%s";' % name, "the nix package"),
        ("flake.nix", 'mainProgram = "%s";' % name, "what nix runs"),
        ("flake.nix", '"$out/bin/%s"' % name, "where nix installs it"),
        ("bucket/%s.json" % name, '"bin": "%s.exe"' % name, "what scoop puts on the path"),
        ("packaging/homebrew/%s.rb.tmpl" % name, "class %s < Formula" % name.capitalize(),
         "the homebrew formula"),
        ("packaging/homebrew/%s.rb.tmpl" % name, '=> "%s"' % name, "what homebrew installs"),
        ("packaging/winget/weselow.%s.yaml" % name, "PackageIdentifier: weselow.%s" % name,
         "the winget package"),
        ("reporting/bin/report", "for exe in %s " % name, "the program the report tool asks"),
        ("reporting/bin/report", "com.weselow.%s" % name, "the mac data folder"),
        ("reporting/bin/report", "weselow/%s/data" % name, "the windows data folder"),
        ("reporting/bin/report", "}/%s\"" % name, "the linux data folder"),
        (".github/workflows/release.yml", "%s-win-x64.exe" % name, "the windows download"),
        (".github/workflows/release.yml", "%s-darwin-arm64" % name, "the mac download"),
        (".github/workflows/release.yml", "%s-linux-x64" % name, "the linux download"),
    ]


# ------------------------------------------------------------- one spelling

# Every spelling this product has answered to before now.
EARLIER = re.compile(
    r"beads[-_ ]web|BeadsWeb|BEADS[-_ ]WEB|beads-server|beads_server"
    r"|beads-kanban-ui|kanban[-_]ui|Beads Kanban UI",
    re.I,
)

# A line matching one of these carries an older spelling for a reason, and the
# reason is the second half. Ordered most specific first so a refusal names the
# narrowest rule that covers it.
ALLOWED = [
    (r"github\.com[:/]weselow/(beads-web|homebrew-beads-web)|github:weselow/beads-web"
     r"|weselow/homebrew-beads-web|homebrew-beads-web",
     "the repository address"),
    (r'GITHUB_REPO|weselow/beads-web(/|"|`|\s|$)', "the repository address"),
    (r"beads-web(-checks)?[/'\"`]|[/'\"(=]beads-web|cd beads-web|dev/beads-web"
     r'|"Beads Web"|beads-web = ', "the checkout, or the project's name on the board"),
    (r"beads-web-[0-9a-z]{2,}|beads-kanban-ui-[0-9a-z]+|bd-beads-web-",
     "a card id, not the product"),
    (r"BEADS_WEB_(HOST|PORT|OPEN_BROWSER)|BEADS_WORKBENCH",
     "an earlier switch name, still answered to"),
    (r"for exe in \S+ beads-web", "the earlier binary, still answered to"),
    (r'EARLIER|com\.beads\.kanban-ui|"beads", "kanban-ui"|_app_home\("kanban-ui"'
     r'|earlier = _app_home', "the earlier data folder, migrated from"),
    (r"not\.toContain\(.kanban-ui.\)",
     "the earlier data folder, named to prove it is not used"),
    (r"the Beads Web project", "the project's own persona on the board"),
    (r"AvivK5498/Beads-Kanban-UI|\[Beads-Kanban-UI\]",
     "the project this one was forked from"),
    (r"beads-web repository|Cloning beads-web", "the repository, named in prose"),
]

# Whole files that are a record of what happened rather than a description of
# what the product is now. Rewriting them would be rewriting history.
RECORD = ("docs/changelog.md", "docs/designs/")

# Files nobody wrote by hand, regenerated from the ones that were.
GENERATED = ("package-lock.json", "server/Cargo.lock", "docs/designs/templates/")

SKIP_SUFFIX = (".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf", ".woff", ".woff2")


def exempt(line):
    for pattern, why in ALLOWED:
        if re.search(pattern, line):
            return why
    return None


def spellings(name, files):
    """Every line still on an older name, with nothing to excuse it."""
    bad = []
    for path in files:
        if path == IDENTITY.replace(os.sep, "/") or path == "scripts/one-name.py":
            continue  # the one that defines the name, and the one that checks it
        if path.startswith(RECORD) or path.startswith(GENERATED):
            continue
        if path.endswith(SKIP_SUFFIX):
            continue
        full = os.path.join(HERE, path)
        try:
            text = open(full, encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if not EARLIER.search(line):
                continue
            if exempt(line):
                continue
            bad.append((path, number, line.strip()[:110]))
    return bad


# ---------------------------------------------------------- the built screen

# The pages as the program serves them. Not tracked — they are the build's
# output — so they are read on their own rather than swept with the rest.
BUILT = "out"

# The pages a reader actually lands on, each of which titles their browser tab.
# `404.html` is left out: the framework writes its own title into it.
LANDED_ON = ("index.html", "project.html", "settings.html")


def built_screen(display):
    """What the reader's browser tab says, read off the pages really served."""
    root = os.path.join(HERE, BUILT)
    if not os.path.isdir(root):
        return ["%s/ is not there, so what the browser tab says was never checked"
                " — run `npm run build` first" % BUILT]

    failures = []
    for page in LANDED_ON:
        full = os.path.join(root, page)
        if not os.path.exists(full):
            failures.append("%s/%s was not built, so a reader landing there gets"
                            " no name in the tab" % (BUILT, page))
            continue
        text = open(full, encoding="utf-8").read()
        found = re.search(r"<title[^>]*>(.*?)</title>", text, re.S)
        if not found:
            failures.append("%s/%s carries no title, so the browser tab falls back"
                            " to the address" % (BUILT, page))
        elif found.group(1).strip() != display:
            failures.append("%s/%s titles the browser tab %r, not %r"
                            % (BUILT, page, found.group(1).strip(), display))

    for page in sorted(os.listdir(root)):
        if not page.endswith(".html"):
            continue
        text = open(os.path.join(root, page), encoding="utf-8").read()
        for number, line in enumerate(text.splitlines(), 1):
            if EARLIER.search(line) and not exempt(line):
                failures.append("%s/%s:%d still on an older name: %s"
                                % (BUILT, page, number, line.strip()[:110]))

    return failures


def main():
    name = defined_name()
    display = defined_display()
    files = tracked()
    failures = []

    for path, wanted, what in agreements(name):
        full = os.path.join(HERE, path)
        if not os.path.exists(full):
            failures.append("%s is missing, so %s cannot carry the name" % (path, what))
            continue
        text = open(full, encoding="utf-8").read()
        flat = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
        if wanted not in text and wanted not in flat:
            failures.append("%s does not name %s as %r" % (path, what, wanted))

    for path, number, line in spellings(name, files):
        failures.append("%s:%d still on an older name: %s" % (path, number, line))

    failures.extend(built_screen(display))

    print("the product is named %r, read as %r, defined in %s" % (name, display, IDENTITY))
    print("%d places must agree, %d tracked files swept, and %d built pages read as the"
          " reader meets them" % (len(agreements(name)), len(files), len(LANDED_ON)))
    for line in failures:
        print("  FAIL " + line)
    print("%d failures" % len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
