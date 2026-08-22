# Release Process

How to cut a release of **Atelier** and where the built binaries are
published. Most of the pipeline is automated by GitHub Actions; the manual parts
are called out explicitly.

## Overview

Atelier ships as a single self-contained binary per platform — the frontend is
embedded into the Rust binary via `rust-embed`. One tag push fans out to every
distribution channel.

| Channel | Where copies live | Updated by | One-time setup |
|---------|-------------------|-----------|----------------|
| GitHub Releases | `AhsanSarwar45/atelier` → Releases | `release.yml` (automatic) | — |
| Nix (macOS/Linux/WSL) | `flake.nix` (this repo) | `ci.yml` refreshes deps hash; version is manual | — |
| Homebrew (macOS/Linux) | `Formula/atelier.rb` in `AhsanSarwar45/homebrew-atelier` | `release.yml` (automatic) | tap repo + `HOMEBREW_TAP_TOKEN` |

## Cutting a release

### 1. Bump the version

The version lives in four files that are **not** auto-synced. Update all of
them to the new version (e.g. `0.12.0`):

- `package.json` → `"version"`
- `server/Cargo.toml` → `version`
- `server/Cargo.lock` → `version` in the `[[package]] name = "atelier"` block
- `flake.nix` → **both** `version = "…"` lines (the frontend package and the default package)

> `Cargo.lock` is easy to miss and easy to get wrong. The Nix build reads it
> (`cargoLock.lockFile = ./server/Cargo.lock`), so a stale version there breaks
> `nix build` even though `cargo` itself would silently repair it. Do **not**
> blind-replace the old version string in that file — unrelated dependencies can
> sit at the same version number (at 0.11.2 the crate `zerovec-derive` did).
> Anchor on the `name = "atelier"` line.

The Homebrew formula is rendered automatically from the git tag — do **not**
hand-edit it.

Commit the bump to `main`.

> Pushing to `main` triggers `ci.yml`, which may auto-commit a refreshed
> `npmDepsHash` into `flake.nix` if dependencies changed. Pull that commit before
> you tag.

### 2. Tag and push

```bash
git tag v0.12.0
git push origin v0.12.0
```

Or run the **Release** workflow manually: *Actions → Release → Run workflow*,
entering the version (e.g. `v0.12.0`).

### 3. What runs automatically

`.github/workflows/release.yml`:

1. **build** job — for each of macOS arm64, macOS x64, Linux x64, Windows x64:
   `npm ci` → `npm run build` (static export → `out/`) → `cargo build --release`
   → upload the binary as an artifact.
2. **release** job (Ubuntu):
   - downloads all four binaries,
   - generates `SHA256SUMS.txt`,
   - creates the GitHub Release (binaries + checksums + auto-generated notes),
   - renders the Homebrew formula from `packaging/homebrew/atelier.rb.tmpl` and
     pushes it to the tap repo (skipped if `HOMEBREW_TAP_TOKEN` is unset).

Homebrew is the only package manager this project publishes to. Windows users
take `atelier-win-x64.exe` straight from the release page.

Separately, `.github/workflows/ci.yml` runs on every push to `main` and keeps the
Nix `npmDepsHash` current, auto-committing the refreshed hash when it drifts.

### 4. After the release

- Confirm the GitHub Release has all four binaries + `SHA256SUMS.txt`.
- Homebrew: `brew update && brew upgrade atelier`.

## Required repository secrets

Set under *AhsanSarwar45/atelier → Settings → Secrets and variables → Actions*:

| Secret | Purpose | How to create |
|--------|---------|---------------|
| `GITHUB_TOKEN` | built-in; release + Nix commits | automatic |
| `HOMEBREW_TAP_TOKEN` | push the formula to `AhsanSarwar45/homebrew-atelier` | fine-grained PAT, that repo only, **Contents: read/write** |

The Homebrew step no-ops cleanly when its token is absent.

## One-time setup (not yet done)

This is a fork, so everything it publishes to had to be made fresh. It all
lives under the personal account `AhsanSarwar45`, never a work one — the
addresses below are the only ones this project publishes to, and
`scripts/one-name.py` fails the build if a different account appears anywhere.
Before the first tag:

- Create `AhsanSarwar45/atelier` on GitHub and add it as the `origin` remote.
- Create the tap repo `AhsanSarwar45/homebrew-atelier`. It can be empty; the release
  run writes `Formula/atelier.rb` into it.
- Add the `HOMEBREW_TAP_TOKEN` secret to `AhsanSarwar45/atelier`.
- The login that pushes needs the `workflow` right, or GitHub refuses any push
  that carries `.github/workflows/release.yml`: `gh auth refresh -s workflow`.

Until the tap token is set the Homebrew step no-ops, so the first tag still
publishes binaries and checksums — just no formula.

## Known gaps

- **No test/lint CI on push or PR.** Nothing runs `vitest`, `cargo test`,
  `clippy`, `tsc`, or `eslint` automatically, so a regression can merge — or ship
  in a release — undetected. Until that is added, run `npm run lint`,
  `npm run typecheck`, `npm run test`, and (in `server/`) `cargo test --lib`
  locally before tagging. On Windows `cargo test` (full) hangs because the
  `memory_bd` integration test starts Dolt — use `cargo test --lib`.
- **Version duplication.** The version is repeated in `package.json`,
  `server/Cargo.toml`, `server/Cargo.lock`, and `flake.nix` (twice) with no
  automated consistency check.
