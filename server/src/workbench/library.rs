//! Provider-independent instructions, skills and declarative applicability.
//! All readers (HTTP, session bootstrap, slash expansion, CLI and MCP) use this
//! resolver. Snapshots bind a skill and its resources to the same revision.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const MAX_TEXT: usize = 128 * 1024;
const MAX_LIBRARY: usize = 2 * 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Library {
    /// Plain global guidance; project baseline remains in instructions.md.
    #[serde(default)]
    pub general_instructions: String,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(default)]
    pub overrides: BTreeMap<String, Override>,
    /// None inherits; an empty string explicitly selects no shared style.
    #[serde(default)]
    pub output_style: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    #[serde(default)]
    pub description: String,
    pub content: String,
    #[serde(default)]
    pub when: Condition,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default = "yes")]
    pub automatic: bool,
    #[serde(default)]
    pub parameters: BTreeMap<String, String>,
    #[serde(default)]
    pub resources: BTreeMap<String, String>,
    #[serde(default)]
    pub bundle: String,
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Instruction,
    Skill,
    OutputStyle,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Override {
    #[serde(default)]
    pub disabled: bool,
    pub when: Option<Condition>,
    pub automatic: Option<bool>,
    pub content: Option<String>,
    #[serde(default)]
    pub parameters: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Condition {
    #[default]
    Always,
    All {
        conditions: Vec<Condition>,
    },
    Any {
        conditions: Vec<Condition>,
    },
    Not {
        condition: Box<Condition>,
    },
    FileExists {
        path: String,
    },
    FolderExists {
        path: String,
    },
    FileContains {
        path: String,
        text: String,
    },
    FileMatches {
        pattern: String,
    },
    FileRegex {
        path: String,
        pattern: String,
    },
    /// Evaluate the child relative to each matching file's parent. All child
    /// predicates bind to that same package, rather than unrelated packages.
    Within {
        pattern: String,
        condition: Box<Condition>,
    },
    JsonEquals {
        path: String,
        pointer: String,
        value: Value,
    },
    JsonExists {
        path: String,
        pointer: String,
    },
    TomlEquals {
        path: String,
        key: String,
        value: Value,
    },
    YamlEquals {
        path: String,
        pointer: String,
        value: Value,
    },
    Dependency {
        path: String,
        name: String,
    },
    ProjectBeads,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evaluation {
    pub matched: Option<bool>,
    pub reason: String,
    pub children: Vec<Evaluation>,
}
impl Evaluation {
    fn answer(matched: bool, reason: String) -> Self {
        Self {
            matched: Some(matched),
            reason,
            children: vec![],
        }
    }
    fn unknown(reason: String) -> Self {
        Self {
            matched: None,
            reason,
            children: vec![],
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Resolved {
    pub item: Item,
    pub source: String,
    pub customized: bool,
    pub state: String,
    pub evaluation: Evaluation,
    pub missing: Vec<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Snapshot {
    pub revision: String,
    pub items: Vec<Resolved>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn data_dir() -> Result<PathBuf, String> {
    crate::identity::data_dir().ok_or_else(|| "Atelier data directory unavailable".into())
}
fn safe_relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("Use a relative path inside the project or skill".into());
    }
    Ok(())
}
fn bounded_read(path: &Path, max: usize) -> Result<String, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut text = String::new();
    file.take(max as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    if text.len() > max {
        return Err(format!("{} exceeds the reading limit", path.display()));
    }
    Ok(text)
}
fn project_file(root: &Path, path: &str) -> Result<PathBuf, String> {
    safe_relative(path)?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let joined = root.join(path);
    // Resolve the nearest existing ancestor too: a missing file below an
    // escaping symlink is not an allowed "does not exist" result.
    let mut ancestor = joined.as_path();
    while !ancestor.exists() {
        ancestor = ancestor.parent().ok_or("Invalid project path")?;
    }
    if !fs::canonicalize(ancestor)
        .map_err(|e| e.to_string())?
        .starts_with(&root)
    {
        return Err("Condition path leaves the project".into());
    }
    Ok(joined)
}
impl Condition {
    fn validate(&self, depth: usize) -> Result<(), String> {
        if depth > 8 {
            return Err("Conditions may nest at most eight levels".into());
        }
        match self {
            Self::All { conditions } | Self::Any { conditions } => {
                if conditions.is_empty() || conditions.len() > 32 {
                    return Err("A group needs 1–32 conditions".into());
                }
                for c in conditions {
                    c.validate(depth + 1)?;
                }
            }
            Self::Not { condition } => condition.validate(depth + 1)?,
            Self::Within { pattern, condition } => {
                globset::Glob::new(pattern).map_err(|e| e.to_string())?;
                condition.validate(depth + 1)?;
            }
            Self::FileMatches { pattern } => {
                globset::Glob::new(pattern).map_err(|e| e.to_string())?;
            }
            Self::FileRegex { path, pattern } => {
                safe_relative(path)?;
                regex::RegexBuilder::new(pattern)
                    .size_limit(MAX_TEXT)
                    .build()
                    .map_err(|e| e.to_string())?;
            }
            Self::FileExists { path }
            | Self::FolderExists { path }
            | Self::FileContains { path, .. }
            | Self::JsonEquals { path, .. }
            | Self::JsonExists { path, .. }
            | Self::Dependency { path, .. }
            | Self::TomlEquals { path, .. }
            | Self::YamlEquals { path, .. } => safe_relative(path)?,
            _ => {}
        }
        Ok(())
    }
    pub fn evaluate(&self, root: Option<&Path>, beads: bool) -> Evaluation {
        match self {
            Self::Always => Evaluation::answer(true, "Always available".into()),
            Self::ProjectBeads if root.is_some() => Evaluation::answer(
                beads,
                if beads {
                    "Project uses Beads"
                } else {
                    "Project does not use Beads"
                }
                .into(),
            ),
            Self::All { conditions } | Self::Any { conditions } => {
                let children: Vec<_> = conditions.iter().map(|c| c.evaluate(root, beads)).collect();
                let all = matches!(self, Self::All { .. });
                let matched = if children.iter().any(|c| c.matched == Some(!all)) {
                    Some(!all)
                } else if children.iter().any(|c| c.matched.is_none()) {
                    None
                } else {
                    Some(all)
                };
                Evaluation {
                    matched,
                    reason: if all {
                        "All conditions"
                    } else {
                        "Any condition"
                    }
                    .into(),
                    children,
                }
            }
            Self::Not { condition } => {
                let child = condition.evaluate(root, beads);
                Evaluation {
                    matched: child.matched.map(|m| !m),
                    reason: "Not".into(),
                    children: vec![child],
                }
            }
            Self::FileMatches { pattern } | Self::Within { pattern, .. } => {
                let Some(root) = root else {
                    return Evaluation::unknown(
                        "Choose a project to evaluate matching files".into(),
                    );
                };
                let matcher = match globset::Glob::new(pattern) {
                    Ok(g) => g.compile_matcher(),
                    Err(e) => return Evaluation::unknown(e.to_string()),
                };
                let walk = ignore::WalkBuilder::new(root)
                    .follow_links(false)
                    .filter_entry(|e| {
                        !["node_modules", ".git", "target"]
                            .iter()
                            .any(|name| e.file_name() == *name)
                    })
                    .build();
                let mut children = vec![];
                for (index, entry) in walk.enumerate() {
                    if index > 10_000 {
                        children.push(Evaluation::unknown(
                            "File scan limit reached; narrow the project or use an exact path"
                                .into(),
                        ));
                        break;
                    }
                    let entry = match entry {
                        Ok(e) => e,
                        Err(e) => {
                            children.push(Evaluation::unknown(e.to_string()));
                            continue;
                        }
                    };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        continue;
                    }
                    if !matcher.is_match(entry.path().strip_prefix(root).unwrap_or(entry.path())) {
                        continue;
                    }
                    let evaluation = match self {
                        Self::Within { condition, .. } => {
                            condition.evaluate(entry.path().parent(), beads)
                        }
                        _ => Evaluation::answer(
                            true,
                            format!("{} matches {pattern}", entry.path().display()),
                        ),
                    };
                    let matched = evaluation.matched;
                    children.push(Evaluation {
                        reason: entry
                            .path()
                            .strip_prefix(root)
                            .unwrap_or(entry.path())
                            .display()
                            .to_string(),
                        matched,
                        children: vec![evaluation],
                    });
                    if matched == Some(true) {
                        return Evaluation {
                            matched: Some(true),
                            reason: format!("A matching file satisfies {pattern}"),
                            children,
                        };
                    }
                    if children.len() > 100 {
                        children.push(Evaluation::unknown(
                            "Too many matches; narrow the pattern".into(),
                        ));
                        break;
                    }
                }
                Evaluation {
                    matched: if children.iter().any(|c| c.matched.is_none()) {
                        None
                    } else {
                        Some(false)
                    },
                    reason: format!("Any file matching {pattern}"),
                    children,
                }
            }
            _ => {
                let Some(root) = root else {
                    return Evaluation::unknown(
                        "Choose a project to evaluate this condition".into(),
                    );
                };
                let result = (|| -> Result<(bool, String), String> {
                    let (path, mode) = match self {
                        Self::FileExists { path } => (path, "file"),
                        Self::FolderExists { path } => (path, "folder"),
                        Self::FileContains { path, .. }
                        | Self::FileRegex { path, .. }
                        | Self::JsonEquals { path, .. }
                        | Self::JsonExists { path, .. }
                        | Self::TomlEquals { path, .. }
                        | Self::YamlEquals { path, .. }
                        | Self::Dependency { path, .. } => (path, "content"),
                        _ => return Err("Unsupported condition".into()),
                    };
                    let file = project_file(root, path)?;
                    let metadata = match fs::metadata(&file) {
                        Ok(m) => Some(m),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                        Err(e) => return Err(format!("{path}: {e}")),
                    };
                    if mode != "content" {
                        let found = metadata.is_some_and(|m| {
                            if mode == "file" {
                                m.is_file()
                            } else {
                                m.is_dir()
                            }
                        });
                        return Ok((
                            found,
                            format!("{mode} {path}: {}", if found { "exists" } else { "absent" }),
                        ));
                    }
                    if metadata.is_none() {
                        return Ok((false, format!("{path} is absent")));
                    }
                    let text = bounded_read(&file, MAX_TEXT)?;
                    if let Self::FileContains { text: needle, .. } = self {
                        return Ok((
                            text.contains(needle),
                            format!("{path} contains the specified text"),
                        ));
                    }
                    if let Self::FileRegex { pattern, .. } = self {
                        let regex = regex::RegexBuilder::new(pattern)
                            .size_limit(MAX_TEXT)
                            .build()
                            .map_err(|e| e.to_string())?;
                        return Ok((
                            regex.is_match(&text),
                            format!("{path} matches the regular expression"),
                        ));
                    }
                    let value: Value = match self {
                        Self::TomlEquals { .. } => serde_json::to_value(
                            toml::from_str::<toml::Value>(&text)
                                .map_err(|e| format!("Invalid TOML in {path}: {e}"))?,
                        )
                        .map_err(|e| e.to_string())?,
                        Self::YamlEquals { .. } => serde_yaml::from_str(&text)
                            .map_err(|e| format!("Invalid YAML in {path}: {e}"))?,
                        _ => serde_json::from_str(&text)
                            .map_err(|e| format!("Invalid JSON in {path}: {e}"))?,
                    };
                    match self {
                        Self::Dependency { name, .. } => Ok((
                            [
                                "dependencies",
                                "devDependencies",
                                "peerDependencies",
                                "optionalDependencies",
                            ]
                            .iter()
                            .any(|key| value[*key].get(name).is_some()),
                            format!("{path} declares dependency {name}"),
                        )),
                        Self::JsonEquals {
                            pointer,
                            value: expected,
                            ..
                        }
                        | Self::YamlEquals {
                            pointer,
                            value: expected,
                            ..
                        } => Ok((
                            value.pointer(pointer) == Some(expected),
                            format!("{path} value at {pointer} equals {expected}"),
                        )),
                        Self::JsonExists { pointer, .. } => Ok((
                            value.pointer(pointer).is_some(),
                            format!("{path} has value at {pointer}"),
                        )),
                        Self::TomlEquals {
                            key,
                            value: expected,
                            ..
                        } => Ok((
                            key.split('.').try_fold(&value, |v, k| v.get(k)) == Some(expected),
                            format!("{path} value at {key} equals {expected}"),
                        )),
                        _ => unreachable!(),
                    }
                })();
                match result {
                    Ok((matched, why)) => Evaluation::answer(matched, why),
                    Err(why) => Evaluation::unknown(why),
                }
            }
        }
    }
}

pub fn validate(library: &Library, project: bool) -> Result<(), String> {
    if library.general_instructions.len() > MAX_TEXT {
        return Err("Keep general instructions below 128 KiB".into());
    }
    if project && !library.general_instructions.is_empty() {
        return Err("Project general instructions belong in project settings".into());
    }
    if library.items.len() > 200 || library.overrides.len() > 200 {
        return Err("A library supports at most 200 items and overrides".into());
    }
    if !project && !library.overrides.is_empty() {
        return Err("Overrides belong to projects".into());
    }
    let mut ids = std::collections::HashSet::new();
    for item in &library.items {
        if !valid_id(&item.id) || item.id.starts_with("atelier-") || !ids.insert(&item.id) {
            return Err(
                "Use a unique lowercase ID (letters, digits, hyphens); atelier- is reserved".into(),
            );
        }
        if item.name.trim().is_empty()
            || item.name.len() > 160
            || item.description.len() > 2000
            || item.content.len() > MAX_TEXT
        {
            return Err("Provide a name; keep content below 128 KiB".into());
        }
        item.when.validate(0)?;
        for key in item.resources.keys() {
            safe_relative(key)?;
        }
        if item.resources.values().any(|v| v.len() > MAX_TEXT) {
            return Err("Each resource must be below 128 KiB".into());
        }
        for tool in &item.requires {
            if !valid_id(tool) {
                return Err("Requirements must be executable names, not shell commands".into());
            }
        }
        for key in item.parameters.keys() {
            if !valid_id(key) {
                return Err("Parameter names use lowercase letters, digits and hyphens".into());
            }
        }
    }
    for (id, over) in &library.overrides {
        if !valid_id(id) || id.starts_with("atelier-") {
            return Err("Built-in application guidance cannot be overridden".into());
        }
        if let Some(condition) = &over.when {
            condition.validate(0)?;
        }
        if over
            .content
            .as_ref()
            .is_some_and(|text| text.len() > MAX_TEXT)
        {
            return Err("Content replacement exceeds 128 KiB".into());
        }
    }
    if serde_json::to_vec_pretty(library)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_LIBRARY
    {
        return Err("Library exceeds 2 MiB".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(id: &str, kind: Kind, content: &str) -> Item {
        Item {
            id: id.into(),
            name: id.into(),
            kind,
            content: content.into(),
            description: "Use for testing".into(),
            when: Condition::Always,
            requires: vec![],
            automatic: true,
            parameters: BTreeMap::new(),
            resources: BTreeMap::new(),
            bundle: String::new(),
        }
    }
    fn fixture() -> (tempfile::TempDir, tempfile::TempDir) {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        crate::project_manifest::create(
            root.path(),
            data.path(),
            crate::project_manifest::ManifestStorage::Personal,
            &crate::project_manifest::infer_virtual("Library test"),
        )
        .unwrap();
        (data, root)
    }
    fn save(data: &Path, root: Option<&Path>, lib: &Library) {
        write(data, root, lib, &revision(&read(data, root).unwrap())).unwrap();
    }
    #[test]
    fn plain_global_instructions_are_optional_inherited_and_pinned() {
        let (data, root) = fixture();
        let old: Library = serde_json::from_str(r#"{"items":[],"overrides":{}}"#).unwrap();
        assert!(old.general_instructions.is_empty());
        let mut library = Library { general_instructions: "Global guidance 日本語".into(), ..Default::default() };
        save(data.path(), None, &library);
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        assert!(snap.guidance().contains("Global guidance 日本語"));
        assert_eq!(snap.items.iter().filter(|row| row.item.id == "atelier-general-instructions").count(), 1);
        assert!(validate(&library, true).is_err());
        library.general_instructions.clear();
        save(data.path(), None, &library);
        assert!(!resolve(data.path(), Some(root.path())).unwrap().guidance().contains("Global guidance 日本語"));
        assert!(snap.guidance().contains("Global guidance 日本語"));
        library.general_instructions = "x".repeat(MAX_TEXT + 1);
        assert!(validate(&library, false).is_err());
    }
    #[test]
    fn size_limit_measures_the_format_that_is_written_and_read() {
        let mut library = Library { items: vec![item("large", Kind::Skill, "Read me")], ..Default::default() };
        let spare = MAX_LIBRARY - serde_json::to_vec(&library).unwrap().len();
        library.items[0].bundle = "x".repeat(spare);
        assert_eq!(serde_json::to_vec(&library).unwrap().len(), MAX_LIBRARY);
        assert!(serde_json::to_vec_pretty(&library).unwrap().len() > MAX_LIBRARY);
        assert!(validate(&library, false).unwrap_err().contains("2 MiB"));
    }
    #[test]
    fn every_condition_operator_has_positive_negative_and_missing_data_cases() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/index.ts"), "export const answer = 42;\n").unwrap();
        fs::write(root.path().join("package.json"), r#"{"dependencies":{"next":"16"},"scripts":{"test":"vitest"},"private":true}"#).unwrap();
        fs::write(root.path().join("Cargo.toml"), "[package]\nname = 'demo'\n").unwrap();
        fs::write(root.path().join("config.yaml"), "build:\n  enabled: true\n").unwrap();
        let cases = [
            (Condition::Always, true),
            (Condition::FileExists { path: "src/index.ts".into() }, true),
            (Condition::FileExists { path: "src".into() }, false),
            (Condition::FolderExists { path: "src".into() }, true),
            (Condition::FolderExists { path: "src/index.ts".into() }, false),
            (Condition::FileContains { path: "src/index.ts".into(), text: "answer = 42".into() }, true),
            (Condition::FileContains { path: "src/index.ts".into(), text: "answer = 43".into() }, false),
            (Condition::FileRegex { path: "src/index.ts".into(), pattern: r"answer\s*=\s*\d+".into() }, true),
            (Condition::FileRegex { path: "src/index.ts".into(), pattern: "^no-match$".into() }, false),
            (Condition::FileMatches { pattern: "src/*.ts".into() }, true),
            (Condition::FileMatches { pattern: "src/*.rs".into() }, false),
            (Condition::Dependency { path: "package.json".into(), name: "next".into() }, true),
            (Condition::Dependency { path: "package.json".into(), name: "react".into() }, false),
            (Condition::JsonExists { path: "package.json".into(), pointer: "/scripts/test".into() }, true),
            (Condition::JsonExists { path: "package.json".into(), pointer: "/scripts/absent".into() }, false),
            (Condition::JsonEquals { path: "package.json".into(), pointer: "/private".into(), value: json!(true) }, true),
            (Condition::JsonEquals { path: "package.json".into(), pointer: "/private".into(), value: json!("true") }, false),
            (Condition::TomlEquals { path: "Cargo.toml".into(), key: "package.name".into(), value: json!("demo") }, true),
            (Condition::TomlEquals { path: "Cargo.toml".into(), key: "package.name".into(), value: json!("other") }, false),
            (Condition::YamlEquals { path: "config.yaml".into(), pointer: "/build/enabled".into(), value: json!(true) }, true),
            (Condition::YamlEquals { path: "config.yaml".into(), pointer: "/build/enabled".into(), value: json!(false) }, false),
            (Condition::JsonExists { path: "missing.json".into(), pointer: "/a".into() }, false),
            (Condition::Not { condition: Box::new(Condition::FileExists { path: "missing".into() }) }, true),
            (Condition::All { conditions: vec![Condition::Always, Condition::ProjectBeads] }, true),
            (Condition::Any { conditions: vec![Condition::FileExists { path: "missing".into() }, Condition::Always] }, true),
            (Condition::ProjectBeads, true),
        ];
        for (condition, expected) in cases {
            condition.validate(0).unwrap();
            assert_eq!(condition.evaluate(Some(root.path()), true).matched, Some(expected), "{condition:?}");
        }
        assert_eq!(Condition::ProjectBeads.evaluate(Some(root.path()), false).matched, Some(false));
        for condition in [
            Condition::JsonExists { path: "src/index.ts".into(), pointer: "/x".into() },
            Condition::TomlEquals { path: "src/index.ts".into(), key: "x".into(), value: json!(1) },
            Condition::YamlEquals { path: "src".into(), pointer: "/x".into(), value: json!(1) },
        ] {
            assert_eq!(condition.evaluate(Some(root.path()), false).matched, None);
            assert_eq!(Condition::Not { condition: Box::new(condition) }.evaluate(Some(root.path()), false).matched, None);
        }
    }

    #[test]
    fn projects_do_not_share_overrides_styles_or_private_skills() {
        let data = tempfile::tempdir().unwrap();
        let roots = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
        for root in &roots { crate::project_manifest::create(root.path(), data.path(), crate::project_manifest::ManifestStorage::Personal, &crate::project_manifest::infer_virtual("Isolation")).unwrap(); }
        let global = Library { items: vec![item("common", Kind::Skill, "global"), item("style", Kind::OutputStyle, "GLOBAL STYLE")], output_style: Some("style".into()), ..Default::default() };
        save(data.path(), None, &global);
        let mut alpha = Library { items: vec![item("alpha-only", Kind::Skill, "ALPHA SECRET")], output_style: Some(String::new()), ..Default::default() };
        alpha.overrides.insert("common".into(), Override { content: Some("alpha".into()), ..Default::default() });
        save(data.path(), Some(roots[0].path()), &alpha);
        let a = resolve(data.path(), Some(roots[0].path())).unwrap();
        let b = resolve(data.path(), Some(roots[1].path())).unwrap();
        assert_eq!(a.read_skill("common", None).unwrap(), "alpha");
        assert_eq!(b.read_skill("common", None).unwrap(), "global");
        assert!(b.read_skill("alpha-only", None).is_err());
        assert!(!a.guidance().contains("GLOBAL STYLE"));
        assert!(b.guidance().contains("GLOBAL STYLE"));
        assert_ne!(a.revision, b.revision);
    }

    #[test]
    fn manual_skills_are_invocable_but_not_advertised_and_substitution_is_literal() {
        let (data, root) = fixture();
        let mut manual = item("manual", Kind::Skill, "{{one}} {{unknown}}");
        manual.automatic = false;
        manual.description = "MANUAL TRIGGER".into();
        manual.parameters.insert("one".into(), "{{two}} $(touch should-not-exist)".into());
        manual.parameters.insert("two".into(), "MUST NOT EXPAND".into());
        manual.resources.insert("references/deep/check.md".into(), "Unicode: 日本語 🧪 {{one}}".into());
        save(data.path(), None, &Library { items: vec![manual], ..Default::default() });
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        assert!(!snap.guidance().contains("MANUAL TRIGGER"));
        assert_eq!(snap.commands()[0]["name"], "skill:manual");
        let expanded = snap.expand("/skill:manual `literal`\nsecond line").unwrap().unwrap();
        assert!(expanded.contains("{{two}} $(touch should-not-exist) {{unknown}}"));
        assert!(expanded.contains("`literal`\nsecond line"));
        assert!(!expanded.contains("MUST NOT EXPAND"));
        assert!(snap.read_skill("manual", Some("references/deep/check.md")).unwrap().contains("日本語 🧪"));
        assert!(snap.expand("/skill:missing").is_err());
        assert!(snap.expand("/native-command").unwrap().is_none());
        assert!(snap.read_skill("manual", Some("../check.md")).is_err());
    }
    #[test]
    fn global_project_and_style_resolve_without_merging_content() {
        let (data, root) = fixture();
        let mut global = Library::default();
        global.items = vec![
            item("review", Kind::Skill, "Run {{test-command}}"),
            item("brief", Kind::OutputStyle, "Be brief"),
            item("long", Kind::OutputStyle, "Explain in depth"),
        ];
        global.items[0]
            .parameters
            .insert("test-command".into(), "npm test".into());
        global.output_style = Some("brief".into());
        save(data.path(), None, &global);
        let mut local = Library::default();
        local.output_style = Some("long".into());
        local.overrides.insert(
            "review".into(),
            Override {
                parameters: BTreeMap::from([("test-command".into(), "cargo test".into())]),
                ..Default::default()
            },
        );
        save(data.path(), Some(root.path()), &local);
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        assert_eq!(snap.read_skill("review", None).unwrap(), "Run cargo test");
        assert!(snap.guidance().contains("Explain in depth"));
        assert!(!snap.guidance().contains("Be brief"));
        assert!(
            !snap.guidance().contains("Run cargo test"),
            "skill bodies must be lazy"
        );
        global.items[0].content = "First inspect, then run {{test-command}}".into();
        save(data.path(), None, &global);
        assert_eq!(
            resolve(data.path(), Some(root.path()))
                .unwrap()
                .read_skill("review", None)
                .unwrap(),
            "First inspect, then run cargo test"
        );
    }
    #[test]
    fn condition_errors_remain_unknown_under_negation_and_groups() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("package.json"), "broken").unwrap();
        let dependency = Condition::Dependency {
            path: "package.json".into(),
            name: "next".into(),
        };
        let not = Condition::Not {
            condition: Box::new(dependency.clone()),
        };
        assert_eq!(not.evaluate(Some(root.path()), false).matched, None);
        assert_eq!(
            Condition::All {
                conditions: vec![Condition::Always, not]
            }
            .evaluate(Some(root.path()), false)
            .matched,
            None
        );
        fs::write(
            root.path().join("package.json"),
            r#"{"devDependencies":{"next":"1"}}"#,
        )
        .unwrap();
        assert_eq!(
            dependency.evaluate(Some(root.path()), false).matched,
            Some(true)
        );
        assert!(Condition::FileExists {
            path: "../outside".into()
        }
        .validate(0)
        .is_err());
    }
    #[test]
    fn disabled_or_inapplicable_replacements_do_not_fall_back_to_global() {
        let (data, root) = fixture();
        let mut global = Library::default();
        global.items.push(item("review", Kind::Skill, "global"));
        save(data.path(), None, &global);
        let mut local = Library::default();
        local.overrides.insert(
            "review".into(),
            Override {
                content: Some("local".into()),
                when: Some(Condition::FileExists {
                    path: "absent.txt".into(),
                }),
                ..Default::default()
            },
        );
        save(data.path(), Some(root.path()), &local);
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        assert!(snap.expand("/skill:review").is_err());
        assert!(snap.commands().is_empty());
    }
    #[test]
    fn snapshots_preserve_content_and_resources_and_reject_stale_writes() {
        let (data, root) = fixture();
        let mut lib = Library::default();
        let mut skill = item("review", Kind::Skill, "version one");
        skill
            .resources
            .insert("notes/guide.md".into(), "resource one".into());
        lib.items.push(skill);
        let old = revision(&lib);
        save(data.path(), None, &lib);
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        snap.persist(data.path()).unwrap();
        lib.items[0].content = "version two".into();
        save(data.path(), None, &lib);
        assert!(write(data.path(), None, &Library::default(), &old).is_err());
        let pinned = load_snapshot(data.path(), &snap.revision).unwrap();
        assert!(pinned
            .expand("/skill:review focus tests")
            .unwrap()
            .unwrap()
            .contains("version one"));
        assert_eq!(
            pinned.read_skill("review", Some("notes/guide.md")).unwrap(),
            "resource one"
        );
        assert!(pinned
            .read_skill("review", Some("../../library.json"))
            .is_err());
        assert!(load_snapshot(data.path(), "../../library").is_err());
    }
    #[test]
    fn requirements_and_applicability_are_separate() {
        let (data, root) = fixture();
        let mut lib = Library::default();
        let mut skill = item("testing", Kind::Skill, "test");
        skill
            .requires
            .push("atelier-nonexistent-test-executable".into());
        lib.items.push(skill);
        save(data.path(), None, &lib);
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        let row = snap.items.iter().find(|r| r.item.id == "testing").unwrap();
        assert_eq!(row.evaluation.matched, Some(true));
        assert_eq!(row.state, "unavailable");
        assert!(snap.read_skill("testing", None).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn conditions_refuse_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("escape")).unwrap();
        assert_eq!(
            Condition::FileExists {
                path: "escape/missing".into()
            }
            .evaluate(Some(root.path()), false)
            .matched,
            None
        );
    }
    #[test]
    fn monorepo_group_binds_conditions_to_one_package() {
        let root = tempfile::tempdir().unwrap();
        for (folder, dependency) in [("web", "react"), ("api", "vitest")] {
            fs::create_dir(root.path().join(folder)).unwrap();
            fs::write(
                root.path().join(folder).join("package.json"),
                json!({"dependencies":{dependency:"1"}}).to_string(),
            )
            .unwrap();
        }
        let condition = Condition::Within {
            pattern: "**/package.json".into(),
            condition: Box::new(Condition::All {
                conditions: ["react", "vitest"]
                    .into_iter()
                    .map(|name| Condition::Dependency {
                        path: "package.json".into(),
                        name: name.into(),
                    })
                    .collect(),
            }),
        };
        assert_eq!(
            condition.evaluate(Some(root.path()), false).matched,
            Some(false)
        );
        fs::write(
            root.path().join("web/package.json"),
            r#"{"dependencies":{"react":"1","vitest":"1"}}"#,
        )
        .unwrap();
        assert_eq!(
            condition.evaluate(Some(root.path()), false).matched,
            Some(true)
        );
    }
    #[test]
    fn a_new_global_id_conflict_disables_only_the_ambiguous_item() {
        let (data, root) = fixture();
        let mut local = Library::default();
        local.items.push(item("review", Kind::Skill, "project"));
        save(data.path(), Some(root.path()), &local);
        let mut global = Library::default();
        global.items.push(item("review", Kind::Skill, "global"));
        global.items.push(item("other", Kind::Skill, "unrelated"));
        save(data.path(), None, &global);
        let snap = resolve(data.path(), Some(root.path())).unwrap();
        assert_eq!(
            snap.items
                .iter()
                .find(|r| r.item.id == "review")
                .unwrap()
                .state,
            "conflict"
        );
        assert!(snap.read_skill("review", None).is_err());
        assert_eq!(snap.read_skill("other", None).unwrap(), "unrelated");
    }

    #[test]
    fn moving_project_settings_carries_the_shared_library() {
        let (data, root) = fixture();
        let mut local = Library::default();
        local.items.push(item("review", Kind::Skill, "project"));
        save(data.path(), Some(root.path()), &local);
        crate::project_manifest::move_to(
            root.path(),
            data.path(),
            crate::project_manifest::ManifestStorage::Repository,
        )
        .unwrap();
        assert_eq!(
            read(data.path(), Some(root.path())).unwrap().items[0].content,
            "project"
        );
        crate::project_manifest::move_to(
            root.path(),
            data.path(),
            crate::project_manifest::ManifestStorage::Personal,
        )
        .unwrap();
        assert_eq!(
            read(data.path(), Some(root.path())).unwrap().items[0].content,
            "project"
        );
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
fn library_path(data: &Path, root: Option<&Path>) -> Result<PathBuf, String> {
    match root {
        None => Ok(data.join("library.json")),
        Some(root) => {
            let manifest = crate::project_manifest::locate(root, data)
                .ok_or("Register this project before editing its library")?;
            Ok(manifest.path.with_file_name("library.json"))
        }
    }
}
fn read_path(path: &Path) -> Result<Library, String> {
    if !path.exists() {
        return Ok(Library::default());
    }
    serde_json::from_str(&bounded_read(path, MAX_LIBRARY)?)
        .map_err(|e| format!("{}: {e}", path.display()))
}
pub fn read(data: &Path, root: Option<&Path>) -> Result<Library, String> {
    read_path(&library_path(data, root)?)
}
pub fn revision(library: &Library) -> String {
    digest(&serde_json::to_vec(library).expect("serializable library"))
}
pub fn write(
    data: &Path,
    root: Option<&Path>,
    library: &Library,
    expected: &str,
) -> Result<(), String> {
    write_with_source(data, root, library, expected, None)
}

pub fn write_with_source(
    data: &Path,
    root: Option<&Path>,
    library: &Library,
    expected: &str,
    source_revision: Option<&str>,
) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    if let Some(expected) = source_revision.filter(|_| root.is_some()) {
        if revision(&read(data, None)?) != expected {
            return Err("Global library changed in another editor. Reload before customizing it.".into());
        }
    }
    validate(library, root.is_some())?;
    let path = library_path(data, root)?;
    if revision(&read_path(&path)?) != expected {
        return Err("Library changed in another editor. Reload before saving.".into());
    }
    super::provider_defaults::atomic_write(
        &path,
        &serde_json::to_vec_pretty(library).map_err(|e| e.to_string())?,
    )
}

fn builtins() -> Vec<Item> {
    [
        (
            "atelier-presentation",
            "Atelier",
            include_str!("../../../machinery/skills/atelier/SKILL.md"),
            Condition::Always,
            vec![],
        ),
        (
            "atelier-beads",
            "Beads workflow",
            include_str!("../../../machinery/skills/beads/SKILL.md"),
            Condition::ProjectBeads,
            vec!["bd".into()],
        ),
    ]
    .into_iter()
    .map(|(id, name, text, when, requires)| Item {
        id: id.into(),
        name: name.into(),
        kind: Kind::Instruction,
        description: "Application guidance; maintained by Atelier".into(),
        content: text.splitn(3, "---").nth(2).unwrap_or(text).trim().into(),
        when,
        requires,
        automatic: true,
        parameters: BTreeMap::new(),
        resources: BTreeMap::new(),
        bundle: "Atelier".into(),
    })
    .collect()
}
pub fn resolve(data: &Path, root: Option<&Path>) -> Result<Snapshot, String> {
    let global = read(data, None)?;
    validate(&global, false)?;
    let located = root.and_then(|r| crate::project_manifest::locate(r, data));
    let local = match &located {
        Some(p) => read_path(&p.path.with_file_name("library.json"))?,
        None => Library::default(),
    };
    validate(&local, true)?;
    let beads = located
        .as_ref()
        .is_some_and(|p| p.manifest.project.use_beads);
    let output_style = local
        .output_style
        .as_ref()
        .or(global.output_style.as_ref())
        .cloned()
        .unwrap_or_default();
    let mut items: BTreeMap<String, (Item, &str)> = builtins()
        .into_iter()
        .map(|i| (i.id.clone(), (i, "built-in")))
        .collect();
    if !global.general_instructions.trim().is_empty() {
        items.insert("atelier-general-instructions".into(), (Item {
            id: "atelier-general-instructions".into(),
            name: "Global instructions".into(),
            kind: Kind::Instruction,
            content: global.general_instructions.clone(),
            description: String::new(), when: Condition::Always, requires: vec![],
            automatic: true, parameters: BTreeMap::new(), resources: BTreeMap::new(), bundle: String::new(),
        }, "global"));
    }
    for item in global.items {
        items.insert(item.id.clone(), (item, "global"));
    }
    let mut conflicts = std::collections::HashSet::new();
    for item in local.items {
        if items.contains_key(&item.id) {
            conflicts.insert(item.id.clone());
        }
        items.insert(item.id.clone(), (item, "project"));
    }
    let mut resolved = vec![];
    for (id, (mut item, source)) in items {
        let over = if source == "global" {
            local.overrides.get(&id)
        } else {
            None
        };
        if let Some(over) = over {
            if let Some(when) = &over.when {
                item.when = when.clone();
            }
            if let Some(content) = &over.content {
                item.content = content.clone();
            }
            if let Some(automatic) = over.automatic {
                item.automatic = automatic;
            }
            item.parameters.extend(over.parameters.clone());
        }
        let evaluation = if conflicts.contains(&id) {
            Evaluation::unknown("This project item conflicts with a newly added global ID. Remove the project item and use Customize, or recreate it with a distinct ID.".into())
        } else {
            item.when.evaluate(root, beads)
        };
        let missing: Vec<_> = item
            .requires
            .iter()
            .filter(|name| crate::routes::find_tool(name, &[]).is_none())
            .cloned()
            .collect();
        let state = if conflicts.contains(&id) {
            "conflict"
        } else if over.is_some_and(|o| o.disabled) {
            "disabled"
        } else if item.kind == Kind::OutputStyle && item.id != output_style {
            "not_selected"
        } else if evaluation.matched == Some(false) {
            "not_applicable"
        } else if evaluation.matched.is_none() {
            "unknown"
        } else if !missing.is_empty() {
            "unavailable"
        } else {
            "available"
        };
        resolved.push(Resolved {
            item,
            source: source.into(),
            customized: over.is_some(),
            state: state.into(),
            evaluation,
            missing,
        });
    }
    let revision = digest(&serde_json::to_vec(&resolved).map_err(|e| e.to_string())?);
    Ok(Snapshot {
        revision,
        items: resolved,
    })
}
impl Snapshot {
    pub fn mcp_servers(&self) -> Result<Vec<agent_client_protocol::schema::v1::McpServer>, String> {
        if self.commands().is_empty() {
            return Ok(vec![]);
        }
        serde_json::from_value(json!([{"name":"atelier-shared-skills",
            "command":std::env::current_exe().map_err(|e| e.to_string())?,
            "args":["tool","skills","mcp",self.revision],
            "env":[{"name":"ATELIER_DATA_DIR","value":data_dir()?.to_string_lossy()}]
        }]))
        .map_err(|e| e.to_string())
    }
    pub fn persist(&self, data: &Path) -> Result<(), String> {
        let path = data
            .join("library-snapshots")
            .join(format!("{}.json", self.revision));
        if !path.exists() {
            super::provider_defaults::atomic_write(
                &path,
                &serde_json::to_vec(self).map_err(|e| e.to_string())?,
            )?;
        }
        Ok(())
    }
    pub fn commands(&self) -> Vec<Value> {
        self.items.iter().filter(|r| r.state == "available" && r.item.kind == Kind::Skill).map(|r| json!({
            "name":format!("skill:{}", r.item.id), "description":r.item.description, "kind":"skill", "execution":"shared"
        })).collect()
    }
    pub fn read_skill(&self, id: &str, resource: Option<&str>) -> Result<String, String> {
        let row = self
            .items
            .iter()
            .find(|r| r.item.id == id)
            .ok_or("Unknown skill")?;
        if row.state != "available" || row.item.kind != Kind::Skill {
            return Err(format!("{} is {}", row.item.name, row.state));
        }
        let text = match resource {
            Some(name) => row
                .item
                .resources
                .get(name)
                .ok_or("Unknown skill resource")?,
            None => &row.item.content,
        };
        let mut text = text.clone();
        // Replace placeholders once, never recursively interpret substituted values.
        let pattern = regex::Regex::new(r"\{\{([a-z0-9-]+)\}\}").expect("constant regex");
        text = pattern
            .replace_all(&text, |caps: &regex::Captures| {
                row.item
                    .parameters
                    .get(&caps[1])
                    .cloned()
                    .unwrap_or_else(|| caps[0].into())
            })
            .into_owned();
        if resource.is_none() && !row.item.resources.is_empty() {
            text.push_str(&format!(
                "\n\nSupporting resources (read with atelier_skill_read): {}",
                row.item
                    .resources
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        Ok(text)
    }
    pub fn expand(&self, text: &str) -> Result<Option<String>, String> {
        let Some(rest) = text.trim_start().strip_prefix("/skill:") else {
            return Ok(None);
        };
        let (id, arguments) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
        Ok(Some(format!(
            "Use the following shared skill ({}; revision {}).\n\n{}\n\nUser arguments:\n{}",
            id,
            self.revision,
            self.read_skill(id, None)?,
            arguments.trim()
        )))
    }
    pub fn guidance(&self) -> String {
        // Native resume can retain older instruction blocks. The connector
        // repeats this snapshot once at connection start; that current block
        // supersedes prior snapshots rather than accumulating their styles.
        let mut pieces = vec![format!("Shared library revision: {}. Content is pinned for this connection; settings changes apply on reconnect. Shared skills use atelier_skill_read; explicitly selected skills arrive in the user turn. Read a relevant automatic skill before using its procedure. If the tool is unavailable, use `atelier tool skills read {} ID [RESOURCE]`. Native provider instructions may also apply. Project customizations replace the corresponding global settings. Output styles affect presentation, never tool permissions or required result formats.", self.revision, self.revision)];
        pieces.push("On a later connection, atelier_connection_guidance supplies the current user-configured library and supersedes this snapshot, including its instructions and output style. Earlier responses are history, not current configuration.".into());
        if let Ok(data) = data_dir() {
            pieces.push(format!("Read-only workers without the skill tool or shell may read the same pinned skill content and resources from {}. Only items whose state is available apply.", data.join("library-snapshots").join(format!("{}.json", self.revision)).display()));
        }
        for row in &self.items {
            if row.state == "available" {
                if row.item.kind != Kind::Skill {
                    let pattern =
                        regex::Regex::new(r"\{\{([a-z0-9-]+)\}\}").expect("constant regex");
                    let content =
                        pattern.replace_all(&row.item.content, |caps: &regex::Captures| {
                            row.item
                                .parameters
                                .get(&caps[1])
                                .cloned()
                                .unwrap_or_else(|| caps[0].into())
                        });
                    pieces.push(format!(
                        "{} instructions — {}:\n{}",
                        row.source, row.item.name, content
                    ));
                } else if row.item.automatic {
                    pieces.push(format!(
                        "Available skill {}: {}. {}",
                        row.item.id, row.item.name, row.item.description
                    ));
                }
            } else if row.state == "unavailable" {
                pieces.push(format!("{} applies here but is unavailable: missing {}. Do not assume its requirements are installed.", row.item.name, row.missing.join(", ")));
            }
        }
        pieces.join("\n\n")
    }
}
pub fn snapshot(root: &Path) -> Result<Snapshot, String> {
    let data = data_dir()?;
    let snap = resolve(&data, Some(root))?;
    snap.persist(&data)?;
    Ok(snap)
}
fn load_snapshot(data: &Path, revision: &str) -> Result<Snapshot, String> {
    if revision.len() != 64 || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid snapshot revision".into());
    }
    let snap: Snapshot = serde_json::from_str(&bounded_read(
        &data
            .join("library-snapshots")
            .join(format!("{revision}.json")),
        8 * MAX_LIBRARY,
    )?)
    .map_err(|e| e.to_string())?;
    if digest(&serde_json::to_vec(&snap.items).map_err(|e| e.to_string())?) != revision {
        return Err("Snapshot integrity check failed".into());
    }
    Ok(snap)
}

/// Read-only stdio MCP server, used unchanged by every ACP provider.
/// Discover editable sources without creating settings, migrating manifests,
/// or generating a session snapshot. Personal settings use the same Git identity
/// as the resolver, so linked worktrees find the same personal library.
fn locations(data: &Path, folder: &Path) -> Result<Value, String> {
    let folder = fs::canonicalize(folder).map_err(|e| format!("Project folder: {e}"))?;
    if !folder.is_dir() {
        return Err("Project folder must be a directory".into());
    }
    let git = std::process::Command::new("git")
        .arg("-C").arg(&folder).args(["rev-parse", "--show-toplevel"]).output();
    let git_root = git.ok().filter(|out| out.status.success())
        .map(|out| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()));
    let root = git_root.unwrap_or_else(|| {
        folder.ancestors().find(|dir| {
            crate::project_manifest::repository_path(dir).is_file()
                || crate::project_manifest::personal_path(dir, data).is_file()
        }).unwrap_or(&folder).to_path_buf()
    });
    let repository = crate::project_manifest::repository_path(&root);
    let personal = crate::project_manifest::personal_path(&root, data);
    let selected = if repository.is_file() { Some((repository, "repository")) }
        else if personal.is_file() { Some((personal, "personal")) } else { None };
    let project = selected.map(|(manifest, storage)| {
        crate::project_manifest::read(&manifest)?;
        Ok::<_, String>(json!({
            "root": root, "storage": storage, "manifest": manifest,
            "instructions": crate::project_manifest::instructions_path(&manifest),
            "library": manifest.with_file_name("library.json"),
        }))
    }).transpose()?;
    Ok(json!({
        "global": {"library": data.join("library.json"), "instructions_field": "general_instructions"},
        "project": project,
        "project_registered": project.is_some(),
        "project_root": root,
        "format": "Skills, commands and output styles are items in library.json, not separate files. Commands are skills with automatic=false; output_style selects a style ID.",
        "note": "Paths may not exist until first save. No project settings were created. Edit sources, never library-snapshots; reconnect to apply changes.",
    }))
}

pub fn cli(args: &[String]) -> Result<i32, String> {
    let action = args.first().map(String::as_str).unwrap_or("help");
    if matches!(action, "help" | "--help" | "-h") {
        println!("Usage: atelier tool skills locations [--project PATH] | list | read REVISION ID [RESOURCE] | mcp REVISION");
        return Ok(0);
    }
    if action == "locations" {
        let folder = match &args[1..] {
            [] => std::env::current_dir().map_err(|e| e.to_string())?,
            [flag, path] if flag == "--project" => PathBuf::from(path),
            _ => return Err("Usage: atelier tool skills locations [--project PATH]".into()),
        };
        let data = std::path::absolute(data_dir()?).map_err(|e| e.to_string())?;
        println!("{}", serde_json::to_string_pretty(&locations(&data, &folder)?).map_err(|e| e.to_string())?);
        return Ok(0);
    }
    if action == "list" {
        let root = std::env::current_dir().map_err(|e| e.to_string())?;
        println!(
            "{}",
            serde_json::to_string_pretty(&snapshot(&root)?).map_err(|e| e.to_string())?
        );
        return Ok(0);
    }
    let data = data_dir()?;
    let revision = args
        .get(1)
        .ok_or("Usage: atelier tool skills list | read REVISION ID [RESOURCE] | mcp REVISION")?;
    let snap = load_snapshot(&data, revision)?;
    if action == "read" {
        println!(
            "{}",
            snap.read_skill(
                args.get(2).ok_or("Missing skill ID")?,
                args.get(3).map(String::as_str)
            )?
        );
        return Ok(0);
    }
    if action != "mcp" {
        return Err("Unknown skills operation".into());
    }
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut line = String::new();
        use std::io::Read;
        if input
            .by_ref()
            .take(1024 * 1024)
            .read_line(&mut line)
            .map_err(|e| e.to_string())?
            == 0
        {
            break;
        }
        if line.len() >= 1024 * 1024 {
            return Err("MCP message exceeds limit".into());
        }
        let request: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let Some(id) = request.get("id") else {
            continue;
        };
        let result = match request["method"].as_str().unwrap_or_default() {
            "initialize" => {
                json!({"protocolVersion":request["params"]["protocolVersion"].as_str().unwrap_or("2024-11-05"),"capabilities":{"tools":{}},"serverInfo":{"name":"atelier-skills","version":"1"}})
            }
            "ping" => json!({}),
            "tools/list" => {
                json!({"tools":[{"name":"atelier_skill_read","description":"Read an available shared skill or its supporting resource. Use the skill IDs in the session instructions.","inputSchema":{"type":"object","properties":{"id":{"type":"string"},"resource":{"type":"string"}},"required":["id"],"additionalProperties":false}}]})
            }
            "tools/call" if request["params"]["name"] == "atelier_skill_read" => {
                let args = &request["params"]["arguments"];
                match snap.read_skill(
                    args["id"].as_str().unwrap_or_default(),
                    args["resource"].as_str(),
                ) {
                    Ok(text) => json!({"content":[{"type":"text","text":text}]}),
                    Err(error) => json!({"isError":true,"content":[{"type":"text","text":error}]}),
                }
            }
            _ => {
                writeln!(output, "{}", json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}})).map_err(|e| e.to_string())?;
                output.flush().map_err(|e| e.to_string())?;
                continue;
            }
        };
        writeln!(
            output,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"result":result})
        )
        .map_err(|e| e.to_string())?;
        output.flush().map_err(|e| e.to_string())?;
    }
    Ok(0)
}
