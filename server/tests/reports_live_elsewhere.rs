//! Two guards against the fault this product shipped with.
//!
//! One person's reports were tracked inside the thing everyone downloads, and
//! the program looked for them in a folder spelled out with that person's home
//! directory in it. Both are cheap to reinstate by accident, and neither shows
//! up on the machine that made it — only on somebody else's.

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the crate sits inside the repository")
        .to_path_buf()
}

/// Every file under `dir`, following directories.
fn files_under(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files_under(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// A report belongs to whoever wrote it, so none may be inside the product.
#[test]
fn no_report_of_anyones_lives_in_the_product() {
    let mut found = Vec::new();
    files_under(&repo_root().join("reporting"), &mut found);
    let reports: Vec<_> = found
        .iter()
        .filter(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            name.ends_with(".report.json") && name != "spec-template.report.json"
        })
        .collect();
    assert!(
        reports.is_empty(),
        "reports live where the computer keeps a program's data, never in what gets handed \
         over. These are inside the product: {reports:#?}"
    );
}

/// Nothing may work out where anything lives from a home directory it names.
#[test]
fn nothing_looks_for_a_folder_in_someones_home() {
    let mut found = Vec::new();
    files_under(&repo_root().join("server/src"), &mut found);

    // Building the needles apart keeps this file from being a hit itself, and
    // keeps a search of the tree for either of them honest.
    let checkout = format!("{}/{}", "dev", "beads-web");
    let home_var = format!("var(\"{}\")", "HOME");

    let mut guilty = Vec::new();
    for path in found.iter().filter(|p| p.extension().is_some_and(|e| e == "rs")) {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        if text.contains(&checkout) || text.contains(&home_var) {
            guilty.push(path.clone());
        }
    }
    assert!(
        guilty.is_empty(),
        "where a program's data goes is worked out in identity.rs and nowhere else, so that it \
         is right on every machine and not only the one that built the copy. These name a home \
         folder or a checkout directly: {guilty:#?}"
    );
}
