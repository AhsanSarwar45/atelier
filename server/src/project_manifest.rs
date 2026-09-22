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
/// The project's own instructions, kept beside its manifest so that one choice
/// of home — the repository or this computer — governs both.
pub const INSTRUCTIONS_FILE: &str = "instructions.md";

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
}

fn agent_decides() -> String { "agent_decides".into() }

impl Default for ReviewSettings {
    fn default() -> Self {
        Self { external_review: agent_decides() }
    }
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
    /// What the project tells its agents, in its own words. Empty when the
    /// project has not written any.
    #[serde(default)]
    pub instructions: String,
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
    let _ = carry_retired_fields_forward(&path);
    read(&path).ok().map(|manifest| LocatedManifest {
        instructions: read_instructions(&path), manifest, path,
        storage: ManifestStorage::Personal,
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
    let _ = carry_retired_fields_forward(&path);
    read(&path).ok().map(|manifest| LocatedManifest {
        instructions: read_instructions(&path), manifest, path, storage,
    })
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
            commands: if checks.trim().is_empty() { fallback.verification.commands } else {
                vec![VerificationCommand { name: "Project checks".into(), command: checks, paths: vec![] }]
            },
        },
        review: ReviewSettings { external_review: agent_decides() },
        cross_project: CrossProjectSettings { delivery_projects: legacy.lands_elsewhere.unwrap_or_default() },
    };
    let destination = personal_path(root, data_dir);
    write_atomic(&destination, &manifest)?;
    let mut carried: Vec<String> = infer_instructions(root).lines().map(str::to_string).collect();
    if let Some(proves) = review.proves.filter(|text| !text.trim().is_empty()) {
        carried.push(format!("Required evidence: {proves}"));
    }
    if !carried.is_empty() { write_instructions(&destination, &carried.join("\n"))?; }
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
    write_text_atomic(path, &text)
}

fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "file has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("{} could not be created: {error}", parent.display()))?;
    let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("settings");
    let temporary = parent.join(format!(".{name}.{}.tmp", std::process::id()));
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

/// Make the branch the reader named in the picker, at the current head.
pub fn create_branch(root: &Path, branch: &str) -> Result<(), String> {
    let out = Command::new("git").arg("-C").arg(root).args(["branch", "--", branch]).output()
        .map_err(|error| format!("git could not be run: {error}"))?;
    if out.status.success() { return Ok(()); }
    let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if why.is_empty() { format!("branch {branch} could not be created") } else { why })
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
    if root.join("package.json").is_file() {
        commands.push(VerificationCommand { name: "JavaScript tests".into(), command: "npm test".into(), paths: vec![] });
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
        verification: VerificationSettings { commands },
        review: ReviewSettings::default(), cross_project: CrossProjectSettings::default(),
    }
}

/// What a freshly inferred project would have said about itself, for the
/// instructions file the Add Project dialog offers to start from.
pub fn infer_instructions(root: &Path) -> String {
    let mut lines = Vec::new();
    if root.join("package.json").is_file() {
        lines.push("Setup command: npm install".to_string());
        lines.push("Start command: npm run dev".to_string());
        lines.push("Build command: npm run build".to_string());
        lines.push("This project requires visual proof for interface changes.".to_string());
    }
    lines.join("\n")
}

pub fn infer_virtual(name: &str) -> ProjectManifest {
    let name = if name.trim().is_empty() { "Project" } else { name.trim() };
    ProjectManifest {
        schema_version: SCHEMA_VERSION,
        project: ProjectSettings { display_name: name.into(), use_beads: true, summary: String::new() },
        git: GitSettings { completed_work_branch: "main".into(), agents_may_merge_completed_work: false, protected_branches: vec!["main".into()] },
        beads: BeadsSettings { issue_id_prefix: prefix(name), work_areas: vec!["product".into(), "operations".into()] },
        verification: VerificationSettings::default(), review: ReviewSettings::default(),
        cross_project: CrossProjectSettings::default(),
    }
}

pub fn create(root: &Path, data_dir: &Path, storage: ManifestStorage, manifest: &ProjectManifest) -> Result<PathBuf, String> {
    let path = match storage { ManifestStorage::Personal => personal_path(root, data_dir), ManifestStorage::Repository => repository_path(root) };
    if path.exists() { return Err(format!("{} already exists", path.display())); }
    write_atomic(&path, manifest)?;
    Ok(path)
}

/// The instructions file that belongs to the manifest at `manifest_path`.
pub fn instructions_path(manifest_path: &Path) -> PathBuf {
    manifest_path.with_file_name(INSTRUCTIONS_FILE)
}

