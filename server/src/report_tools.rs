//! The tools that make a report, carried inside the product.
//!
//! Making a report is part of what this is for, so the tools travel in the
//! binary and are laid down next to the reports themselves the first time the
//! product runs. Nobody installs anything separately, and nothing looks for a
//! folder that only exists on the machine the copy was built on.
//!
//! They are written out again whenever a fingerprint of the embedded files —
//! every path and its bytes, folded together — no longer matches the marker
//! beside them, so an edit to a single tool reaches an installed copy the
//! next time it starts, not only on the next release.

use rust_embed::Embed;
use std::path::Path;

/// The report toolchain as it stood when this copy was built.
#[derive(Embed)]
#[folder = "../reporting/tools/"]
#[exclude = "__pycache__/*"]
struct Tools;

const MARKER: &str = ".version";

/// Lay the tools down beside the reports, replacing an older or edited copy.
///
/// Returns what went wrong rather than stopping the program: a copy that
/// cannot write there still serves the board, and only reports suffer.
pub fn install() -> Result<(), String> {
    let Some(dir) = crate::identity::tools_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
    };

    let mut files = Vec::new();
    for name in Tools::iter() {
        let file = Tools::get(&name).ok_or_else(|| format!("{name} is not in this build"))?;
        files.push((name.to_string(), file));
    }

    let want = fingerprint(&files.iter().map(|(n, f)| (n.as_str(), f.data.as_ref())).collect::<Vec<_>>());
    if is_current(&dir, &want) {
        return Ok(());
    }

    for (name, file) in &files {
        let dest = dir.join(name);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&dest, file.data.as_ref()).map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    std::fs::write(dir.join(MARKER), &want)
        .map_err(|e| format!("{}: {e}", dir.join(MARKER).display()))?;
    Ok(())
}

/// True when the marker beside `dir` already holds `want`.
///
/// A marker from before this fingerprint existed — a plain version string
/// like `0.12.2` — simply never equals a fingerprint, so it reads as out of
/// date and gets rewritten like any other stale copy. Nothing here needs to
/// recognise that shape specially.
fn is_current(dir: &Path, want: &str) -> bool {
    std::fs::read_to_string(dir.join(MARKER)).map(|v| v.trim() == want).unwrap_or(false)
}

/// A fingerprint of an embedded file set: every path, sorted, folded
/// together with its bytes. Sorting first makes the result depend only on
/// what is embedded, never on the order `Tools::iter()` happens to walk
/// them in; folding in both the path and the bytes means renaming, editing,
/// adding, or removing any one file changes the value.
///
/// No crate already in this workspace hashes bytes (no `sha2` or similar in
/// `Cargo.toml`), so this is a small hand-rolled FNV-1a rather than a new
/// dependency pulled in for one marker file that only has to detect change,
/// never resist tampering.
fn fingerprint(files: &[(&str, &[u8])]) -> String {
    let mut sorted: Vec<&(&str, &[u8])> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(b.0));

    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET;
    let mut fold = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= u64::from(b);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    for (path, data) in sorted {
        // A NUL after each part keeps ("ab", "c") from folding the same as
        // ("a", "bc"), and separates a path from its own bytes the same way.
        fold(path.as_bytes());
        fold(&[0]);
        fold(data);
        fold(&[0]);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_carries_the_tools_a_report_needs() {
        let names: Vec<String> = Tools::iter().map(|n| n.to_string()).collect();
        for needed in ["build.py", "selftest.py", "blocks.py", "page.css", "page.js"] {
            assert!(
                names.iter().any(|n| n == needed),
                "{needed} is not in this build; the tools it carries are {names:?}"
            );
        }
    }

    #[test]
    fn nothing_a_python_run_left_behind_is_carried() {
        for name in Tools::iter() {
            assert!(
                !name.contains("__pycache__"),
                "{name} is a leftover of running the tools, not one of them"
            );
        }
    }

    #[test]
    fn tools_written_by_this_build_are_not_written_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        assert!(!is_current(dir.path(), "abc123"), "an empty folder cannot be current");
        std::fs::write(dir.path().join(MARKER), "abc123").unwrap();
        assert!(is_current(dir.path(), "abc123"));
        std::fs::write(dir.path().join(MARKER), "def456").unwrap();
        assert!(!is_current(dir.path(), "abc123"), "a different fingerprint's tools are replaced");
    }

    #[test]
    fn a_plain_old_version_marker_is_out_of_date_not_a_crash() {
        // Before this change the marker held `env!("CARGO_PKG_VERSION")`, a
        // string like "0.12.2". An installed copy carrying one of those must
        // simply be treated as stale and rewritten.
        let dir = tempfile::tempdir().expect("a temporary directory");
        std::fs::write(dir.path().join(MARKER), "0.12.2").unwrap();
        assert!(!is_current(dir.path(), &fingerprint(&[("build.py", b"anything")])));
    }

    #[test]
    fn the_fingerprint_is_stable_across_two_calls() {
        let files: [(&str, &[u8]); 2] = [("build.py", b"one"), ("blocks.py", b"two")];
        assert_eq!(fingerprint(&files), fingerprint(&files));
    }

    #[test]
    fn the_fingerprint_does_not_depend_on_the_order_the_files_are_given_in() {
        let forward: [(&str, &[u8]); 2] = [("a.py", b"one"), ("b.py", b"two")];
        let backward: [(&str, &[u8]); 2] = [("b.py", b"two"), ("a.py", b"one")];
        assert_eq!(fingerprint(&forward), fingerprint(&backward));
    }

    #[test]
    fn the_fingerprint_changes_when_a_files_content_changes() {
        let before: [(&str, &[u8]); 1] = [("build.py", b"version one")];
        let after: [(&str, &[u8]); 1] = [("build.py", b"version two")];
        assert_ne!(fingerprint(&before), fingerprint(&after));
    }

    #[test]
    fn the_fingerprint_changes_when_a_file_is_added_or_removed() {
        let smaller: [(&str, &[u8]); 1] = [("build.py", b"same bytes")];
        let bigger: [(&str, &[u8]); 2] = [("build.py", b"same bytes"), ("extra.py", b"new")];
        assert_ne!(fingerprint(&smaller), fingerprint(&bigger));
    }
}
