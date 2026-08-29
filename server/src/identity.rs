//! What this product is called, written down once.
//!
//! Every folder the product keeps data in is worked out from the names below,
//! so renaming it is one edit here rather than a sweep across the tree.
//! Nothing else may ask the operating system where a program's data goes —
//! `ProjectDirs` is called here and nowhere else, and a check enforces that.
//!
//! `scripts/one-name.py` reads `NAME` out of this file and then looks for the
//! spelling it implies everywhere a person meets it — the binary, the npm
//! package, the nix output, the homebrew formula, the downloads a release
//! publishes. A rename that stops here leaves the product answering to two
//! names, and that check is what says so.

use std::fs;
use std::path::{Path, PathBuf};

/// The name, and the only place it is written down.
pub const NAME: &str = "atelier";

/// The same name as a person reads it, on a screen or in a sentence.
pub const DISPLAY: &str = "Atelier";

/// The three names an operating system files a program's data under.
///
/// `APPLICATION` is the name itself, so the folder cannot drift from what the
/// product is called. Changing `NAME` moves every installed copy's settings,
/// which is why `adopt_earlier_install` exists.
pub const QUALIFIER: &str = "com";
pub const ORGANISATION: &str = "weselow";
pub const APPLICATION: &str = NAME;

/// What the product was filed under before, kept so an install made then is
/// still found. Never used for writing — only for the one-time carry-over.
pub const EARLIER: (&str, &str, &str) = ("com", "beads", "kanban-ui");

/// Where this computer keeps this program's data.
///
/// `None` only when the computer names no home directory at all, which is not
/// a normal state; the callers then do nothing rather than fall back to a
/// relative path resolved against wherever the program happened to start.
/// `ATELIER_DATA_DIR` overrides it, for a person who keeps their data on
/// another disk and for a check that must not touch the reader's own.
pub fn data_dir() -> Option<PathBuf> {
    resolve_data_dir(std::env::var("ATELIER_DATA_DIR").ok())
}

/// The rule behind it, kept apart from the environment so it can be tested
/// without one test's variable reaching another running beside it.
fn resolve_data_dir(override_dir: Option<String>) -> Option<PathBuf> {
    match override_dir.filter(|d| !d.trim().is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => directories::ProjectDirs::from(QUALIFIER, ORGANISATION, APPLICATION)
            .map(|dirs| dirs.data_dir().to_path_buf()),
    }
}

/// Where a copy installed under the earlier name kept its data.
fn earlier_data_dir() -> Option<PathBuf> {
    let (qualifier, organisation, application) = EARLIER;
    directories::ProjectDirs::from(qualifier, organisation, application)
        .map(|dirs| dirs.data_dir().to_path_buf())
}

/// Carry an install made under the earlier name over to this one.
///
/// A person who upgrades has settings, a project list and saved data under a
/// folder named after what the product used to be called. Left alone, the
/// renamed program starts up and finds nothing. So the first run under the new
/// name copies the old folder across.
///
/// The old folder is left where it is. A copy still on the earlier name keeps
/// working, and a carry-over that deleted what it read from would take their
/// projects with it if this one is later removed.
///
/// Run before anything reads the settings, and never after: the folder already
/// existing is what makes this a no-op for the second run onwards.
pub fn adopt_earlier_install() -> Result<(), String> {
    let (Some(now), Some(before)) = (data_dir(), earlier_data_dir()) else {
        return Ok(());
    };
    carry_over(&before, &now)
}

/// The rule behind it, apart from the environment so it can be tested.
///
/// Nothing happens unless there is an earlier install to carry — a folder with
/// a settings file in it — and nothing at all under the new name yet.
fn carry_over(before: &Path, now: &Path) -> Result<(), String> {
    if now.exists() || !before.join("settings.db").exists() {
        return Ok(());
    }
    copy_tree(before, now).map_err(|e| format!("{} -> {}: {e}", before.display(), now.display()))
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The file holding this machine's settings and its list of projects.
pub fn settings_db() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("settings.db"))
}

/// Where the chat helper lives.
///
/// The product carries it and lays it down here, so a copy installed on a
/// computer that has never held the source still has something to start.
/// `HELPER_DIR` overrides it, for tests.
pub fn helper_dir() -> Option<PathBuf> {
    resolve_dir(std::env::var("HELPER_DIR").ok(), data_dir(), "helper")
}

/// Where the working rules live — the board tools, the session gates, and the
/// workers and skills a session reads.
///
/// The product carries them and lays them down here, so setting a project up
/// works on a computer that has never held this repository. `RULES_DIR`
/// overrides it, for tests.
pub fn rules_dir() -> Option<PathBuf> {
    resolve_dir(std::env::var("RULES_DIR").ok(), data_dir(), "rules")
}

/// Content-addressed pictures imported by the presentation command.
pub fn presentation_media_dir() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("presentation-media"))
}

