//! The tools that make a report, carried inside the product.
//!
//! Making a report is part of what this is for, so the tools travel in the
//! binary and are laid down next to the reports themselves the first time the
//! product runs. Nobody installs anything separately, and nothing looks for a
//! folder that only exists on the machine the copy was built on.
//!
//! When they are rewritten, and how a stale copy is noticed, is `laid_down`'s
//! business — the same rule the chat helper is laid down by.

use rust_embed::Embed;

/// The report toolchain as it stood when this copy was built.
#[derive(Embed)]
#[folder = "../reporting/tools/"]
#[exclude = "__pycache__/*"]
struct Tools;

/// Lay the tools down beside the reports, replacing an older or edited copy.
///
/// Returns what went wrong rather than stopping the program: a copy that
/// cannot write there still serves the board, and only reports suffer.
pub fn install() -> Result<(), String> {
    let Some(dir) = crate::identity::tools_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
    };
    let files = crate::laid_down::gather::<Tools>("")?;
    crate::laid_down::install(&dir, &files)
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
}
