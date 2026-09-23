//! Safe discovery and reading of Claude/Codex configuration files.

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use super::provider_defaults::atomic_write;
use super::provider_settings::backup_of;

const MAX_FILES: usize = 2_000;
const MAX_READ: u64 = 2 * 1024 * 1024;
/// The largest file a write accepts; the same ceiling a read shows whole.
const MAX_WRITE: usize = 2 * 1024 * 1024;
const SKIP: &[&str] = &[".git", "node_modules", ".next", "target", "dist", "build"];

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    Claude,
    Codex,
}
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    Personal,
    Project,
    ProjectLocal,
}
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    Instructions,
    Settings,
    Agents,
    Commands,
    Skills,
    OutputStyles,
    Rules,
}

impl Provider {
    fn wire(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

impl Scope {
    fn wire(self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Project => "project",
            Self::ProjectLocal => "project-local",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFile {
    pub id: String,
    pub provider: Provider,
    pub scope: Scope,
    pub category: Category,
    pub name: String,
    pub path: PathBuf,
    pub relative_path: PathBuf,
    pub format: &'static str,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub legacy: bool,
    /// Personal rows only: the directory does not follow the chosen account.
    ///
    /// Every other personal row is under the account's own directory, so
    /// choosing another account shows that account's files. Codex's skills are
    /// under `$HOME/.agents`, which `CODEX_HOME` does not move — proven by
    /// asking the CLI itself, which reports the marketplace root from `HOME`
    /// alone — so every Codex account on the computer has the same ones. The
    /// screen said nothing about it and so read as per-account (bw-6ecp.15).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub shared: bool,
    pub size: u64,
    pub modified_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<PathBuf>,
}

struct Location {
    provider: Provider,
    scope: Scope,
    category: Category,
    root: PathBuf,
    files: Vec<PathBuf>,
    legacy: bool,
    /// The same directory whichever account is chosen.
    shared: bool,
}

fn format_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "md" => "markdown",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        _ => "text",
    }
}

fn existing(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|path| path.is_file()).collect()
}

fn below(root: &Path, extensions: Option<&[&str]>) -> Vec<PathBuf> {
    fn visit(
        dir: &Path,
        extensions: Option<&[&str]>,
        visited: &mut HashSet<PathBuf>,
        out: &mut Vec<PathBuf>,
    ) {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(real) = fs::canonicalize(dir) else {
            return;
        };
        if !visited.insert(real) {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if SKIP.contains(&entry.file_name().to_string_lossy().as_ref()) {
                continue;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() || (kind.is_symlink() && path.is_dir()) {
                visit(&path, extensions, visited, out);
            } else if (kind.is_file() || (kind.is_symlink() && path.is_file()))
                && extensions.is_none_or(|wanted| {
                    path.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|ext| {
                            wanted.iter().any(|wanted| {
                                ext.eq_ignore_ascii_case(wanted.trim_start_matches('.'))
                            })
                        })
                })
            {
                out.push(path);
            }
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    let mut out = Vec::new();
    visit(root, extensions, &mut HashSet::new(), &mut out);
    out
}

/// The directory a marketplace sync owns. Everything under it is rewritten
/// wholesale by the next sync, so it holds nothing a person edits here.
const SYNCED: &str = "synced";

/// One row per skill rather than one per file inside it.
///
/// A skill is a directory holding a `SKILL.md`; its references, scripts,
/// licence and manifest belong to that skill and are not separate things to
/// edit. Walking every file instead turned one machine's skills into two
/// hundred rows, most of them named `SKILL.md` or `__init__.py` (bw-xnvs.1).
fn skills(root: &Path) -> Vec<PathBuf> {
    fn visit(dir: &Path, visited: &mut HashSet<PathBuf>, out: &mut Vec<PathBuf>) {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(real) = fs::canonicalize(dir) else {
            return;
        };
        if !visited.insert(real) {
            return;
        }
        let manifest = dir.join("SKILL.md");
        if manifest.is_file() {
            out.push(manifest);
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut children: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && name != SYNCED && !SKIP.contains(&name.as_ref())
            })
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        children.sort();
        for child in children {
            visit(&child, visited, out);
            if out.len() >= MAX_FILES {
                return;
            }
        }
    }
    let mut out = Vec::new();
    visit(root, &mut HashSet::new(), &mut out);
    out
}

fn locations(project: Option<&Path>, home: &Path, claude: &Path, codex: &Path) -> Vec<Location> {
    let loc = |provider, scope, category, root: PathBuf, files, legacy| Location {
        provider,
        scope,
        category,
        root,
        files,
        legacy,
        shared: false,
    };
    let mut rows = vec![
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::Instructions,
            claude.into(),
            existing([claude.join("CLAUDE.md")]),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::Settings,
            claude.into(),
            existing([claude.join("settings.json")]),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::Rules,
            claude.join("rules"),
            below(&claude.join("rules"), Some(&["md"])),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::Agents,
            claude.join("agents"),
            below(&claude.join("agents"), Some(&["md"])),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::Commands,
            claude.join("commands"),
            below(&claude.join("commands"), Some(&["md"])),
            true,
        ),
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::Skills,
            claude.join("skills"),
            skills(&claude.join("skills")),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::Personal,
            Category::OutputStyles,
            claude.join("output-styles"),
            below(&claude.join("output-styles"), Some(&["md"])),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Personal,
            Category::Instructions,
            codex.into(),
            existing([codex.join("AGENTS.md"), codex.join("AGENTS.override.md")]),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Personal,
            Category::Settings,
            codex.into(),
            {
                let mut files = existing([codex.join("config.toml")]);
                files.extend(below(codex, Some(&["toml"])).into_iter().filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().ends_with(".config.toml"))
                }));
                files
            },
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Personal,
            Category::Settings,
            codex.into(),
            existing([codex.join("hooks.json")]),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Personal,
            Category::Agents,
            codex.join("agents"),
            below(&codex.join("agents"), Some(&["toml"])),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Personal,
            Category::Rules,
            codex.join("rules"),
            below(&codex.join("rules"), Some(&["rules"])),
            false,
        ),
        Location {
            shared: true,
            ..loc(
                Provider::Codex,
                Scope::Personal,
                Category::Skills,
                home.join(".agents/skills"),
                skills(&home.join(".agents/skills")),
                false,
            )
        },
    ];
    let Some(project) = project else { return rows };
    let project = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    rows.extend([
        loc(
            Provider::Claude,
            Scope::Project,
            Category::Instructions,
            project.clone(),
            existing([project.join("CLAUDE.md"), project.join(".claude/CLAUDE.md")]),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::ProjectLocal,
            Category::Instructions,
            project.clone(),
            existing([project.join("CLAUDE.local.md")]),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::Project,
            Category::Settings,
            project.join(".claude"),
            existing([project.join(".claude/settings.json")]),
            false,
        ),
        loc(
            Provider::Claude,
            Scope::ProjectLocal,
            Category::Settings,
            project.join(".claude"),
            existing([project.join(".claude/settings.local.json")]),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Instructions,
            project.clone(),
            below(&project, None)
                .into_iter()
                .filter(|p| {
                    matches!(
                        p.file_name().and_then(|n| n.to_str()),
                        Some("AGENTS.md" | "AGENTS.override.md")
                    )
                })
                .collect(),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Settings,
            project.join(".codex"),
            existing([project.join(".codex/config.toml")]),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Settings,
            project.join(".codex"),
            existing([project.join(".codex/hooks.json")]),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Agents,
            project.join(".codex/agents"),
            below(&project.join(".codex/agents"), Some(&["toml"])),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Rules,
            project.join(".codex/rules"),
            below(&project.join(".codex/rules"), Some(&["rules"])),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Skills,
            project.join(".agents/skills"),
            skills(&project.join(".agents/skills")),
            false,
        ),
    ]);
    for (name, category, extensions, legacy) in [
        ("rules", Category::Rules, Some(&["md"][..]), false),
        ("agents", Category::Agents, Some(&["md"][..]), false),
        ("commands", Category::Commands, Some(&["md"][..]), true),
        ("skills", Category::Skills, None, false),
        (
            "output-styles",
            Category::OutputStyles,
            Some(&["md"][..]),
            false,
        ),
    ] {
        let root = project.join(".claude").join(name);
        let files = match category {
            Category::Skills => skills(&root),
            _ => below(&root, extensions),
        };
        rows.push(loc(
            Provider::Claude,
            Scope::Project,
            category,
            root.clone(),
            files,
            legacy,
        ));
    }
    rows
}

