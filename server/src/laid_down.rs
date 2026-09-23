//! Files carried inside the product and written out beside its data.
//!
//! Two things travel in the binary and have to land on disk before they are
//! any use: the tools that make a report, and the chat helper. Both want the
//! same behaviour — write the set out, and write it again whenever the copy on
//! disk is not the copy this build carries — so the behaviour is written once,
//! here, and neither of them keeps its own hash.
//!
//! The marker is a fingerprint rather than a version number, so an edit to a
//! single carried file reaches an installed copy the next time it starts,
//! not only on the next release.

use std::path::Path;

/// One carried set: each file's path under the destination, and its bytes.
pub type Carried = Vec<(String, Vec<u8>)>;

/// The file beside a laid-down set that says which build wrote it.
pub const MARKER: &str = ".version";

/// Everything one embedded folder holds, gathered under a prefix.
///
/// `under` is where the set sits inside the destination — `""` for a set that
/// owns its folder, a path for one that has to keep its place relative to
/// another. Gathering is separate from writing because the fingerprint has to
/// see every set before any of them is written: three sets sharing one marker
/// means a change to any one of them rewrites all three, which is what stops a
/// half-updated helper being left behind.
pub fn gather<E: rust_embed::RustEmbed>(under: &str) -> Result<Carried, String> {
    let mut out = Carried::new();
    for name in E::iter() {
        let file = E::get(&name).ok_or_else(|| format!("{name} is not in this build"))?;
        let path = if under.is_empty() {
            name.to_string()
        } else {
            format!("{under}/{name}")
        };
        out.push((path, file.data.into_owned()));
    }
    Ok(out)
}

/// Lay a carried set down in `dir`, replacing an older or edited copy.
///
/// Does nothing when the marker already names this build's fingerprint, so the
/// cost of starting is one small read rather than a few megabytes of writing.
pub fn install(dir: &Path, files: &Carried) -> Result<(), String> {
    let want = fingerprint(files);
    if is_current(dir, &want) {
        return Ok(());
    }
    for (name, bytes) in files {
        let dest = dir.join(name);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&dest, bytes).map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    std::fs::write(dir.join(MARKER), &want)
        .map_err(|e| format!("{}: {e}", dir.join(MARKER).display()))?;
    Ok(())
}

/// True when a marker beside `dir` already holds `want`.
///
/// Named rather than fixed because more than one thing is guarded this way:
/// the carried files by the build that wrote them, and the kit the helper
/// fetches by the lock it was fetched against.
pub fn marker_says(dir: &Path, name: &str, want: &str) -> bool {
    std::fs::read_to_string(dir.join(name)).map(|v| v.trim() == want).unwrap_or(false)
}

/// Write a marker down, so the next run knows this one got here.
pub fn write_marker(dir: &Path, name: &str, want: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    std::fs::write(dir.join(name), want).map_err(|e| format!("{}: {e}", dir.join(name).display()))
}

/// True when the marker beside `dir` already holds `want`.
///
/// A marker from before this fingerprint existed — a plain version string
/// like `0.12.2` — simply never equals a fingerprint, so it reads as out of
/// date and gets rewritten like any other stale copy. Nothing here needs to
/// recognise that shape specially.
fn is_current(dir: &Path, want: &str) -> bool {
    marker_says(dir, MARKER, want)
}

