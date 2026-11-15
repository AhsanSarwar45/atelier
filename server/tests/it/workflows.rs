//! A project's workflows are kept in `workflows.json` beside its library, in
//! the JSON shape the Workflows settings page sends.
use atelier::{project_manifest::{self, ManifestStorage}, workbench::workflows};
use serde_json::{json, Value};

fn setup() -> (tempfile::TempDir, tempfile::TempDir) {
    let data = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    project_manifest::create(project.path(), data.path(), ManifestStorage::Repository,
        &project_manifest::named("Workflow test")).unwrap();
    (data, project)
}

fn ticket_flow() -> Value {
    json!({"workflows": [{
        "id": "keystone-ticket",
        "name": "Keystone ticket",
        "enabled": true,
        "trigger": {"kind": "schedule", "every_minutes": 10,
            "items": "linear issue list --label agent-ready --json"},
        "setup": {"branch": "{{item.branchName}}", "base": "dev"},
        "stages": [
            {"id": "implement", "name": "Implement", "kind": "agent",
             "prompt": "Work on {{item.identifier}}", "routes": [{"outcome": "done", "to": "qa"}]},
            {"id": "qa", "name": "QA", "kind": "agent", "prompt": "/skill:web-qa {{item.identifier}}",
             "max_attempts": 3,
             "routes": [{"outcome": "pass", "to": "reply"}, {"outcome": "fail", "to": "qa"}]},
            {"id": "reply", "name": "Reply to QA", "kind": "approval", "prompt": "Post this reply?", "routes": []}
        ]
    }]})
}

fn file(value: Value) -> workflows::WorkflowsFile {
    serde_json::from_value(value).expect("the page's JSON shape parses")
}

#[test]
fn workflows_round_trip_beside_the_library() {
    let (data, project) = setup();
    let empty = workflows::read(data.path(), project.path()).unwrap();
    assert!(empty.workflows.is_empty(), "a new project has no workflows");
    let saved = file(ticket_flow());
    workflows::write(data.path(), project.path(), &saved, &workflows::revision(&empty)).unwrap();
    let manifest = project_manifest::locate(project.path(), data.path()).unwrap();
    assert!(manifest.path.with_file_name("workflows.json").exists(), "stored beside library.json");
    let back = workflows::read(data.path(), project.path()).unwrap();
    assert_eq!(serde_json::to_value(&back).unwrap(), serde_json::to_value(&saved).unwrap());
}

#[test]
fn workflows_refuse_a_route_to_a_missing_stage() {
    let (data, project) = setup();
    let mut value = ticket_flow();
    value["workflows"][0]["stages"][0]["routes"][0]["to"] = json!("nowhere");
    let empty = workflows::read(data.path(), project.path()).unwrap();
    let why = workflows::write(data.path(), project.path(), &file(value), &workflows::revision(&empty)).unwrap_err();
    assert!(why.contains("nowhere"), "names the missing stage: {why}");
}

#[test]
fn workflows_refuse_duplicate_ids_and_blank_names() {
    let (data, project) = setup();
    let empty = workflows::read(data.path(), project.path()).unwrap();
    let mut twice = ticket_flow();
    let copy = twice["workflows"][0].clone();
    twice["workflows"].as_array_mut().unwrap().push(copy);
    assert!(workflows::write(data.path(), project.path(), &file(twice), &workflows::revision(&empty)).is_err());
    let mut blank = ticket_flow();
    blank["workflows"][0]["stages"][1]["name"] = json!("  ");
    assert!(workflows::write(data.path(), project.path(), &file(blank), &workflows::revision(&empty)).is_err());
}

#[test]
fn workflows_refuse_a_stale_editor() {
    let (data, project) = setup();
    let empty = workflows::read(data.path(), project.path()).unwrap();
    let stale = workflows::revision(&empty);
    workflows::write(data.path(), project.path(), &file(ticket_flow()), &stale).unwrap();
    let why = workflows::write(data.path(), project.path(), &file(json!({"workflows": []})), &stale).unwrap_err();
    assert!(why.contains("changed in another editor"), "{why}");
}