pub fn discover(
    project: Option<&Path>,
    home: &Path,
    claude_config: Option<&Path>,
    codex_home: Option<&Path>,
) -> Vec<AgentFile> {
    let (claude, codex) = account_dirs(home, claude_config, codex_home);
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for location in locations(project, home, &claude, &codex) {
        for path in location.files {
            let absolute = path.clone();
            let key = (location.provider, location.scope, absolute.clone());
            if !seen.insert(key) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let link = fs::symlink_metadata(&path)
                .ok()
                .is_some_and(|m| m.file_type().is_symlink());
            let raw_id = format!(
                "{}\0{}\0{}",
                location.provider.wire(),
                location.scope.wire(),
                absolute.display()
            );
            // A skill is named and placed by its directory, not by the
            // `SKILL.md` every one of them holds (bw-xnvs.1).
            let named = match location.category {
                Category::Skills => path.parent().unwrap_or(&path),
                _ => &path,
            };
            files.push(AgentFile {
                id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_id),
                provider: location.provider,
                scope: location.scope,
                category: location.category,
                name: named
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.clone(),
                relative_path: named
                    .strip_prefix(&location.root)
                    .unwrap_or(named)
                    .to_path_buf(),
                format: format_of(&path),
                legacy: location.legacy,
                shared: location.shared,
                size: meta.len(),
                modified_at: DateTime::<Utc>::from(
                    meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                )
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                symlink_target: link
                    .then(|| fs::canonicalize(&path).unwrap_or_else(|_| path.clone())),
            });
        }
    }
    files.sort_by(|a, b| {
        (a.provider, a.scope, a.category, &a.relative_path).cmp(&(
            b.provider,
            b.scope,
            b.category,
            &b.relative_path,
        ))
    });
    files
}

