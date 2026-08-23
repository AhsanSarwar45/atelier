//! One version for the whole product.
//!
//! `atelier --version` reads the number out of this crate, and the download line
//! in the install recipe is built from the tag. The screens' own manifest carries
//! a third copy. Nothing made them agree, so a bump to one of them left the
//! program reporting a build nobody released, and the recipe pointing at files
//! from a number the program never says (bw-8um.3.26). The frozen dependency
//! list carries a fourth copy, which a build machine reads before the manifest
//! and which the first release went out disagreeing with (bw-8um.3.28).

use std::fs;

/// The first version named in one of the screens' JSON files. Both the manifest
/// and the frozen list name the product's own version before anything else.
fn version_in(file: &str) -> String {
    let path = format!("{}/../{file}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|_| panic!("{file} sits beside this crate"));
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("\"version\":") {
            return rest.trim().trim_end_matches(',').trim_matches('"').to_string();
        }
    }
    panic!("{file} names no version");
}

#[test]
fn the_program_and_the_screens_report_the_same_build() {
    let program = env!("CARGO_PKG_VERSION");
    for file in ["package.json", "package-lock.json"] {
        let said = version_in(file);
        assert_eq!(
            program, said,
            "the program reports {program} and {file} says {said}, so a release built from \
             one of the two numbers is named after a build the other half never was"
        );
    }
}
