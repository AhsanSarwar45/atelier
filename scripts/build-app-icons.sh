#!/usr/bin/env bash
# Every raster the app's mark is needed as, built from `public/icon.svg`.
#
# The PNGs are committed, because a phone asks for them before anything in
# this repository has had a chance to run, and because the two tools below are
# system packages that an install is not entitled to assume. Run this after
# editing the mark; `git status` says whether it changed anything.
set -euo pipefail

cd "$(dirname "$0")/.."
src=public/icon.svg
bg='#09090b'   # the same background_color the manifest names
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

need() { command -v "$1" >/dev/null || { echo "$0 needs $1"; exit 1; }; }
need rsvg-convert
need magick

# The rounded panel and its hairline are the icon's own frame. A full-bleed
# render has to drop them, or the platform's rounding cuts a second, smaller
# box out of the middle of the first. They are tagged in the source so this
# is one grep rather than a guess about which rect is which.
grep -v 'data-frame' "$src" > "$tmp/mark.svg"

# Plain icons keep the frame and stay transparent outside its corners.
rsvg-convert -w 192 "$src" -o public/icon-192.png
rsvg-convert -w 512 "$src" -o public/icon-512.png

# A maskable icon is cropped by the platform to a circle 80% of its width, so
# the mark is drawn at 62% on a full-bleed square and every part of it lands
# inside that circle whatever shape the launcher cuts.
rsvg-convert -w 318 "$tmp/mark.svg" -o "$tmp/inner.png"
magick -size 512x512 "xc:$bg" "$tmp/inner.png" -gravity center -composite \
  -depth 8 -alpha off public/icon-maskable-512.png

# iOS rounds the corners itself and refuses transparency, so this one is
# flattened and full-bleed at the size Safari asks for.
rsvg-convert -w 156 "$tmp/mark.svg" -o "$tmp/apple.png"
magick -size 180x180 "xc:$bg" "$tmp/apple.png" -gravity center -composite \
  -depth 8 -alpha off public/apple-touch-icon.png

# The repository's own logo slot, used by a README or a listing rather than
# by the running app. It carries the frame, like the plain icons do.
rsvg-convert -w 1024 "$src" -o logo/logo.png

echo "built: $(cd public && ls icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png) logo/logo.png"
