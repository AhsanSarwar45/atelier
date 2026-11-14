//! The built-in task types are ready to use with no setup: each says plainly
//! when to use it, carries the default items every task of its kind should
//! answer, and the names say what they are for. A bug you see on a screen is
//! a `ui_bug`; a bug in what a 3D scene renders is a `render_bug`.

use atelier::workbench::tasks::{catalog::Catalog, types};
use serde_json::{json, Value};

/// The built-in catalog an install gets with no task-types.json anywhere.
fn built_in() -> Catalog {
    let root = tempfile::tempdir().unwrap();
    let (global, project) = (root.path().join("data"), root.path().join("project"));
    std::fs::create_dir_all(&global).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    Catalog::load(&global, Some(&project)).unwrap()
}

fn missing(catalog: &Catalog, name: &str, wanted: &[&str]) -> Vec<String> {
    let have = catalog.items(name);
    wanted.iter().filter(|id| !have.contains(&id.to_string())).map(|id| format!("{name}.{id}")).collect()
}

#[test]
fn every_built_in_type_says_when_to_use_it() {
    let listing = built_in().listing();
    let vague: Vec<String> = listing["types"].as_array().unwrap().iter()
        .filter(|kind| {
            let description = kind["description"].as_str().unwrap_or_default();
            description.starts_with("plan:") || description.len() < 30
        })
        .map(|kind| kind["name"].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(vague.is_empty(), "no description: {vague:?}");
}

#[test]
fn ui_types_ask_for_components_screen_sizes_wording_and_edge_cases() {
    let catalog = built_in();
    let wanted = ["existing-components", "screen-sizes", "ui-copy", "edge-cases", "keyboard"];
    let gaps: Vec<String> = ["ui_change", "ui_feature", "ui_bug"].iter().flat_map(|name| missing(&catalog, name, &wanted)).collect();
    assert!(gaps.is_empty(), "missing default items: {gaps:?}");
}

#[test]
fn other_types_have_their_default_items() {
    let catalog = built_in();
    let mut gaps = Vec::new();
    for (name, wanted) in [
        ("bug", &["repro-test", "same-bug-elsewhere"][..]),
        ("ui_bug", &["repro-test"][..]),
        ("render_bug", &["repro-scene", "same-view", "frame-time"][..]),
        ("render_change", &["same-view", "frame-time", "artifacts"][..]),
        ("render_feature", &["same-view", "frame-time", "artifacts"][..]),
        ("feature", &["edge-cases", "docs-updated"][..]),
        ("refactor", &["behaviour-unchanged"][..]),
        ("optimization", &["measured-runs", "behaviour-unchanged"][..]),
        ("tests", &["not-flaky"][..]),
        ("docs", &["commands-work"][..]),
        ("plan", &["options-weighed"][..]),
    ] {
        gaps.extend(missing(&catalog, name, wanted));
    }
    assert!(gaps.is_empty(), "missing default items: {gaps:?}");
}

#[test]
fn visual_bug_is_split_into_ui_bug_and_render_bug() {
    let names = built_in().names();
    assert!(!names.contains(&"visual_bug".to_string()), "visual_bug is still a type: {names:?}");
    for name in ["ui_bug", "render_bug"] {
        assert!(names.contains(&name.to_string()), "{name} is not a type: {names:?}");
    }
    let refused = types::check_plan("visual_bug", &json!({})).unwrap_err();
    assert!(refused.contains("ui_bug") && refused.contains("render_bug"), "the old name points to the new ones: {refused}");
}

/// A stored image, as the server names an uploaded one.
fn asset(n: char) -> String {
    format!("{}{}.png", types::SERVED, n.to_string().repeat(64))
}

fn render_bug_plan() -> Value {
    types::with_checks("render_bug", json!({"symptom": "Shadows flicker on the floor", "repro_steps": ["Open the hall", "Walk to the door"],
        "expected": "Steady shadows", "actual": "Shadows flicker",
        "scenes": [{"id": "hall", "scene": "Great hall", "camera": "door, 35mm"}]}))
}

#[test]
fn a_render_bug_proves_its_fix_with_renders_of_the_same_scene() {
    let plan = render_bug_plan();
    types::check_plan("render_bug", &plan).unwrap_or_else(|error| panic!("render_bug plan refused: {error}"));
    let fixed = json!({"root_cause": "Shadow bias too small", "fix": "Raised the bias",
        "scenes": [{"id": "hall", "before": asset('a'), "after": asset('b')}]});
    types::check_result("render_bug", &plan, &fixed).unwrap_or_else(|error| panic!("render_bug result refused: {error}"));
    let no_before = json!({"root_cause": "r", "fix": "f", "scenes": [{"id": "hall", "after": asset('b')}]});
    let refused = types::check_result("render_bug", &plan, &no_before).unwrap_err();
    assert!(refused.contains("before"), "a render bug needs the render that shows it: {refused}");
}
