//! How this copy of the program was installed.
//!
//! There is one place a release comes from — the GitHub release this build was
//! cut from — but two ways it can arrive on a computer. A standalone install
//! unpacks the release archive wherever it was put. A Homebrew install has brew
//! unpack that same archive into its Cellar and link it onto the path.
//!
//! The difference matters because the in-app updater replaces the program file
//! where it lies. Doing that to a Homebrew install writes over a file brew
//! believes it owns: `brew list --versions atelier` would go on naming the old
//! version, and the next `brew upgrade` would quietly put the old program back.
//! Two installs of one app, disagreeing about what is on disk.
//!
//! So a Homebrew install updates through Homebrew. Nobody is asked to type a
//! command; the app runs the upgrade itself and restarts.

use std::path::{Path, PathBuf};

/// The formula this app publishes itself as, tap and all.
///
/// `scripts/tap.sh` pushes the recipe to `AhsanSarwar45/homebrew-atelier`, and
/// `README.md` tells people to install `AhsanSarwar45/atelier/atelier`. The
/// upgrade has to name the same fully qualified formula, because a bare
/// `atelier` could resolve to a different tap on a computer with more than one.
pub const FORMULA: &str = "AhsanSarwar45/atelier/atelier";

/// How the running program got here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallMethod {
    /// Under a Homebrew Cellar. Updates run through `brew`.
    Homebrew,
    /// Anywhere else. Updates download and swap the release archive.
    Standalone,
}

impl InstallMethod {
    /// The word the screen shows, and the API sends.
    pub fn name(self) -> &'static str {
        match self {
            InstallMethod::Homebrew => "homebrew",
            InstallMethod::Standalone => "standalone",
        }
    }
}

/// How the running program was installed.
///
/// The executable path is resolved through symlinks first, because a Homebrew
/// install is reached through a link in `bin` that points into the Cellar — the
/// link itself says nothing, and the target says everything.
pub fn current() -> InstallMethod {
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize().or(Ok(p)))
        .unwrap_or_default();
    from_path(&exe, || brew().is_some())
}

/// The same judgement, split from the filesystem so it can be tested against a
/// table of paths rather than only against whatever computer the suite runs on.
///
/// `have_brew` is only consulted once a path already looks like a Cellar
/// install, so a machine with brew installed but this app unpacked by hand is
/// still standalone — which is the case that matters, because that is the one
/// where running `brew upgrade` would do nothing at all.
pub fn from_path(exe: &Path, have_brew: impl FnOnce() -> bool) -> InstallMethod {
    if in_a_cellar(exe) && have_brew() {
        InstallMethod::Homebrew
    } else {
        InstallMethod::Standalone
    }
}

/// Whether a resolved path lies under a Homebrew Cellar entry for this app.
///
/// Brew lays its installs out as `<prefix>/Cellar/<formula>/<version>/...`, on
/// every prefix it uses — `/usr/local`, `/opt/homebrew`, `/home/linuxbrew/
/// .linuxbrew`, and whatever a person chose. Matching the `Cellar/atelier`
/// pair rather than any one prefix covers all of them, and refuses to claim a
/// path that merely happens to have the word in it.
fn in_a_cellar(exe: &Path) -> bool {
    let parts: Vec<_> = exe.components().map(|c| c.as_os_str()).collect();
    parts
        .windows(2)
        .any(|pair| pair[0] == "Cellar" && pair[1] == crate::identity::NAME)
}

/// The path to start the program again by, after Homebrew has upgraded it.
///
/// A Homebrew install is launched through a link in brew's `bin`, which this
/// process resolved to a versioned Cellar path at startup. Once brew has
/// upgraded, that resolved path still names the version brew has just replaced
/// — starting it again would run the old program, or nothing at all if brew
/// removed it. The link is what always points at the current version, so it is
/// what the restart names.
///
/// `<prefix>/Cellar/atelier/<version>/bin/atelier` becomes
/// `<prefix>/bin/atelier`. Anything that is not laid out that way gets `None`
/// and the caller falls back to the path it already had.
pub fn linked(exe: &Path) -> Option<PathBuf> {
    let name = exe.file_name()?;
    let parts: Vec<_> = exe.components().map(|c| c.as_os_str()).collect();
    let cellar = parts
        .windows(2)
        .position(|pair| pair[0] == "Cellar" && pair[1] == crate::identity::NAME)?;

    let mut prefix = PathBuf::new();
    for part in &parts[..cellar] {
        prefix.push(part);
    }
    Some(prefix.join("bin").join(name))
}