/// A project with nothing to say reads the same as a project that has not been
/// asked yet, so a missing file is empty text rather than an error.
pub fn read_instructions(manifest_path: &Path) -> String {
    fs::read_to_string(instructions_path(manifest_path))
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

/// Blank instructions leave no file behind: an empty file and no file would
/// otherwise be two spellings of the same thing.
pub fn write_instructions(manifest_path: &Path, text: &str) -> Result<(), String> {
    let path = instructions_path(manifest_path);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("{} could not be removed: {error}", path.display())),
        };
    }
    write_text_atomic(&path, &format!("{trimmed}\n"))
}

/// The settings that existed only to become prompt text, as they were written
/// before a project could say these things in its own words.
#[derive(Debug, Default, Deserialize)]
struct RetiredPromptFields {
    #[serde(default)] development: DevelopmentSettings,
    #[serde(default)] deployment: DeploymentSettings,
    #[serde(default)] review: RetiredReviewFields,
    #[serde(default)] verification: RetiredVerificationFields,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct DevelopmentSettings {
    #[serde(default)] setup_command: String,
    #[serde(default)] start_command: String,
    #[serde(default)] build_command: String,
}

#[derive(Debug, Default, Deserialize)]
struct DeploymentSettings {
    #[serde(default)] command: String,
    #[serde(default)] requires_confirmation: bool,
}

#[derive(Debug, Default, Deserialize)]
struct RetiredReviewFields {
    #[serde(default)] evidence_requirements: String,
}

#[derive(Debug, Default, Deserialize)]
struct RetiredVerificationFields {
    #[serde(default)] visual_proof_for_ui_changes: bool,
}

fn development_lines(development: &DevelopmentSettings) -> Vec<String> {
    [
        ("Setup", &development.setup_command),
        ("Start", &development.start_command),
        ("Build", &development.build_command),
    ]
    .into_iter()
    .filter(|(_, command)| !command.trim().is_empty())
    .map(|(label, command)| format!("{label} command: {command}"))
    .collect()
}

/// What the retired fields used to make the session say, word for word, so a
/// project that is carried forward keeps telling its agents the same thing.
fn retired_lines(retired: &RetiredPromptFields) -> Vec<String> {
    let mut lines = development_lines(&retired.development);
    if !retired.review.evidence_requirements.trim().is_empty() {
        lines.push(format!("Required evidence: {}", retired.review.evidence_requirements));
    }
    // Only the requirement is carried. "Does not require visual proof" was a
    // sentence the settings screen produced whether or not anyone meant it,
    // and an instructions file is written by someone who meant it.
    if retired.verification.visual_proof_for_ui_changes {
        lines.push("This project requires visual proof for interface changes.".into());
    }
    if !retired.deployment.command.trim().is_empty() {
        lines.push(format!("Deployment command: {}", retired.deployment.command));
        if retired.deployment.requires_confirmation {
            lines.push("Ask for explicit permission immediately before running the deployment command.".into());
        }
    }
    lines
}

/// Move a manifest's retired prompt settings into its instructions file.
///
/// Serde drops unknown keys in silence, so without this a project that had
/// written setup commands and evidence requirements would simply stop saying
/// them, with nothing on screen to show what was lost. The keys are removed
/// from the manifest as the text is written, which is what makes this run at
/// most once per project.
pub fn carry_retired_fields_forward(path: &Path) -> Result<bool, String> {
    let Ok(text) = fs::read_to_string(path) else { return Ok(false) };
    let Ok(retired) = toml::from_str::<RetiredPromptFields>(&text) else { return Ok(false) };
    // Edited rather than re-serialised: a repository manifest is a tracked
    // file, and a migration that reordered every section would bury the one
    // change it made in a diff of the whole file.
    let Ok(mut document) = text.parse::<toml_edit::DocumentMut>() else { return Ok(false) };
    let mut stripped = document.remove("development").is_some() | document.remove("deployment").is_some();
    for (section, key) in [("review", "evidence_requirements"), ("verification", "visual_proof_for_ui_changes")] {
        if let Some(inner) = document.get_mut(section).and_then(|item| item.as_table_mut()) {
            stripped |= inner.remove(key).is_some();
        }
    }
    if !stripped { return Ok(false) }
    let carried = retired_lines(&retired);
    if !carried.is_empty() {
        let existing = read_instructions(path);
        let joined = if existing.is_empty() { carried.join("\n") } else { format!("{existing}\n\n{}", carried.join("\n")) };
        write_instructions(path, &joined)?;
    }
    write_text_atomic(path, &document.to_string())
        .map(|()| true)
        .map_err(|error| format!("{} kept its retired settings: {error}", path.display()))
}