pub fn read(
    path: &Path,
    project: Option<&Path>,
    home: &Path,
    claude: Option<&Path>,
    codex: Option<&Path>,
) -> Result<(String, bool), String> {
    let wanted = fs::canonicalize(path).map_err(|e| e.to_string())?;
    let allowed = discover(project, home, claude, codex)
        .into_iter()
        .any(|file| fs::canonicalize(file.path).ok().as_ref() == Some(&wanted));
    if !allowed {
        return Err("That file is not part of the discovered agent configuration".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let truncated = bytes.len() as u64 > MAX_READ;
    Ok((
        String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_READ as usize)]).into_owned(),
        truncated,
    ))
}

/// A well-known file that is not there yet but may be made: the one place a
/// person can start a new `CLAUDE.md` or `config.toml` from the app.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Creatable {
    pub provider: Provider,
    pub scope: Scope,
    pub category: Category,
    pub name: String,
    pub path: PathBuf,
    pub format: &'static str,
}

fn account_dirs(home: &Path, claude: Option<&Path>, codex: Option<&Path>) -> (PathBuf, PathBuf) {
    (
        claude
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".claude")),
        codex
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".codex")),
    )
}

/// The well-known files this scope could hold but does not yet.
pub fn creatable(
    project: Option<&Path>,
    home: &Path,
    claude_config: Option<&Path>,
    codex_home: Option<&Path>,
) -> Vec<Creatable> {
    let (claude, codex) = account_dirs(home, claude_config, codex_home);
    let mut rows = vec![
        (
            Provider::Claude,
            Scope::Personal,
            Category::Instructions,
            claude.join("CLAUDE.md"),
        ),
        (
            Provider::Claude,
            Scope::Personal,
            Category::Settings,
            claude.join("settings.json"),
        ),
        (
            Provider::Codex,
            Scope::Personal,
            Category::Instructions,
            codex.join("AGENTS.md"),
        ),
        (
            Provider::Codex,
            Scope::Personal,
            Category::Settings,
            codex.join("config.toml"),
        ),
    ];
    if let Some(project) = project {
        let project = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        rows.extend([
            (
                Provider::Claude,
                Scope::Project,
                Category::Instructions,
                project.join("CLAUDE.md"),
            ),
            (
                Provider::Claude,
                Scope::Project,
                Category::Settings,
                project.join(".claude/settings.json"),
            ),
            (
                Provider::Claude,
                Scope::ProjectLocal,
                Category::Settings,
                project.join(".claude/settings.local.json"),
            ),
            (
                Provider::Codex,
                Scope::Project,
                Category::Instructions,
                project.join("AGENTS.md"),
            ),
            (
                Provider::Codex,
                Scope::Project,
                Category::Settings,
                project.join(".codex/config.toml"),
            ),
        ]);
    }
    rows.into_iter()
        .filter(|(_, _, _, path)| !path.exists())
        .map(|(provider, scope, category, path)| Creatable {
            provider,
            scope,
            category,
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            format: format_of(&path),
            path,
        })
        .collect()
}

