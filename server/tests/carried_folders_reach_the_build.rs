//! Every folder the product carries is one cargo watches.
//!
//! The screens, the working rules and the rest are read out of folders while
//! this crate compiles. Cargo watches this crate's own source and nothing else,
//! so a build after a change to one of those folders was answered with the
//! previous binary and the installed program went on serving last week's copy
//! (bw-8um.3.1). The build script names them; this is what stops the next
//! carried folder being added without being named there.

use std::path::{Path, PathBuf};

fn here() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `#[folder = "…"]` in the crate's own source, as written.
fn carried() -> Vec<String> {
    let mut found = Vec::new();
    walk(&here().join("src"), &mut found);
    found
}

fn walk(dir: &Path, found: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(&path, found);
            continue;
        }
        if path.extension().is_some_and(|e| e == "rs") {
            let said = std::fs::read_to_string(&path).unwrap_or_default();
            for piece in said.split("#[folder = \"").skip(1) {
                if let Some(name) = piece.split('"').next() {
                    found.push(name.to_string());
                }
            }
        }
    }
}

#[test]
fn every_folder_the_product_carries_is_one_the_build_watches() {
    let script = std::fs::read_to_string(here().join("build.rs"))
        .expect("the build script that names the carried folders is missing");
    let carried = carried();
    assert!(
        carried.len() >= 4,
        "no carried folders were found in the source at all, so this test is \
         proving nothing: {carried:?}"
    );
    for folder in &carried {
        let named = folder.trim_end_matches('/');
        assert!(
            script.contains(named),
            "`{named}` travels inside the binary and the build script does not \
             name it, so a change there is answered with the previous build and \
             the program goes on serving the old copy"
        );
    }
}
