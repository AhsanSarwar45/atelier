//! Guards that apply to every build, independent of any removed product surface.

use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("the crate sits inside the repository")
        .to_path_buf()
}

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

#[test]
fn nothing_looks_for_a_folder_in_someones_home() {
    let mut found = Vec::new();
    files_under(&repo_root().join("server/src"), &mut found);
    let checkout = format!("{}/{}", "dev", "beads-web");
    let home_var = format!("var(\"{}\")", "HOME");
    let guilty: Vec<_> = found
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .filter(|path| {
            std::fs::read_to_string(path)
                .is_ok_and(|text| text.contains(&checkout) || text.contains(&home_var))
        })
        .collect();
    assert!(guilty.is_empty(), "source files name a home folder or checkout directly: {guilty:#?}");
}

#[test]
fn embedded_assets_are_baked_in_for_debug_builds() {
    let manifest = std::fs::read_to_string(repo_root().join("server/Cargo.toml"))
        .expect("the server manifest exists");
    let line = manifest
        .lines()
        .find(|line| line.trim_start().starts_with("rust-embed"))
        .expect("rust-embed is a server dependency");
    assert!(line.contains("debug-embed"), "debug builds must embed assets; dependency reads: {line}");
}