fn same_file(a: &Path, b: &Path) -> bool {
    a == b
        || match (fs::canonicalize(a), fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
}

/// Replace one discovered file, or make one of the well-known ones, keeping
/// the previous contents beside it as `.bak`. Anything outside what
/// `discover` and `creatable` name for this scope is refused.
pub fn write(
    path: &Path,
    content: &str,
    project: Option<&Path>,
    home: &Path,
    claude: Option<&Path>,
    codex: Option<&Path>,
) -> Result<u64, String> {
    if content.len() > MAX_WRITE {
        return Err("That file is over 2 MiB, which is more than this editor saves".into());
    }
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("That file is not part of the discovered agent configuration".into());
    }
    let allowed = discover(project, home, claude, codex)
        .into_iter()
        .any(|file| same_file(&file.path, path))
        || creatable(project, home, claude, codex)
            .into_iter()
            .any(|file| same_file(&file.path, path));
    if !allowed {
        return Err("That file is not part of the discovered agent configuration".into());
    }
    if path.is_file() {
        fs::copy(path, backup_of(path))
            .map_err(|error| format!("{} could not be backed up: {error}", path.display()))?;
    }
    atomic_write(path, content.as_bytes())?;
    Ok(content.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_workbench_services_metadata_discovers_and_guards_agent_files() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude/commands")).unwrap();
        fs::create_dir_all(home.path().join(".agents/skills/shared")).unwrap();
        fs::create_dir_all(project.path().join(".codex/agents")).unwrap();
        fs::write(home.path().join(".claude/CLAUDE.md"), "hello").unwrap();
        fs::write(home.path().join(".claude/commands/old.md"), "old").unwrap();
        fs::write(home.path().join(".agents/skills/shared/SKILL.md"), "skill").unwrap();
        fs::write(
            project.path().join(".codex/agents/reviewer.toml"),
            "name='review'",
        )
        .unwrap();
        fs::write(project.path().join("package.json"), "{}").unwrap();
        let files = discover(Some(project.path()), home.path(), None, None);
        assert!(files.iter().any(|f| f.name == "old.md" && f.legacy));
        // A skill is one row, named for the skill.
        assert!(files
            .iter()
            .any(|f| f.name == "shared" && f.provider == Provider::Codex));
        // Codex's personal skills are under `$HOME/.agents`, which CODEX_HOME
        // does not move, so they are the same for every Codex account and are
        // marked as such. Everything else personal follows the account and is
        // not (bw-6ecp.15).
        assert!(files
            .iter()
            .any(|f| f.name == "shared" && f.provider == Provider::Codex && f.shared));
        assert!(files
            .iter()
            .filter(|f| f.name != "shared")
            .all(|f| !f.shared));
        let agent = project.path().join(".codex/agents/reviewer.toml");
        assert_eq!(
            read(&agent, Some(project.path()), home.path(), None, None).unwrap(),
            ("name='review'".into(), false)
        );
        assert!(read(
            &project.path().join("package.json"),
            Some(project.path()),
            home.path(),
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn native_workbench_services_agent_files_lists_a_skill_once_not_every_file_in_it() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/skills");
        // A hand-written skill, with the assets a real one carries.
        fs::create_dir_all(root.join("external-review/scripts")).unwrap();
        fs::create_dir_all(root.join("external-review/references")).unwrap();
        fs::write(root.join("external-review/SKILL.md"), "review").unwrap();
        fs::write(root.join("external-review/LICENSE.txt"), "mit").unwrap();
        fs::write(root.join("external-review/scripts/run.py"), "pass").unwrap();
        fs::write(root.join("external-review/references/how.md"), "how").unwrap();
        // The marketplace's own copies, which the next sync rewrites.
        fs::create_dir_all(root.join("synced/1a600a93_b76bb31d/docx")).unwrap();
        fs::write(root.join("synced/1a600a93_b76bb31d/docx/SKILL.md"), "docx").unwrap();
        fs::write(root.join("synced/1a600a93_b76bb31d/manifest.json"), "{}").unwrap();
        fs::write(root.join("synced/.bucket-1a600a93_b76bb31d"), "").unwrap();
        // A directory that holds no SKILL.md is not a skill.
        fs::create_dir_all(root.join("report")).unwrap();

        let listed: Vec<_> = discover(None, home.path(), None, None)
            .into_iter()
            .filter(|f| f.category == Category::Skills && f.provider == Provider::Claude)
            .collect();
        assert_eq!(
            listed.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["external-review"]
        );
        let skill = &listed[0];
        assert_eq!(skill.path, root.join("external-review/SKILL.md"));
        // The row is named and placed by the skill, so the screen shows no
        // second line of path under a title reading `SKILL.md`.
        assert_eq!(skill.relative_path, Path::new("external-review"));
        // Nothing inside the marketplace tree is readable through the screen.
        for hidden in [
            root.join("synced/1a600a93_b76bb31d/docx/SKILL.md"),
            root.join("synced/1a600a93_b76bb31d/manifest.json"),
            root.join("external-review/LICENSE.txt"),
        ] {
            assert!(
                read(&hidden, None, home.path(), None, None).is_err(),
                "{}",
                hidden.display()
            );
        }
    }

    #[test]
    fn native_workbench_services_agent_files_write_stays_inside_the_allowlist() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".claude")).unwrap();
        fs::write(home.path().join(".claude/CLAUDE.md"), "hello").unwrap();
        fs::write(project.path().join("package.json"), "{}").unwrap();
        let claude_md = home.path().join(".claude/CLAUDE.md");
        assert_eq!(
            write(
                &claude_md,
                "hi",
                Some(project.path()),
                home.path(),
                None,
                None
            )
            .unwrap(),
            2
        );
        assert_eq!(fs::read_to_string(&claude_md).unwrap(), "hi");
        assert_eq!(fs::read_to_string(backup_of(&claude_md)).unwrap(), "hello");
        // Outside the allowlist: an ordinary project file, and a stranger.
        for path in [
            project.path().join("package.json"),
            project.path().join("notes.md"),
            project.path().join("../CLAUDE.md"),
        ] {
            assert!(
                write(&path, "x", Some(project.path()), home.path(), None, None).is_err(),
                "{}",
                path.display()
            );
        }
        assert!(!project.path().join("notes.md").exists());
        // A well-known file that is not there yet may be made, and then it
        // stops being listed as creatable.
        let listed = creatable(Some(project.path()), home.path(), None, None);
        let local = project.path().join(".claude/settings.local.json");
        assert!(listed
            .iter()
            .any(|c| c.path == local && c.scope == Scope::ProjectLocal));
        assert!(!listed.iter().any(|c| c.path == claude_md));
        write(
            &local,
            "{}\n",
            Some(project.path()),
            home.path(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&local).unwrap(), "{}\n");
        assert!(!backup_of(&local).exists());
        assert!(!creatable(Some(project.path()), home.path(), None, None)
            .iter()
            .any(|c| c.path == local));
        assert!(discover(Some(project.path()), home.path(), None, None)
            .iter()
            .any(|f| f.path == local));
        let big = "x".repeat(MAX_WRITE + 1);
        assert!(write(&local, &big, Some(project.path()), home.path(), None, None).is_err());
    }
}
