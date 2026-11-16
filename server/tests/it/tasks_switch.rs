//! With tasks turned off, `atelier task` and `atelier grid` refuse, in a
//! plain word, before they reach the app: a chat that stumbles on them
//! learns only that tasks are off here.

use std::{fs, net::TcpListener, path::Path, process::{Command, Output}};

/// A port nothing listens on, so a command that does reach for the app
/// fails to connect instead of reaching a real one.
fn dead_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn run(cwd: &Path, data: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_atelier"))
        .args(args)
        .current_dir(cwd)
        .env("ATELIER_DATA_DIR", data)
        .env("ATELIER_CHAT_SESSION_ID", "chat-1")
        .env("ATELIER_PORT", dead_port().to_string())
        .output()
        .unwrap()
}

#[test]
fn task_and_grid_commands_say_tasks_are_off_when_the_install_turns_them_off() {
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().join("data");
    let root = scratch.path().join("project");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&root).unwrap();
    fs::write(data.join("tasks.json"), r#"{"enabled": false}"#).unwrap();
    for args in [&["task", "list"][..], &["task", "propose"], &["task", "types"], &["grid", "list"], &["grid", "next", "camera"]] {
        let out = run(&root, &data, args);
        let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(!out.status.success(), "atelier {} ran: {said}", args.join(" "));
        assert!(said.contains("Tasks are turned off"), "atelier {} did not say tasks are off: {said}", args.join(" "));
    }
}

#[test]
fn the_refusal_names_who_turned_tasks_off() {
    let scratch = tempfile::tempdir().unwrap();
    let data = scratch.path().join("data");
    let root = scratch.path().join("project");
    fs::create_dir_all(&data).unwrap();
    fs::create_dir_all(&root).unwrap();
    fs::write(data.join("tasks.json"), r#"{"enabled": false}"#).unwrap();
    let said = |out: Output| format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let app = said(run(&root, &data, &["task", "list"]));
    assert!(app.contains("turned off for this app"), "the app-wide switch is blamed on the project: {app}");

    fs::remove_file(data.join("tasks.json")).unwrap();
    let folder = atelier::workbench::tasks::switch::project_folder(&data, &root).unwrap();
    atelier::workbench::tasks::switch::write(&folder, Some(false)).unwrap();
    let project = said(run(&root, &data, &["task", "list"]));
    assert!(project.contains("turned off for this project"), "the project's switch is not named: {project}");
}
