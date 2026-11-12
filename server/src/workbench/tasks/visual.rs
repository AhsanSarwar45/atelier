//! The safety net under `feature` and `bug`: work whose commits change files
//! that show on screen must come with screenshots (docs/tasks.md, "Visual
//! files"). Which files those are is the project's `[tasks] visual_files`,
//! else `DEFAULT_VISUAL_FILES`. Tests never count.

use globset::{GlobBuilder, GlobMatcher};
use std::path::Path;

/// Interface files and shaders.
pub const DEFAULT_VISUAL_FILES: &[&str] = &[
    ".tsx", ".jsx", ".css", ".scss", ".html", ".vue", ".svelte",
    ".wgsl", ".glsl", ".hlsl", ".frag", ".vert", ".comp", ".metal", ".slang",
];

/// One pattern: `.ext` is an extension, anything else a glob over the path
/// from the repository's root (`*` crosses folders).
enum Pattern {
    Extension(String),
    Glob(GlobMatcher),
}

fn compile(patterns: &[String]) -> Vec<Pattern> {
    patterns
        .iter()
        .map(|pattern| pattern.trim())
        .filter(|pattern| !pattern.is_empty())
        .filter_map(|pattern| {
            if pattern.starts_with('.') && !pattern.contains(['/', '*', '?', '[', '{']) {
                return Some(Pattern::Extension(pattern.to_ascii_lowercase()));
            }
            GlobBuilder::new(pattern).case_insensitive(true).build().ok().map(|glob| Pattern::Glob(glob.compile_matcher()))
        })
        .collect()
}

/// A test, which shows nowhere: under `__tests__`, or named `*.test.*` or `*.spec.*`.
pub fn is_test_file(path: &str) -> bool {
    let mut parts = path.split('/');
    let name = parts.next_back().unwrap_or("");
    let mut folders = path.split('/');
    folders.next_back();
    folders.any(|folder| folder == "__tests__") || name.contains(".test.") || name.contains(".spec.")
}

/// The project's patterns, or the defaults when it gives none.
pub fn patterns(configured: &[String]) -> Vec<String> {
    if configured.iter().any(|pattern| !pattern.trim().is_empty()) {
        configured.to_vec()
    } else {
        DEFAULT_VISUAL_FILES.iter().map(|pattern| pattern.to_string()).collect()
    }
}

/// The changed files that show on screen, in the order given.
pub fn visual_files(changed: &[String], patterns: &[String]) -> Vec<String> {
    let compiled = compile(patterns);
    changed
        .iter()
        .filter(|path| !is_test_file(path))
        .filter(|path| {
            let lower = path.to_ascii_lowercase();
            compiled.iter().any(|pattern| match pattern {
                Pattern::Extension(extension) => lower.ends_with(extension.as_str()),
                Pattern::Glob(glob) => glob.is_match(path.as_str()),
            })
        })
        .cloned()
        .collect()
}

/// The project's `[tasks] visual_files`, read from its manifest; the
/// defaults when it has none.
pub fn project_patterns(project_folder: &Path) -> Vec<String> {
    let configured = crate::identity::data_dir()
        .and_then(|data| crate::project_manifest::locate(project_folder, &data))
        .map(|located| located.manifest.tasks.visual_files)
        .unwrap_or_default();
    patterns(&configured)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn interface_files_and_shaders_count_and_tests_do_not() {
        let changed = paths(&[
            "src/app/page.tsx", "src/styles.CSS", "shaders/sky.wgsl", "render/lit.frag", "src/lib/api.ts",
            "server/src/main.rs", "src/__tests__/page.tsx", "src/button.test.tsx", "e2e/flow.spec.jsx", "README.md",
        ]);
        assert_eq!(
            visual_files(&changed, &patterns(&[])),
            paths(&["src/app/page.tsx", "src/styles.CSS", "shaders/sky.wgsl", "render/lit.frag"])
        );
    }

    #[test]
    fn a_project_list_replaces_the_defaults_and_takes_globs() {
        let configured = paths(&[".rs", "assets/**/*.svg"]);
        let changed = paths(&["src/page.tsx", "server/src/ui.rs", "assets/icons/pin.svg", "docs/pin.svg"]);
        assert_eq!(visual_files(&changed, &patterns(&configured)), paths(&["server/src/ui.rs", "assets/icons/pin.svg"]));
        // A blank list is no list: the defaults stand.
        assert_eq!(patterns(&paths(&[" "])).len(), DEFAULT_VISUAL_FILES.len());
    }

    #[test]
    fn test_files_are_named_by_folder_or_by_name() {
        assert!(is_test_file("src/x/__tests__/card.tsx"));
        assert!(is_test_file("card.test.tsx"));
        assert!(is_test_file("tests/e2e/card.spec.ts"));
        assert!(!is_test_file("src/testing/card.tsx"));
        assert!(!is_test_file("src/__tests__.tsx"));
    }
}
