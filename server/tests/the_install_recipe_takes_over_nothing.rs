//! The install recipe may not install anything that outranks what the reader
//! already runs.
//!
//! Homebrew links what a formula depends on into its own `bin`, which on most
//! machines sits ahead of a version manager's shims. Asking it for `node` there
//! swapped this machine's node 22 for node 26 the moment the app was installed,
//! and turned a suite that had been green red — for a chat helper the program
//! already reports on in words when it cannot run.

use std::fs;

#[test]
fn the_recipe_asks_homebrew_for_nothing_that_shadows_the_readers_own_tools() {
    let recipe = fs::read_to_string("../packaging/homebrew/atelier.rb.tmpl")
        .expect("the install recipe is not where the tap script reads it from");

    let asked: Vec<&str> = recipe
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("depends_on"))
        .collect();

    assert!(
        asked.is_empty(),
        "the recipe asks Homebrew to install {asked:?}, which it links ahead of \
         whatever the reader already runs — the program is one downloaded file \
         and needs nothing else to start"
    );
}
