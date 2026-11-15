//! A project's workflows: the automated flows a ticket moves through, kept in
//! `workflows.json` beside the project's `library.json`. This module only
//! stores and checks them; nothing here runs a workflow yet.
use super::library::{bounded_read, digest, library_path, valid_id};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::{Path, PathBuf}, sync::Mutex};

static WRITES: Mutex<()> = Mutex::new(());
const MAX_WORKFLOWS: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkflowsFile {
    #[serde(default)]
    pub workflows: Vec<Workflow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trigger: Trigger,
    #[serde(default)]
    pub setup: Setup,
    #[serde(default)]
    pub stages: Vec<Stage>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    #[default]
    Manual,
    Schedule,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Trigger {
    #[serde(default)]
    pub kind: TriggerKind,
    /// How often a schedule asks for new items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_minutes: Option<u32>,
    /// A command that prints the items to work on as JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Setup {
    /// The branch each item's worktree uses, with `{{item.…}}` placeholders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageKind {
    Agent,
    Command,
    Wait,
    Approval,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stage {
    pub id: String,
    pub name: String,
    pub kind: StageKind,
    #[serde(default)]
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    #[serde(default)]
    pub routes: Vec<Route>,
}

/// Where a stage goes when it reports an outcome.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub outcome: String,
    pub to: String,
}

fn workflows_path(data: &Path, root: &Path) -> Result<PathBuf, String> {
    Ok(library_path(data, Some(root))?.with_file_name("workflows.json"))
}

pub fn read(data: &Path, root: &Path) -> Result<WorkflowsFile, String> {
    // A project whose settings file is still being made has no workflows yet.
    if crate::project_manifest::locate(root, data).is_none() {
        return Ok(WorkflowsFile::default());
    }
    let path = workflows_path(data, root)?;
    if !path.exists() {
        return Ok(WorkflowsFile::default());
    }
    serde_json::from_str(&bounded_read(&path, MAX_WORKFLOWS)?).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn revision(file: &WorkflowsFile) -> String {
    digest(&serde_json::to_vec(file).expect("serializable workflows"))
}

pub fn validate(file: &WorkflowsFile) -> Result<(), String> {
    let mut ids = HashSet::new();
    for workflow in &file.workflows {
        if !valid_id(&workflow.id) {
            return Err(format!("Workflow ID {:?} must use lowercase letters, digits and hyphens", workflow.id));
        }
        if !ids.insert(workflow.id.as_str()) {
            return Err(format!("Two workflows share the ID {}", workflow.id));
        }
        if workflow.name.trim().is_empty() {
            return Err("Workflow name is required".into());
        }
        if workflow.trigger.kind == TriggerKind::Schedule && workflow.trigger.every_minutes.unwrap_or(0) == 0 {
            return Err(format!("{}: a schedule needs a number of minutes", workflow.name));
        }
        let mut stages = HashSet::new();
        for stage in &workflow.stages {
            if !valid_id(&stage.id) {
                return Err(format!("Stage ID {:?} must use lowercase letters, digits and hyphens", stage.id));
            }
            if !stages.insert(stage.id.as_str()) {
                return Err(format!("{}: two stages share the ID {}", workflow.name, stage.id));
            }
            if stage.name.trim().is_empty() {
                return Err("Stage name is required".into());
            }
        }
        for stage in &workflow.stages {
            for route in &stage.routes {
                if route.outcome.trim().is_empty() {
                    return Err(format!("{}: every route needs an outcome", stage.name));
                }
                if !stages.contains(route.to.as_str()) {
                    return Err(format!("{}: route {} goes to a missing stage, {}", stage.name, route.outcome, route.to));
                }
            }
        }
    }
    Ok(())
}

pub fn write(data: &Path, root: &Path, file: &WorkflowsFile, expected: &str) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    validate(file)?;
    if revision(&read(data, root)?) != expected {
        return Err("Workflows changed in another editor. Reload before saving.".into());
    }
    super::provider_defaults::atomic_write(
        &workflows_path(data, root)?,
        &serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?,
    )
}
