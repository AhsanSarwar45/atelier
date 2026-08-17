//! The tools that make a report, carried inside the product.
//!
//! Making a report is part of what this is for, so the tools travel in the
//! binary and are laid down next to the reports themselves the first time the
//! product runs. Nobody installs anything separately, and nothing looks for a
//! folder that only exists on the machine the copy was built on.
//!
//! They are written out again whenever the version marker beside them does not
//! match this build, so an upgraded product never runs last version's tools.

use rust_embed::Embed;
use std::path::Path;

/// The report toolchain as it stood when this copy was built.
#[derive(Embed)]
#[folder = "../reporting/tools/"]
#[exclude = "__pycache__/*"]
struct Tools;

const MARKER: &str = ".version";

/// Lay the tools down beside the reports, replacing an older build's copy.
///
/// Returns what went wrong rather than stopping the program: a copy that
/// cannot write there still serves the board, and only reports suffer.
pub fn install() -> Result<(), String> {
    let Some(dir) = crate::identity::tools_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
    };
    if is_current(&dir) {
        return Ok(());
    }
    for name in Tools::iter() {
        let file = Tools::get(&name).ok_or_else(|| format!("{name} is not in this build"))?;
        let dest = dir.join(name.as_ref());
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&dest, file.data.as_ref()).map_err(|e| format!("{}: {e}", dest.display()))?;
    }
    std::fs::write(dir.join(MARKER), env!("CARGO_PKG_VERSION"))
        .map_err(|e| format!("{}: {e}", dir.join(MARKER).display()))?;
    Ok(())
}

/// True when the tools already there were written by this same build.
fn is_current(dir: &Path) -> bool {
    std::fs::read_to_string(dir.join(MARKER))
        .map(|v| v.trim() == env!("CARGO_PKG_VERSION"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_carries_the_tools_a_report_needs() {
        let names: Vec<String> = Tools::iter().map(|n| n.to_string()).collect();
        for needed in ["build.py", "selftest.py", "blocks.py", "page.css", "page.js"] {
            assert!(
                names.iter().any(|n| n == needed),
                "{needed} is not in this build; the tools it carries are {names:?}"
            );
        }
    }

    #[test]
    fn nothing_a_python_run_left_behind_is_carried() {
        for name in Tools::iter() {
            assert!(
                !name.contains("__pycache__"),
                "{name} is a leftover of running the tools, not one of them"
            );
        }
    }

    #[test]
    fn tools_written_by_this_build_are_not_written_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        assert!(!is_current(dir.path()), "an empty folder cannot be current");
        std::fs::write(dir.path().join(MARKER), env!("CARGO_PKG_VERSION")).unwrap();
        assert!(is_current(dir.path()));
        std::fs::write(dir.path().join(MARKER), "0.0.0-older").unwrap();
        assert!(!is_current(dir.path()), "an older build's tools are replaced");
    }
}
