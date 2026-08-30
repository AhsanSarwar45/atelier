//! Safe discovery and reading of Claude/Codex configuration files.

use base64::Engine;
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 2_000;
const MAX_READ: u64 = 2 * 1024 * 1024;
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

fn locations(project: Option<&Path>, home: &Path, claude: &Path, codex: &Path) -> Vec<Location> {
    let loc = |provider, scope, category, root: PathBuf, files, legacy| Location {
        provider,
        scope,
        category,
        root,
        files,
        legacy,
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
            below(&claude.join("skills"), None),
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
        loc(
            Provider::Codex,
            Scope::Personal,
            Category::Skills,
            home.join(".agents/skills"),
            below(&home.join(".agents/skills"), None),
            false,
        ),
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
            Category::Agents,
            project.join(".codex/agents"),
            below(&project.join(".codex/agents"), Some(&["toml"])),
            false,
        ),
        loc(
            Provider::Codex,
            Scope::Project,
            Category::Skills,
            project.join(".agents/skills"),
            below(&project.join(".agents/skills"), None),
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
        rows.push(loc(
            Provider::Claude,
            Scope::Project,
            category,
            root.clone(),
            below(&root, extensions),
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
    let claude = claude_config
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".claude"));
    let codex = codex_home
        .map(Path::to_path_buf)
        .unwrap_or_else(|| home.join(".codex"));
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
            files.push(AgentFile {
                id: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_id),
                provider: location.provider,
                scope: location.scope,
                category: location.category,
                name: path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                path: path.clone(),
                relative_path: path
                    .strip_prefix(&location.root)
                    .unwrap_or(&path)
                    .to_path_buf(),
                format: format_of(&path),
                legacy: location.legacy,
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
        assert!(files
            .iter()
            .any(|f| f.name == "SKILL.md" && f.provider == Provider::Codex));
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
}
