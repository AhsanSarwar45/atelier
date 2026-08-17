//! What this product is called, written down once.
//!
//! Every folder the product keeps data in is worked out from the three names
//! below, so renaming it is one edit here rather than a sweep across the tree.
//! Nothing else may ask the operating system where a program's data goes —
//! `ProjectDirs` is called here and nowhere else, and a check enforces that.

use std::path::PathBuf;

/// The three names an operating system files a program's data under.
///
/// Changing `APPLICATION` moves every installed copy's settings, so it is
/// changed once, deliberately, alongside a migration that carries them over.
pub const QUALIFIER: &str = "com";
pub const ORGANISATION: &str = "beads";
pub const APPLICATION: &str = "kanban-ui";

/// Where this computer keeps this program's data.
///
/// `None` only when the computer names no home directory at all, which is not
/// a normal state; the callers then do nothing rather than fall back to a
/// relative path resolved against wherever the program happened to start.
pub fn data_dir() -> Option<PathBuf> {
    directories::ProjectDirs::from(QUALIFIER, ORGANISATION, APPLICATION)
        .map(|dirs| dirs.data_dir().to_path_buf())
}

/// The file holding this machine's settings and its list of projects.
pub fn settings_db() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("settings.db"))
}

/// Where report specs and their built pages live.
///
/// `REPORTS_DIR` overrides it, for tests.
pub fn reports_dir() -> Option<PathBuf> {
    resolve_dir(std::env::var("REPORTS_DIR").ok(), data_dir(), "reports")
}

/// Where the tools that make a report live.
///
/// The product carries them and lays them down here, so this never points into
/// anyone's checkout. `REPORT_TOOLS_DIR` overrides it, for tests.
pub fn tools_dir() -> Option<PathBuf> {
    resolve_dir(std::env::var("REPORT_TOOLS_DIR").ok(), data_dir(), "tools")
}

/// The rule behind both, kept apart from the environment so it can be tested
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
            ("com", "beads", "kanban-ui")
        );
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
    fn reports_dir_and_tools_dir_sit_side_by_side_under_the_data_directory() {
        let data = PathBuf::from("/somewhere/data");
        assert_eq!(
            resolve_dir(None, Some(data.clone()), "reports"),
            Some(data.join("reports"))
        );
        assert_eq!(
            resolve_dir(None, Some(data.clone()), "tools"),
            Some(data.join("tools"))
        );
    }

    #[test]
    fn reports_dir_is_nothing_when_the_computer_names_no_home() {
        // The old code read HOME directly and fell back to an empty string, so
        // with HOME unset — the usual state on Windows — it resolved a relative
        // path against whatever directory the program was started in.
        assert_eq!(resolve_dir(None, None, "reports"), None);
        assert_eq!(resolve_dir(None, None, "tools"), None);
    }

    #[test]
    fn reports_dir_takes_the_override_when_one_is_set() {
        assert_eq!(
            resolve_dir(Some("/elsewhere".to_string()), Some(PathBuf::from("/data")), "reports"),
            Some(PathBuf::from("/elsewhere"))
        );
    }

    #[test]
    fn reports_dir_ignores_an_empty_override() {
        assert_eq!(
            resolve_dir(Some("  ".to_string()), Some(PathBuf::from("/data")), "reports"),
            Some(PathBuf::from("/data/reports"))
        );
    }
}
