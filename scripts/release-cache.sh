#!/usr/bin/env bash
# Preserve build outputs between release tags. GitHub dependency caches are
# scoped to a ref; this archive is transferred from a successful Release run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mode=${1:?expected save or restore}
archive_dir=${2:?expected archive directory}
cargo_cache=${CARGO_HOME:-${HOME:?}/.cargo}
case "$mode" in
  save)
    mkdir -p "$archive_dir" server/target .next/cache "$cargo_cache/registry" "$cargo_cache/git"
    # tar preserves executable bits and timestamps needed by Cargo and adapters.
    tar -I 'gzip -1' -cf "$archive_dir/build.tar.gz" server/target .next/cache
    # Never archive Cargo credentials or configuration.
    tar -I 'gzip -1' -cf "$archive_dir/cargo.tar.gz" -C "$cargo_cache" registry git
    ;;
  restore)
    # Validate both archives before extracting either one.
    tar -tzf "$archive_dir/build.tar.gz" >/dev/null
    tar -tzf "$archive_dir/cargo.tar.gz" >/dev/null
    mkdir -p "$cargo_cache"
    tar -xzf "$archive_dir/build.tar.gz"
    tar -xzf "$archive_dir/cargo.tar.gz" -C "$cargo_cache"
    echo 'Restored Rust build outputs, adapter bundle, frontend cache and Cargo downloads.'
    ;;
  *) echo "Unknown release-cache mode: $mode" >&2; exit 2 ;;
esac
