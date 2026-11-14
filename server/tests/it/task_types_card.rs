//! A task types change is shown to the owner as a card in the chat, with an
//! Undo that undoes that change only: once a later change is made, the card's
//! Undo is refused instead of undoing the later one.

use atelier::workbench::{media, tasks::catalog};
use serde_json::json;

fn folders() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let (global, project) = (root.path().join("data"), root.path().join("project"));
    std::fs::create_dir_all(&global).unwrap();
    std::fs::create_dir_all(&project).unwrap();
    (root, global, project)
}

fn disable(global: &std::path::Path, project: &std::path::Path, name: &str) {
    catalog::change(global, Some(project), &json!({"action": "disable", "scope": "project", "name": name}))
        .unwrap_or_else(|message| panic!("refused: {message}"));
}

#[test]
fn undo_of_an_older_change_is_refused_and_the_latest_is_undone_by_its_id() {
    let (_root, global, project) = folders();
    disable(&global, &project, "render_change");
    disable(&global, &project, "qa");
    let history = catalog::history(&global, Some(&project), "project").unwrap();
    let ids: Vec<String> = history.iter().map(|change| change["id"].as_str().unwrap_or_default().to_string()).collect();
    assert_eq!(ids.len(), 2, "every change has an id: {history:?}");
    assert!(!ids[0].is_empty() && ids[0] != ids[1], "ids are set and differ: {ids:?}");

    let refused = catalog::undo_change(&global, Some(&project), "project", Some(&ids[0])).unwrap_err();
    assert!(refused.contains("later change"), "{refused}");
    let names = catalog::Catalog::load(&global, Some(&project)).unwrap().names();
    assert!(!names.contains(&"qa".to_string()), "the refused undo changed nothing");

    let undone = catalog::undo_change(&global, Some(&project), "project", Some(&ids[1])).unwrap();
    assert!(undone.contains("qa"), "{undone}");
    let names = catalog::Catalog::load(&global, Some(&project)).unwrap().names();
    assert!(names.contains(&"qa".to_string()) && !names.contains(&"render_change".to_string()), "{names:?}");
}

#[test]
fn a_types_change_prints_a_card_the_chat_draws() {
    let block = catalog::widget("p1", "project", "Turned type \"qa\" off for the project.", "c1").unwrap();
    let specs = media::widget_specs(&block);
    assert_eq!(specs.len(), 1, "the chat draws the card: {block}");
    assert_eq!(specs[0]["type"], "taskTypes");
    assert_eq!(specs[0]["projectId"], "p1");
    assert_eq!(specs[0]["scope"], "project");
    assert_eq!(specs[0]["change"], "c1");
    assert_eq!(specs[0]["summary"], "Turned type \"qa\" off for the project.");
}

#[test]
fn an_undone_change_is_remembered_so_its_card_still_says_undone() {
    let (_root, global, project) = folders();
    disable(&global, &project, "qa");
    let id = catalog::history(&global, Some(&project), "project").unwrap()[0]["id"].as_str().unwrap().to_string();
    catalog::undo_change(&global, Some(&project), "project", Some(&id)).unwrap();
    assert_eq!(catalog::undone(&global, Some(&project), "project").unwrap(), vec![id.clone()]);
    let again = catalog::undo_change(&global, Some(&project), "project", Some(&id)).unwrap_err();
    assert!(again.contains("already undone"), "{again}");
    disable(&global, &project, "render_change");
    let next = catalog::history(&global, Some(&project), "project").unwrap()[0]["id"].as_str().unwrap().to_string();
    assert_ne!(next, id, "a new change never reuses an undone change's id");
    assert_eq!(catalog::undone(&global, Some(&project), "project").unwrap(), vec![id], "a later change keeps the undone list");
}

#[test]
fn a_project_with_no_settings_file_keeps_its_types_in_its_own_folder() {
    let root = tempfile::tempdir().unwrap();
    let (data, one, two) = (root.path().join("data"), root.path().join("one"), root.path().join("two"));
    for dir in [&data, &one, &two] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let first = catalog::project_dir(&data, &one).expect("a folder for a project with no settings file");
    let second = catalog::project_dir(&data, &two).unwrap();
    assert_ne!(first, second, "each project has its own");
    assert!(first.starts_with(&data), "{first:?} is in the data folder");
}