/// Where `brew` is, if it is anywhere this program can reach.
///
/// The app is often started at login with no shell behind it, so `PATH` cannot
/// be relied on alone; the ordinary prefixes are looked at too, the same way
/// `routes::mod` looks for the provider tools.
pub fn brew() -> Option<PathBuf> {
    let mut looked = Vec::new();
    if let Ok(path) = std::env::var("PATH") {
        looked.extend(std::env::split_paths(&path).map(|d| d.join("brew")));
    }
    looked.extend(
        [
            "/home/linuxbrew/.linuxbrew/bin/brew",
            "/opt/homebrew/bin/brew",
            "/usr/local/bin/brew",
        ]
        .iter()
        .map(PathBuf::from),
    );
    looked.into_iter().find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every prefix brew is known to use, and the link it puts on the path.
    #[test]
    fn a_program_under_any_brew_prefix_is_a_homebrew_install() {
        for path in [
            "/home/linuxbrew/.linuxbrew/Cellar/atelier/0.22.12/bin/atelier",
            "/opt/homebrew/Cellar/atelier/0.22.12/bin/atelier",
            "/usr/local/Cellar/atelier/0.22.12/bin/atelier",
            "/opt/brew/Cellar/atelier/0.13.1/bin/atelier",
        ] {
            assert_eq!(
                from_path(Path::new(path), || true),
                InstallMethod::Homebrew,
                "{path} is a Homebrew install"
            );
        }
    }

    #[test]
    fn a_program_unpacked_anywhere_else_is_standalone() {
        for path in [
            "/home/someone/.local/bin/atelier",
            "/usr/local/bin/atelier",
            "/opt/atelier/atelier",
            "/home/someone/code/atelier/server/target/release/atelier",
        ] {
            assert_eq!(
                from_path(Path::new(path), || true),
                InstallMethod::Standalone,
                "{path} was not installed by Homebrew"
            );
        }
    }

    /// The case that would otherwise run `brew upgrade` against a formula this
    /// computer never installed, which does nothing and reports no reason.
    #[test]
    fn a_hand_unpacked_copy_on_a_computer_that_has_brew_is_still_standalone() {
        assert_eq!(
            from_path(Path::new("/home/someone/.local/bin/atelier"), || true),
            InstallMethod::Standalone
        );
    }

    /// The mirror of it: a Cellar path on a computer where brew has since gone.
    #[test]
    fn a_cellar_path_with_no_brew_to_run_falls_back_to_standalone() {
        assert_eq!(
            from_path(
                Path::new("/opt/homebrew/Cellar/atelier/0.22.12/bin/atelier"),
                || false
            ),
            InstallMethod::Standalone,
            "an upgrade cannot be run through a brew that is not there"
        );
    }

    /// A folder that merely has the word in it is not a Cellar install.
    #[test]
    fn a_path_that_only_looks_like_a_cellar_is_not_one() {
        for path in [
            "/home/someone/Cellar/notes/atelier",
            "/home/someone/wine-Cellar/atelier",
            "/srv/Cellar/atelier-docs/atelier",
        ] {
            assert_eq!(
                from_path(Path::new(path), || true),
                InstallMethod::Standalone,
                "{path} is not a Homebrew Cellar entry for this app"
            );
        }
    }

    /// The restart has to name the link, not the versioned path this process
    /// was launched from: after an upgrade that one names the old version.
    #[test]
    fn a_homebrew_restart_goes_through_the_link_on_the_path() {
        assert_eq!(
            linked(Path::new(
                "/home/linuxbrew/.linuxbrew/Cellar/atelier/0.22.12/bin/atelier"
            )),
            Some(PathBuf::from("/home/linuxbrew/.linuxbrew/bin/atelier"))
        );
        assert_eq!(
            linked(Path::new("/opt/homebrew/Cellar/atelier/0.22.12/bin/atelier")),
            Some(PathBuf::from("/opt/homebrew/bin/atelier"))
        );
    }

    #[test]
    fn a_path_that_is_not_a_cellar_entry_has_no_link_to_offer() {
        assert_eq!(linked(Path::new("/home/someone/.local/bin/atelier")), None);
    }

    #[test]
    fn the_formula_names_its_tap() {
        assert_eq!(
            FORMULA, "AhsanSarwar45/atelier/atelier",
            "the upgrade must name the same tap the install instructions do, \
             or it could resolve to a different formula"
        );
    }
}
