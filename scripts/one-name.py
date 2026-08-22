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
              nix output, the homebrew formula, the data folder the shell tool
              falls back to.

  ONE SPELLING  no tracked file carries an older spelling of the product name,
              except where an older spelling is the right answer and the reason
              is written down below.

  THE BUILT SCREEN  the page the program actually serves says the name in its
              browser tab, and carries no older spelling anywhere a reader can
              see it. Source that reads right and a build that reads wrong is
              exactly the failure a person meets first, so the built page is
              read rather than the file it came from (bw-8um.3.16).

  THE DOWNLOADS  every version and every download address a checked-in install
              manifest names is one a release really published under these
              names — or a placeholder the release run fills. A manifest
              carrying a version from before the rename sends anyone installing
              through a package manager at a file that is not there, and the
              spelling sweep cannot see it because the address it names is
              spelled correctly and simply does not exist (bw-8um.3.15).

  ONE ACCOUNT   every address of this product's own two repositories is under
              the one account it publishes from. The owner has more than one
              account and only one of them is his to publish under; an address
              under the other is spelled perfectly, points at a real place, and
              is still the wrong place (bw-8um.3.21).

## What is NOT the product name

Three things share the old spelling and are not it, so each is exempt by a
named rule rather than by being quietly skipped:

  where it came from    this is a fork, and the repository it was forked from
                        is named in the record. A fact about the past is not a
                        name the product still answers to.
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
        ("packaging/homebrew/%s.rb.tmpl" % name, "class %s < Formula" % name.capitalize(),
         "the homebrew formula"),
        ("packaging/homebrew/%s.rb.tmpl" % name, '=> "%s"' % name, "what homebrew installs"),
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
    (r"weselow/beads-web|Beads-Kanban-UI",
     "where this fork came from, which is a fact about the past"),
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


# ------------------------------------------------------- the downloads named

RELEASE_RUN = ".github/workflows/release.yml"

# The manifests a package manager reads, all of which name a download.
MANIFESTS = ("packaging/homebrew/",)

# A value the release run fills in.
FILLED_IN = re.compile(r"__[A-Z_]+__|\$\{[^}]+\}")

DOWNLOAD = re.compile(r"releases/download/([^/\s\"']+)/([^\s\"'\)]+)")
VERSION_FIELD = re.compile(
    r'^\s*(?:"version"\s*:\s*"|PackageVersion:\s*|version\s+")([^"\s]+)', re.M
)


def publishes(workflow_text):
    """The file names a release run really uploads."""
    return set(re.findall(r"artifact:\s*(\S+)", workflow_text))


def workflow_at(tag):
    """That same run as it stood at a tag, or None if the tag has none."""
    out = subprocess.run(["git", "show", "%s:%s" % (tag, RELEASE_RUN)], cwd=HERE,
                         capture_output=True, text=True, timeout=120)
    return out.stdout if out.returncode == 0 else None


def tags():
    out = subprocess.run(["git", "tag", "-l", "v*"], cwd=HERE, capture_output=True,
                         text=True, timeout=120)
    return set(out.stdout.split())


def downloads_named(files):
    """Every manifest promise that no release ever kept."""
    published_now = publishes(open(os.path.join(HERE, RELEASE_RUN), encoding="utf-8").read())
    published_at = {}
    known = tags()
    failures = []

    for path in files:
        if not path.startswith(MANIFESTS):
            continue
        try:
            text = open(os.path.join(HERE, path), encoding="utf-8").read()
        except (OSError, UnicodeDecodeError):
            continue

        for tag, filename in DOWNLOAD.findall(text):
            filename = filename.split("#", 1)[0]
            if FILLED_IN.search(tag):
                # The version is the release run's to write. The file name is
                # still ours, and still has to be one it uploads.
                if filename not in published_now:
                    failures.append("%s asks for %r, which no release publishes"
                                    % (path, filename))
                continue
            if tag not in known:
                failures.append("%s names release %s, which was never tagged, so the"
                                " download is not there" % (path, tag))
                continue
            if tag not in published_at:
                published_at[tag] = publishes(workflow_at(tag) or "")
            if filename not in published_at[tag]:
                failures.append("%s asks release %s for %r, which that release never"
                                " published" % (path, tag, filename))

        for version in VERSION_FIELD.findall(text):
            if FILLED_IN.search(version):
                continue
            tag = version if version.startswith("v") else "v" + version
            if tag not in known:
                failures.append("%s says it is version %s, which was never released"
                                % (path, version))

    return failures


# ------------------------------------------------------------- one account

# The account this product publishes from. Every address of its own two
# repositories is under this one; an address under any other account is not
# a spelling mistake and the spelling sweep cannot see it.
PUBLISHES_UNDER = "AhsanSarwar45"

# Its own two repositories — the product, and the tap that carries the formula —
# but only where the text is really an address. An account name followed by the
# product name is also the tail of a dozen ordinary file paths (a build output
# under `release`, the formula under `Formula`), so the account is only read
# where one of the ways an address is actually written comes first.
OWN_REPOS = re.compile(
    r"(?:github\.com/|github:|brew install |[`*])"
    r"(?P<owner>[A-Za-z0-9][A-Za-z0-9._-]*)"
    r"/(?P<repo>atelier|homebrew-atelier)\b(?!\.(?!git))"
)


def account_named(files):
    """Every address of our own repositories that is under another account."""
    failures = []
    for path in files:
        if path.endswith(SKIP_SUFFIX) or path.startswith(GENERATED):
            continue
        full = os.path.join(HERE, path)
        if not os.path.isfile(full):
            continue
        try:
            text = open(full, encoding="utf-8").read()
        except (UnicodeDecodeError, OSError):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            for found in OWN_REPOS.finditer(line):
                # `brew install <account>/atelier/atelier` names the tap by its
                # short form, so the account is what sits before `atelier`
                # either way and one rule covers both spellings.
                owner = found.group("owner")
                if owner != PUBLISHES_UNDER:
                    failures.append(
                        "%s:%d names %s/%s, which is not the account this publishes"
                        " from (%s): %s" % (path, number, owner, found.group("repo"),
                                            PUBLISHES_UNDER, line.strip()))
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
    failures.extend(downloads_named(files))
    failures.extend(account_named(files))

    print("the product is named %r, read as %r, defined in %s" % (name, display, IDENTITY))
    print("%d places must agree, %d tracked files swept, and %d built pages read as the"
          " reader meets them; every download a manifest names checked against the"
          " releases that exist, and every address of its own repositories against"
          " the one account %s publishes from"
          % (len(agreements(name)), len(files), len(LANDED_ON), PUBLISHES_UNDER))
    for line in failures:
        print("  FAIL " + line)
    print("%d failures" % len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