/// A fingerprint of a carried set: every path, sorted, folded together with
/// its bytes. Sorting first makes the result depend only on what is embedded,
/// never on the order the files happen to be walked in; folding in both the
/// path and the bytes means renaming, editing, adding, or removing any one
/// file changes the value.
///
/// No crate already in this workspace hashes bytes (no `sha2` or similar in
/// `Cargo.toml`), so this is a small hand-rolled FNV-1a rather than a new
/// dependency pulled in for one marker file that only has to detect change,
/// never resist tampering.
pub fn fingerprint(files: &Carried) -> String {
    let mut sorted: Vec<&(String, Vec<u8>)> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));

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

    fn carried(files: &[(&str, &[u8])]) -> Carried {
        files.iter().map(|(n, b)| (n.to_string(), b.to_vec())).collect()
    }

    #[test]
    fn files_written_by_this_build_are_not_written_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        assert!(!is_current(dir.path(), "abc123"), "an empty folder cannot be current");
        std::fs::write(dir.path().join(MARKER), "abc123").unwrap();
        assert!(is_current(dir.path(), "abc123"));
        std::fs::write(dir.path().join(MARKER), "def456").unwrap();
        assert!(!is_current(dir.path(), "abc123"), "a different fingerprint's files are replaced");
    }

    #[test]
    fn a_plain_old_version_marker_is_out_of_date_not_a_crash() {
        // Before this fingerprint existed the marker held `env!("CARGO_PKG_VERSION")`,
        // a string like "0.12.2". An installed copy carrying one of those must
        // simply be treated as stale and rewritten.
        let dir = tempfile::tempdir().expect("a temporary directory");
        std::fs::write(dir.path().join(MARKER), "0.12.2").unwrap();
        assert!(!is_current(dir.path(), &fingerprint(&carried(&[("build.py", b"anything")]))));
    }

    #[test]
    fn the_fingerprint_is_stable_across_two_calls() {
        let files = carried(&[("build.py", b"one"), ("blocks.py", b"two")]);
        assert_eq!(fingerprint(&files), fingerprint(&files));
    }

    #[test]
    fn the_fingerprint_does_not_depend_on_the_order_the_files_are_given_in() {
        let forward = carried(&[("a.py", b"one"), ("b.py", b"two")]);
        let backward = carried(&[("b.py", b"two"), ("a.py", b"one")]);
        assert_eq!(fingerprint(&forward), fingerprint(&backward));
    }

    #[test]
    fn the_fingerprint_changes_when_a_files_content_changes() {
        let before = carried(&[("build.py", b"version one")]);
        let after = carried(&[("build.py", b"version two")]);
        assert_ne!(fingerprint(&before), fingerprint(&after));
    }

    #[test]
    fn the_fingerprint_changes_when_a_file_is_added_or_removed() {
        let smaller = carried(&[("build.py", b"same bytes")]);
        let bigger = carried(&[("build.py", b"same bytes"), ("extra.py", b"new")]);
        assert_ne!(fingerprint(&smaller), fingerprint(&bigger));
    }

    #[test]
    fn a_set_is_written_where_its_own_paths_say_it_goes() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let files = carried(&[("src/server.ts", b"the helper"), ("package.json", b"{}")]);
        install(dir.path(), &files).expect("a set lands");
        assert_eq!(std::fs::read(dir.path().join("src/server.ts")).unwrap(), b"the helper");
        assert_eq!(std::fs::read(dir.path().join("package.json")).unwrap(), b"{}");
    }

    #[test]
    fn a_set_already_on_disk_under_this_builds_fingerprint_is_left_alone() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let files = carried(&[("src/server.ts", b"the helper")]);
        install(dir.path(), &files).expect("a set lands");

        // Somebody edits the laid-down copy. Nothing about the build changed,
        // so starting again must not cost the write.
        std::fs::write(dir.path().join("src/server.ts"), b"edited by hand").unwrap();
        install(dir.path(), &files).expect("a second run");
        assert_eq!(std::fs::read(dir.path().join("src/server.ts")).unwrap(), b"edited by hand");
    }

    #[test]
    fn a_set_that_changed_since_the_last_run_is_written_out_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        install(dir.path(), &carried(&[("src/server.ts", b"the old helper")])).unwrap();
        install(dir.path(), &carried(&[("src/server.ts", b"the new helper")])).unwrap();
        assert_eq!(std::fs::read(dir.path().join("src/server.ts")).unwrap(), b"the new helper");
    }
}
