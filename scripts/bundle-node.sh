#!/usr/bin/env bash
#
# Assemble one release archive: the atelier program with a checked Node runtime
# laid down right beside it, so the machine that unpacks the archive needs no
# Node of its own for the Chat tab (bw-oesd.2). The program finds this Node by
# its own location -- a sibling file, or one folder over in `libexec` -- so the
# only contract this script has to keep is "node lands next to atelier".
#
#   bundle-node.sh --target <rust-triple> --binary <path/to/atelier> \
#                  --out <path/to/archive.tar.gz>
#   bundle-node.sh --self-test
#
# `--self-test` bundles for THIS machine with a stub program, unpacks the
# archive, and checks the Node it carries reports the pinned version -- the one
# thing a build machine cannot lie about and still ship a working chat.
#
# Windows is bundled by the workflow itself (a .zip, in PowerShell); this script
# is the three Unix platforms and the self-test.
set -euo pipefail

# The one runtime this release carries. Kept here as the single source the
# workflow, the formula, and the flake are all read against.
NODE_VERSION="v24.20.0"
DIST="https://nodejs.org/dist/${NODE_VERSION}"

die() { printf 'bundle-node: %s\n' "$*" >&2; exit 1; }

# Everything this run writes goes under one directory, swept on the way out.
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
scratch() { mktemp -d -p "$TMPROOT"; }

# The Node distribution that matches a Rust target triple: the dist platform
# name, and the path the `node` program sits at inside that distribution.
node_dist_for() {
  case "$1" in
    aarch64-apple-darwin)      echo "darwin-arm64 bin/node" ;;
    x86_64-apple-darwin)       echo "darwin-x64 bin/node" ;;
    x86_64-unknown-linux-gnu)  echo "linux-x64 bin/node" ;;
    aarch64-unknown-linux-gnu) echo "linux-arm64 bin/node" ;;
    *) return 1 ;;
  esac
}

# The Rust target of the machine running this script, for --self-test.
host_target() {
  local m; m="$(uname -m)"
  case "$(uname -s)" in
    Linux)  case "$m" in x86_64) echo x86_64-unknown-linux-gnu ;; aarch64|arm64) echo aarch64-unknown-linux-gnu ;; *) return 1 ;; esac ;;
    Darwin) case "$m" in arm64) echo aarch64-apple-darwin ;; x86_64) echo x86_64-apple-darwin ;; *) return 1 ;; esac ;;
    *) return 1 ;;
  esac
}

# Download the matching Node distribution, prove it against Node's own published
# fingerprint, and print the path to the extracted `node` program.
fetch_checked_node() {
  local target="$1" into="$2" dist node_at platform tarball
  read -r platform node_at < <(node_dist_for "$target") \
    || die "no Node distribution is known for target $target"
  tarball="node-${NODE_VERSION}-${platform}.tar.gz"

  curl -fsSL "${DIST}/${tarball}" -o "${into}/${tarball}" \
    || die "could not download ${tarball} from ${DIST}"
  curl -fsSL "${DIST}/SHASUMS256.txt" -o "${into}/SHASUMS256.txt" \
    || die "could not download the Node fingerprints from ${DIST}"

  # Node's SHASUMS256.txt is "<sha256>  <file>"; keep only the line for ours and
  # let sha256sum refuse a tarball that is not byte-for-byte the published one.
  ( cd "$into" && grep "  ${tarball}\$" SHASUMS256.txt | sha256sum -c - >/dev/null ) \
    || die "the downloaded ${tarball} does not match Node's published fingerprint"

  tar -xzf "${into}/${tarball}" -C "$into" \
    || die "could not unpack ${tarball}"
  local node="${into}/node-${NODE_VERSION}-${platform}/${node_at}"
  [ -x "$node" ] || die "no runnable node at $node after unpacking"
  printf '%s' "$node"
}

# Lay the program and the checked node down side by side and tar them up.
build_archive() {
  local target="$1" binary="$2" out="$3"
  [ -f "$binary" ] || die "no program to bundle at $binary"
  local work stage node
  work="$(scratch)"
  stage="$work/stage"; mkdir -p "$stage"

  node="$(fetch_checked_node "$target" "$work")"
  install -m755 "$binary" "$stage/atelier"
  install -m755 "$node" "$stage/node"

  mkdir -p "$(dirname "$out")"
  tar -czf "$out" -C "$stage" atelier node \
    || die "could not write the archive $out"
  printf 'bundle-node: wrote %s (atelier + node %s)\n' "$out" "$NODE_VERSION" >&2
}

self_test() {
  local target work stub out unpack
  target="$(host_target)" || die "this machine's platform is not one --self-test knows"
  work="$(scratch)"
  stub="$work/atelier-stub"
  printf '#!/bin/sh\necho stub\n' > "$stub"; chmod +x "$stub"
  out="$work/atelier-selftest.tar.gz"

  build_archive "$target" "$stub" "$out"

  unpack="$work/unpack"; mkdir -p "$unpack"
  tar -xzf "$out" -C "$unpack" || die "the archive would not unpack"
  [ -f "$unpack/atelier" ] || die "the archive carries no atelier"
  [ -x "$unpack/node" ]   || die "the archive carries no runnable node"
  local got; got="$("$unpack/node" --version)" || die "the carried node would not run"
  [ "$got" = "$NODE_VERSION" ] \
    || die "the carried node reports $got, not the pinned $NODE_VERSION"
  printf 'bundle-node: self-test OK — carried node reports %s beside atelier\n' "$got"
}

TARGET=""; BINARY=""; OUT=""; MODE="build"
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) MODE="self-test" ;;
    --target) TARGET="$2"; shift ;;
    --binary) BINARY="$2"; shift ;;
    --out)    OUT="$2"; shift ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

case "$MODE" in
  self-test) self_test ;;
  build)
    [ -n "$TARGET" ] || die "name the target with --target"
    [ -n "$BINARY" ] || die "name the built program with --binary"
    [ -n "$OUT" ]    || die "name the archive to write with --out"
    build_archive "$TARGET" "$BINARY" "$OUT"
    ;;
esac