/// The rule behind them, kept apart from the environment so it can be tested
/// for the case where the computer names no home.
fn resolve_dir(override_dir: Option<String>, data: Option<PathBuf>, leaf: &str) -> Option<PathBuf> {
    match override_dir.filter(|d| !d.trim().is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => data.map(|dir| dir.join(leaf)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_that_shipped_has_not_moved() {
        // Changing this moves every installed copy's settings. It happens once,
        // with a migration, and this test is the reminder to write one.
        assert_eq!(
            (QUALIFIER, ORGANISATION, APPLICATION),
            ("com", "weselow", "atelier")
        );
    }

    #[test]
    fn every_name_the_product_answers_to_comes_from_the_one_value() {
        // The folder the data lives in is the name itself, so the two cannot
        // drift apart in a rename that only reached one of them.
        assert_eq!(APPLICATION, NAME);
        assert_eq!(DISPLAY.to_lowercase(), NAME);
    }

    fn an_install(at: &Path, projects: &str) {
        fs::create_dir_all(at.join("saved-pages")).expect("a folder to write into");
        fs::write(at.join("settings.db"), projects).expect("a settings file");
        fs::write(at.join("saved-pages").join("a-page.json"), "{}").expect("saved data");
    }

    #[test]
    fn settings_migrate_carries_an_earlier_install_over_with_its_projects() {
        let tmp = std::env::temp_dir().join(format!("{NAME}-carry-over"));
        let _ = fs::remove_dir_all(&tmp);
        let before = tmp.join("earlier");
        let now = tmp.join("now");
        an_install(&before, "two projects");

        carry_over(&before, &now).expect("the carry-over to succeed");

        assert_eq!(
            fs::read_to_string(now.join("settings.db")).expect("the settings to be there"),
            "two projects",
            "the project list did not come across"
        );
        assert!(
            now.join("saved-pages").join("a-page.json").exists(),
            "the saved data did not come across"
        );
        assert!(before.join("settings.db").exists(), "the earlier install was moved, not copied");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn settings_migrate_leaves_an_install_that_already_exists_alone() {
        let tmp = std::env::temp_dir().join(format!("{NAME}-carry-over-existing"));
        let _ = fs::remove_dir_all(&tmp);
        let before = tmp.join("earlier");
        let now = tmp.join("now");
        an_install(&before, "the old list");
        an_install(&now, "the list in use");

        carry_over(&before, &now).expect("the carry-over to succeed");

        assert_eq!(
            fs::read_to_string(now.join("settings.db")).expect("the settings to be there"),
            "the list in use",
            "an install already under the new name was overwritten"
        );
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn settings_migrate_does_nothing_when_there_was_no_earlier_install() {
        let tmp = std::env::temp_dir().join(format!("{NAME}-carry-over-none"));
        let _ = fs::remove_dir_all(&tmp);
        let now = tmp.join("now");

        carry_over(&tmp.join("never-existed"), &now).expect("nothing to do is not a failure");

        assert!(!now.exists(), "a folder was made for an install that never was");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn settings_migrate_ignores_a_folder_with_no_settings_in_it() {
        // A folder of that name with nothing in it is not an install, and
        // copying it would hide a real one that turns up later.
        let tmp = std::env::temp_dir().join(format!("{NAME}-carry-over-empty"));
        let _ = fs::remove_dir_all(&tmp);
        let before = tmp.join("earlier");
        let now = tmp.join("now");
        fs::create_dir_all(&before).expect("a folder");

        carry_over(&before, &now).expect("nothing to do is not a failure");

        assert!(!now.exists(), "an empty folder was carried over as if it were an install");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_data_directory_is_absolute_and_belongs_to_nobody_in_particular() {
        let dir = data_dir().expect("a machine running tests has a home directory");
        assert!(dir.is_absolute(), "{dir:?} is not an absolute path");
        // Tests run from the checkout, so this catches the old fault: a data
        // folder that resolves inside whoever's copy of the source built it.
        let checkout = std::env::current_dir().expect("a working directory");
        assert!(
            !dir.starts_with(&checkout),
            "{dir:?} resolves inside the checkout at {checkout:?}"
        );
    }

    #[test]
    fn the_data_folder_can_be_moved_off_the_disk_it_defaults_to() {
        // A registered service inherits no shell and is handed this in its own
        // definition, so a check can register a copy that touches none of the
        // reader's projects.
        assert_eq!(
            resolve_data_dir(Some("/another/disk".to_string())),
            Some(PathBuf::from("/another/disk"))
        );
    }

    #[test]
    fn an_empty_data_folder_setting_is_not_a_folder() {
        // An unset variable read as an empty string would otherwise resolve a
        // relative path against wherever the program happened to start.
        assert_eq!(resolve_data_dir(Some("  ".to_string())), data_dir());
        assert_eq!(resolve_data_dir(None), data_dir());
    }

}
