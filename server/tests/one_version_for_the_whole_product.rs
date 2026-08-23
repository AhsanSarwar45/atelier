//! One version for the whole product.
//!
//! `atelier --version` reads the number out of this crate, and the download line
//! in the install recipe is built from the tag. The screens' own manifest carries
//! a third copy. Nothing made them agree, so a bump to one of them left the
//! program reporting a build nobody released, and the recipe pointing at files
//! from a number the program never says (bw-8um.3.26).

use std::fs;

/// The number the screens' manifest carries.
fn screens_say() -> String {
    let manifest = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../package.json"))
        .expect("the screens' manifest sits beside this crate");
    for line in manifest.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("\"version\":") {
            return rest.trim().trim_end_matches(',').trim_matches('"').to_string();
        }
    }
    panic!("the screens' manifest names no version");
}

#[test]
fn the_program_and_the_screens_report_the_same_build() {
    let program = env!("CARGO_PKG_VERSION");
    let screens = screens_say();
    assert_eq!(
        program, screens,
        "the program reports {program} and the screens' manifest says {screens}, so a release \
         built from one of the two numbers is named after a build the other half never was"
    );
}
