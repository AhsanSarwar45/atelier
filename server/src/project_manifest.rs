//! One authoritative, versioned description of a project.
//!
//! The file is deliberately usable without the Atelier service: command-line
//! setup, provider session policy and repository hooks all need the same answer.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

pub const SCHEMA_VERSION: u32 = 1;
pub const REPOSITORY_MANIFEST: &str = ".atelier/project.toml";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub project: ProjectSettings,
    #[serde(default)]
    pub git: GitSettings,
    #[serde(default)]
    pub beads: BeadsSettings,
    #[serde(default)]
    pub verification: VerificationSettings,
    #[serde(default)]
    pub review: ReviewSettings,
    #[serde(default)]
    pub development: DevelopmentSettings,
    #[serde(default)]
    pub deployment: DeploymentSettings,
    #[serde(default)]
    pub cross_project: CrossProjectSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProjectSettings {
    pub display_name: String,
    #[serde(default)]
    pub use_beads: bool,
    #[serde(default)]
    pub summary: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct GitSettings {
    #[serde(default)]
    pub completed_work_branch: String,
    #[serde(default)]
    pub agents_may_merge_completed_work: bool,
    #[serde(default)]
    pub protected_branches: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct BeadsSettings {
    #[serde(default)]
    pub issue_id_prefix: String,
    #[serde(default)]
    pub work_areas: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct VerificationSettings {
    #[serde(default)]
    pub visual_proof_for_ui_changes: bool,
    #[serde(default)]
    pub commands: Vec<VerificationCommand>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct VerificationCommand {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ReviewSettings {
    #[serde(default = "agent_decides")]
    pub external_review: String,
    #[serde(default)]
    pub evidence_requirements: String,
}

fn agent_decides() -> String { "agent_decides".into() }

impl Default for ReviewSettings {
    fn default() -> Self {
        Self { external_review: agent_decides(), evidence_requirements: String::new() }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct DevelopmentSettings {
    #[serde(default)]
    pub setup_command: String,
    #[serde(default)]
    pub start_command: String,
    #[serde(default)]
    pub build_command: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct DeploymentSettings {
    #[serde(default)]
    pub command: String,
    #[serde(default = "yes")]
    pub requires_confirmation: bool,
}

fn yes() -> bool { true }

impl Default for DeploymentSettings {
    fn default() -> Self { Self { command: String::new(), requires_confirmation: true } }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct CrossProjectSettings {
    #[serde(default)]
    pub delivery_projects: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManifestStorage { Personal, Repository }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct LocatedManifest {
    pub manifest: ProjectManifest,
    pub path: PathBuf,
    pub storage: ManifestStorage,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyManifest {
    name: Option<String>,
    prefix: Option<String>,
    lands_on: Option<String>,
    agent_merges: Option<bool>,
    protected: Option<Vec<String>>,
    areas: Option<Vec<String>>,
    checks: Option<String>,
    lands_elsewhere: Option<Vec<String>>,
    review: Option<LegacyReview>,
}

#[derive(Debug, Default, Deserialize)]
struct LegacyReview { persona: Option<String>, proves: Option<String> }

fn git(root: &Path, args: &[&str]) -> String {
    Command::new("git").arg("-C").arg(root).args(args).output().ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

pub fn git_identity(root: &Path) -> PathBuf {
    let common = git(root, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if common.is_empty() { root.to_path_buf() } else { PathBuf::from(common) }
}

pub fn project_id(root: &Path) -> String {
    let identity = fs::canonicalize(git_identity(root)).unwrap_or_else(|_| git_identity(root));
    let digest = Sha256::digest(identity.to_string_lossy().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn personal_path(root: &Path, data_dir: &Path) -> PathBuf {
    data_dir.join("projects").join(project_id(root)).join("project.toml")
}

pub fn personal_path_for_key(key: &str, data_dir: &Path) -> PathBuf {
    let digest = Sha256::digest(key.as_bytes());
    let id: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    data_dir.join("projects").join(id).join("project.toml")
}

pub fn locate_key(key: &str, data_dir: &Path) -> Option<LocatedManifest> {
    let path = personal_path_for_key(key, data_dir);
    read(&path).ok().map(|manifest| LocatedManifest {
        manifest, path, storage: ManifestStorage::Personal,
    })
}

pub fn create_key(key: &str, data_dir: &Path, manifest: &ProjectManifest) -> Result<PathBuf, String> {
    let path = personal_path_for_key(key, data_dir);
    if path.exists() { return Err(format!("{} already exists", path.display())); }
    write_atomic(&path, manifest)?;
    Ok(path)
}

pub fn repository_path(root: &Path) -> PathBuf { root.join(REPOSITORY_MANIFEST) }

pub fn locate(root: &Path, data_dir: &Path) -> Option<LocatedManifest> {
    let repository = repository_path(root);
    let (path, storage) = if repository.is_file() {
        (repository, ManifestStorage::Repository)
    } else {
        let personal = personal_path(root, data_dir);
        if !personal.is_file() && migrate_legacy(root, data_dir).is_err() {
            return None;
        }
        (personal, ManifestStorage::Personal)
    };
    read(&path).ok().map(|manifest| LocatedManifest { manifest, path, storage })
}

fn old_personal_path(root: &Path, data_dir: &Path) -> PathBuf {
    data_dir.join("projects").join(format!("{}.toml", project_id(root)))
}

/// Convert the previous declaration exactly once. No runtime reader consumes
/// it after this function returns: a successful conversion deletes the source.
pub fn migrate_legacy(root: &Path, data_dir: &Path) -> Result<Option<PathBuf>, String> {
    let external = old_personal_path(root, data_dir);
    let in_repo = root.join("machinery.toml");
    let source = if external.is_file() { external } else if in_repo.is_file() { in_repo } else { return Ok(None) };
    let text = fs::read_to_string(&source).map_err(|error| error.to_string())?;
    let legacy: LegacyManifest = toml::from_str(&text).map_err(|error| format!("{} could not be migrated: {error}", source.display()))?;
    let fallback = infer(root);
    let branch = legacy.lands_on.unwrap_or(fallback.git.completed_work_branch);
    let checks = legacy.checks.unwrap_or_default();
    let review = legacy.review.unwrap_or_default();
    let manifest = ProjectManifest {
        schema_version: SCHEMA_VERSION,
        project: ProjectSettings {
            display_name: legacy.name.unwrap_or(fallback.project.display_name),
            use_beads: true,
            summary: review.persona.unwrap_or_default(),
        },
        git: GitSettings {
            completed_work_branch: branch.clone(),
            agents_may_merge_completed_work: legacy.agent_merges.unwrap_or(false),
            protected_branches: legacy.protected.unwrap_or_else(|| {
                let mut protected = fallback.git.protected_branches;
                if !protected.contains(&branch) { protected.push(branch); }
                protected
            }),
        },
        beads: BeadsSettings {
            issue_id_prefix: legacy.prefix.unwrap_or(fallback.beads.issue_id_prefix),
            work_areas: legacy.areas.unwrap_or(fallback.beads.work_areas),
        },
        verification: VerificationSettings {
            visual_proof_for_ui_changes: fallback.verification.visual_proof_for_ui_changes,
            commands: if checks.trim().is_empty() { fallback.verification.commands } else {
                vec![VerificationCommand { name: "Project checks".into(), command: checks, paths: vec![] }]
            },
        },
        review: ReviewSettings {
            external_review: agent_decides(),
            evidence_requirements: review.proves.unwrap_or_default(),
        },
        development: fallback.development,
        deployment: DeploymentSettings::default(),
        cross_project: CrossProjectSettings { delivery_projects: legacy.lands_elsewhere.unwrap_or_default() },
    };
    let destination = personal_path(root, data_dir);
    write_atomic(&destination, &manifest)?;
    fs::remove_file(&source).map_err(|error| format!("{} was migrated but could not be removed: {error}", source.display()))?;
    Ok(Some(destination))
}

pub fn read(path: &Path) -> Result<ProjectManifest, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("{} could not be read: {error}", path.display()))?;
    let manifest: ProjectManifest = toml::from_str(&text)
        .map_err(|error| format!("{} is not a valid project manifest: {error}", path.display()))?;
    validate(&manifest)?;
    Ok(manifest)
}

pub fn validate(manifest: &ProjectManifest) -> Result<(), String> {
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!("project manifest schema {} is not supported", manifest.schema_version));
    }
    if manifest.project.display_name.trim().is_empty() { return Err("display_name cannot be empty".into()); }
    if manifest.project.use_beads {
        if manifest.beads.issue_id_prefix.trim().is_empty() { return Err("issue_id_prefix cannot be empty when Beads is enabled".into()); }
        if manifest.git.completed_work_branch.trim().is_empty() { return Err("completed_work_branch cannot be empty when Beads is enabled".into()); }
    }
    if !matches!(manifest.review.external_review.as_str(), "agent_decides" | "always" | "never") {
        return Err("external_review must be agent_decides, always, or never".into());
    }
    for check in &manifest.verification.commands {
        if check.name.trim().is_empty() || check.command.trim().is_empty() {
            return Err("every verification command needs a name and command".into());
        }
    }
    Ok(())
}

pub fn write_atomic(path: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    validate(manifest)?;
    let parent = path.parent().ok_or_else(|| "manifest has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("{} could not be created: {error}", parent.display()))?;
    let text = toml::to_string_pretty(manifest).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".project.toml.{}.tmp", std::process::id()));
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(text.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn prefix(name: &str) -> String {
    let mut out: String = name.to_ascii_lowercase().chars().filter(|c| c.is_ascii_alphabetic()).take(3).collect();
    while out.len() < 2 { out.push('p'); }
    out
}

fn existing_branches(root: &Path) -> Vec<String> {
    git(root, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .lines().map(str::to_string).collect()
}

pub fn branch_exists(root: &Path, branch: &str) -> bool {
    existing_branches(root).iter().any(|existing| existing == branch)
}

pub fn infer(root: &Path) -> ProjectManifest {
    let name = root.file_name().and_then(|name| name.to_str()).unwrap_or("Project").to_string();
    let current = git(root, &["branch", "--show-current"]);
    let branch = if current.is_empty() { "main".into() } else { current };
    let branches = existing_branches(root);
    let protected_branches = ["main", "master", "staging", "production", "release"]
        .into_iter().filter(|candidate| branches.iter().any(|branch| branch == candidate))
        .map(str::to_string).collect();
    let mut commands = Vec::new();
    let mut development = DevelopmentSettings::default();
    if root.join("package.json").is_file() {
        commands.push(VerificationCommand { name: "JavaScript tests".into(), command: "npm test".into(), paths: vec![] });
        development.setup_command = "npm install".into();
        development.start_command = "npm run dev".into();
        development.build_command = "npm run build".into();
    }
    if root.join("Cargo.toml").is_file() || root.join("server/Cargo.toml").is_file() {
        let command = if root.join("server/Cargo.toml").is_file() { "cd server && cargo test" } else { "cargo test" };
        commands.push(VerificationCommand { name: "Rust tests".into(), command: command.into(), paths: vec!["**/*.rs".into(), "**/Cargo.toml".into()] });
    }
    ProjectManifest {
        schema_version: SCHEMA_VERSION,
        project: ProjectSettings { display_name: name.clone(), use_beads: root.join(".beads").is_dir(), summary: String::new() },
        git: GitSettings { completed_work_branch: branch, agents_may_merge_completed_work: false, protected_branches },
        beads: BeadsSettings { issue_id_prefix: prefix(&name), work_areas: vec!["interface".into(), "server".into(), "tests".into(), "tooling".into(), "docs".into()] },
        verification: VerificationSettings { visual_proof_for_ui_changes: root.join("package.json").is_file(), commands },
        review: ReviewSettings::default(), development,
        deployment: DeploymentSettings::default(), cross_project: CrossProjectSettings::default(),
    }
}

pub fn infer_virtual(name: &str) -> ProjectManifest {
    let name = if name.trim().is_empty() { "Project" } else { name.trim() };
    ProjectManifest {
        schema_version: SCHEMA_VERSION,
        project: ProjectSettings { display_name: name.into(), use_beads: true, summary: String::new() },
        git: GitSettings { completed_work_branch: "main".into(), agents_may_merge_completed_work: false, protected_branches: vec!["main".into()] },
        beads: BeadsSettings { issue_id_prefix: prefix(name), work_areas: vec!["product".into(), "operations".into()] },
        verification: VerificationSettings::default(), review: ReviewSettings::default(),
        development: DevelopmentSettings::default(), deployment: DeploymentSettings::default(),
        cross_project: CrossProjectSettings::default(),
    }
}

pub fn create(root: &Path, data_dir: &Path, storage: ManifestStorage, manifest: &ProjectManifest) -> Result<PathBuf, String> {
    let path = match storage { ManifestStorage::Personal => personal_path(root, data_dir), ManifestStorage::Repository => repository_path(root) };
    if path.exists() { return Err(format!("{} already exists", path.display())); }
    write_atomic(&path, manifest)?;
    Ok(path)
}

pub fn move_to(root: &Path, data_dir: &Path, storage: ManifestStorage) -> Result<PathBuf, String> {
    let located = locate(root, data_dir).ok_or_else(|| "project has no manifest".to_string())?;
    if located.storage == storage { return Ok(located.path); }
    let destination = match storage { ManifestStorage::Personal => personal_path(root, data_dir), ManifestStorage::Repository => repository_path(root) };
    if destination.exists() { return Err(format!("{} already exists", destination.display())); }
    write_atomic(&destination, &located.manifest)?;
    fs::remove_file(&located.path).map_err(|error| format!("new manifest was written but {} could not be removed: {error}", located.path.display()))?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn project_manifest_round_trips_and_moves_without_two_truths() {
        let held = tempdir().unwrap();
        let repo = held.path().join("example");
        let data = held.path().join("data");
        fs::create_dir_all(&repo).unwrap();
        let mut manifest = infer(&repo);
        manifest.project.use_beads = true;
        manifest.git.completed_work_branch = "ours".into();
        create(&repo, &data, ManifestStorage::Personal, &manifest).unwrap();
        let found = locate(&repo, &data).unwrap();
        assert_eq!(found.manifest, manifest);
        assert_eq!(found.storage, ManifestStorage::Personal);
        move_to(&repo, &data, ManifestStorage::Repository).unwrap();
        assert!(!personal_path(&repo, &data).exists());
        assert_eq!(locate(&repo, &data).unwrap().storage, ManifestStorage::Repository);
    }

    #[test]
    fn project_manifest_requires_beads_identity_and_branch_only_when_enabled() {
        let held = tempdir().unwrap();
        let mut manifest = infer(held.path());
        manifest.beads.issue_id_prefix.clear();
        manifest.git.completed_work_branch.clear();
        assert!(validate(&manifest).is_ok());
        manifest.project.use_beads = true;
        assert!(validate(&manifest).unwrap_err().contains("issue_id_prefix"));
    }

    #[test]
    fn board_only_project_has_one_personal_manifest_too() {
        let held = tempdir().unwrap();
        let key = "dolt://keystone";
        let manifest = infer_virtual("Keystone");

        let path = create_key(key, held.path(), &manifest).unwrap();
        let found = locate_key(key, held.path()).unwrap();

        assert_eq!(path, found.path);
        assert_eq!(ManifestStorage::Personal, found.storage);
        assert!(found.manifest.project.use_beads);
        assert_eq!("Keystone", found.manifest.project.display_name);
    }

    #[test]
    fn project_manifest_migrates_once_and_removes_the_old_declaration() {
        let held = tempdir().unwrap();
        let repo = held.path().join("example");
        let data = held.path().join("data");
        fs::create_dir_all(&repo).unwrap();
        let old = old_personal_path(&repo, &data);
        fs::create_dir_all(old.parent().unwrap()).unwrap();
        fs::write(&old, "name = \"Example\"\nprefix = \"ex\"\nlands_on = \"ship\"\nagent_merges = true\nchecks = \"make test\"\n").unwrap();
        let found = locate(&repo, &data).unwrap();
        assert!(!old.exists());
        assert_eq!(found.manifest.git.completed_work_branch, "ship");
        assert_eq!(found.manifest.verification.commands[0].command, "make test");
    }
}
