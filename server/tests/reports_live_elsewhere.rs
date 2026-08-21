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

/// The tools must travel INSIDE the binary, not be read off the machine that
/// built it.
///
/// Without `debug-embed`, rust-embed only bakes files in for a release build;
/// every other build reads them back off disk at the absolute path fixed when
/// it was compiled. So `report_tools`'s own test — the one that says this copy
/// carries what a report needs — would pass on a copy that carries nothing,
/// and a dev-built binary run on any other machine would lay down no tools at
/// all. The feature is what makes that test exercise the bytes it claims to.
#[test]
fn the_tools_are_baked_in_for_every_build_not_only_a_release() {
    let manifest = std::fs::read_to_string(repo_root().join("server/Cargo.toml"))
        .expect("the server's own manifest");
    let line = manifest
        .lines()
        .find(|l| l.trim_start().starts_with("rust-embed"))
        .expect("rust-embed is a dependency of the server");
    assert!(
        line.contains("debug-embed"),
        "without debug-embed the embedded files are read off the build machine's disk in \
         every build but a release one, so nothing that checks them is checking the product. \
         The dependency reads: {line}"
    );
}


/// The shell tool and the program must land on the same folder.
///
/// `reporting/bin/report` writes specs where the app reads them, so the two
/// have to agree. It worked the folder out in bash, which was a second copy of
/// a rule `identity.rs` says lives in one place — a rename of `APPLICATION`
/// there would have moved the app and left the shell tool writing to the old
/// folder, with nothing to say so (bw-pqt.24). The tool now asks the program
/// when one is installed; this is what holds its fallback in step.
#[test]
fn the_shell_tool_and_the_program_agree_on_where_data_goes() {
    let tool = repo_root().join("reporting/bin/report");
    // Only the function, never the whole script: sourcing it would run the
    // command. The narrowed PATH is the state of a machine that has the source
    // but has never built or installed it, so the fallback is what answers —
    // and the fallback is the half that can drift. Where a copy IS installed
    // there, it answers instead, and the same equality has to hold.
    let script = format!(
        "eval \"$(sed -n '/^data_home() {{/,/^}}/p' '{}')\"; PATH=/usr/bin:/bin data_home",
        tool.display()
    );
    let out = std::process::Command::new("bash")
        .arg("-c")
        .arg(&script)
        .output()
        .expect("bash reads the report command's own function");
    assert!(
        out.status.success(),
        "the report command's data_home did not run: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let ours = atelier::identity::data_dir().expect("a machine running tests has a home");
    assert_eq!(
        said,
        ours.display().to_string(),
        "the report command writes to {said} and the program reads from {}. They are the same \
         folder or reports vanish: where it goes is decided in server/src/identity.rs, and the \
         shell tool asks for it rather than working it out again",
        ours.display()
    );
}

/// And the tool must ask, not only happen to agree today.
#[test]
fn the_shell_tool_asks_the_program_before_falling_back() {
    let tool = std::fs::read_to_string(repo_root().join("reporting/bin/report"))
        .expect("the report command");
    assert!(
        tool.contains("--data-dir"),
        "reporting/bin/report works the data folder out for itself instead of asking the \
         program that owns the answer"
    );
}
