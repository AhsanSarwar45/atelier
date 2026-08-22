# Packaging

This directory holds the package-manager sources used to distribute `atelier`.
Nothing here is built into the binary — these files feed the release automation in
[`.github/workflows/release.yml`](../.github/workflows/release.yml).

## `homebrew/`

- `atelier.rb.tmpl` — Homebrew formula template with `__VERSION__`, `__ARM_SHA__`,
  `__INTEL_SHA__`, and `__LINUX_SHA__` placeholders.

There is no rendered copy of it here, and there must not be one. A formula
checked in with a version and hashes already filled in can only be right for a
release that published under exactly these download names, and it goes silently
wrong the moment they change — which is what happened to the one that used to
sit here (bw-8um.3.15). The release run renders the template itself and pushes
the result to the tap, including the first time.

On each release the `Update Homebrew formula` step renders the template with the new
version and freshly computed SHA-256 hashes and pushes the result to
`ahsanswr/homebrew-atelier` as `Formula/atelier.rb`. Users then install with:

```
brew install ahsanswr/atelier/atelier
```

## Required repo secrets

- `HOMEBREW_TAP_TOKEN` — a personal access token with push rights to
  `ahsanswr/homebrew-atelier`. When absent, the Homebrew step no-ops.

Homebrew is the only package manager this project publishes to. Windows takes
the `.exe` straight from the release page.