pub fn move_to(root: &Path, data_dir: &Path, storage: ManifestStorage) -> Result<PathBuf, String> {
    let located = locate(root, data_dir).ok_or_else(|| "project has no manifest".to_string())?;
    if located.storage == storage { return Ok(located.path); }
    let destination = match storage { ManifestStorage::Personal => personal_path(root, data_dir), ManifestStorage::Repository => repository_path(root) };
    if destination.exists() { return Err(format!("{} already exists", destination.display())); }
    write_atomic(&destination, &located.manifest)?;
    // The instructions are half of what a project says about itself; a move
    // that left them behind would look like a move that erased them.
    write_instructions(&destination, &located.instructions)?;
    write_instructions(&located.path, "")?;
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

    /// A move changes where the settings live, not what they say. The
    /// instructions are settings, so they travel with the manifest rather
    /// than staying behind in the home the project just left (bw-a9ln.4).
    #[test]
    fn instructions_move_with_the_manifest_and_leave_nothing_behind() {
        let held = tempdir().unwrap();
        let repo = held.path().join("example");
        let data = held.path().join("data");
        fs::create_dir_all(&repo).unwrap();
        let manifest = infer(&repo);
        let path = create(&repo, &data, ManifestStorage::Personal, &manifest).unwrap();
        write_instructions(&path, "Never touch port 3008.").unwrap();

        let moved = move_to(&repo, &data, ManifestStorage::Repository).unwrap();
        assert_eq!(read_instructions(&moved), "Never touch port 3008.");
        assert!(!instructions_path(&path).exists());
        assert_eq!(locate(&repo, &data).unwrap().instructions, "Never touch port 3008.");
    }

    /// Blank instructions and no instructions are one state, not two, so a
    /// reader who clears the editor does not leave an empty file that the
    /// next move would carry around (bw-a9ln.4).
    #[test]
    fn clearing_the_instructions_removes_the_file() {
        let held = tempdir().unwrap();
        let path = held.path().join("project.toml");
        write_instructions(&path, "Something").unwrap();
        assert!(instructions_path(&path).exists());
        write_instructions(&path, "   \n ").unwrap();
        assert!(!instructions_path(&path).exists());
        assert_eq!(read_instructions(&path), "");
    }

    /// Serde drops keys it does not know without a word, so a project written
    /// before the instructions file would have gone quiet: its setup commands
    /// and evidence requirement would stop reaching any session, with nothing
    /// on screen to show what was lost (bw-a9ln.3).
    #[test]
    fn a_manifest_written_before_instructions_keeps_saying_what_it_said() {
        let held = tempdir().unwrap();
        let path = held.path().join("project.toml");
        fs::write(&path, concat!(
            "schema_version = 1\n",
            "[project]\ndisplay_name = \"Keystone\"\nuse_beads = false\n",
            "[verification]\nvisual_proof_for_ui_changes = true\n",
            "[review]\nexternal_review = \"always\"\nevidence_requirements = \"Show the screen\"\n",
            "[development]\nsetup_command = \"npm install\"\nstart_command = \"npm run dev\"\nbuild_command = \"\"\n",
            "[deployment]\ncommand = \"deploy it\"\nrequires_confirmation = true\n",
        )).unwrap();

        assert!(carry_retired_fields_forward(&path).unwrap());
        let carried = read_instructions(&path);
        assert_eq!(carried, concat!(
            "Setup command: npm install\n",
            "Start command: npm run dev\n",
            "Required evidence: Show the screen\n",
            "This project requires visual proof for interface changes.\n",
            "Deployment command: deploy it\n",
            "Ask for explicit permission immediately before running the deployment command.",
        ));
        // The policy a gate reads is untouched: only the prompt-only settings move.
        assert_eq!(read(&path).unwrap().review.external_review, "always");
        // And the file is edited, not rewritten: what stayed, stayed as it was.
        let after = fs::read_to_string(&path).unwrap();
        assert!(after.starts_with("schema_version = 1\n[project]\ndisplay_name = \"Keystone\""), "{after}");
        assert!(!after.contains("development"), "{after}");

        // Running again finds nothing to carry, so the text is not doubled.
        assert!(!carry_retired_fields_forward(&path).unwrap());
        assert_eq!(read_instructions(&path), carried);
    }

    /// A project that never had the retired settings must not be rewritten,
    /// or every read would dirty a repository's tracked manifest (bw-a9ln.3).
    #[test]
    fn a_manifest_without_retired_settings_is_left_alone() {
        let held = tempdir().unwrap();
        let repo = held.path().join("example");
        let data = held.path().join("data");
        fs::create_dir_all(&repo).unwrap();
        let path = create(&repo, &data, ManifestStorage::Personal, &infer(&repo)).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        assert!(!carry_retired_fields_forward(&path).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
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
