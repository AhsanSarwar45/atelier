//! The chat helper, carried inside the product.
//!
//! Talking to an agent is one of the things this is for, so the helper travels
//! in the binary and is written out beside the data the first time the product
//! runs. Before this it was started from the machine it was BUILT on — the
//! path was baked in at compile time — so on any other computer the Chat tab
//! had nothing behind it (bw-8um.3.9).
//!
//! ## Two sets, one folder, and why the shape matters
//!
//! The helper's own files sit under `workbench/`, and they read a dozen
//! modules the screens read too, by walking up out of their own folder:
//! `../../../src/workbench/protocol.ts`. So the two are laid down keeping the
//! distance between them, which is what makes those imports resolve without a
//! single line of the helper being rewritten:
//!
//! ```text
//! <helper>/workbench/src/server.ts       <- what gets started
//! <helper>/workbench/package.json        <- and the lock beside it
//! <helper>/workbench/node_modules/…      <- fetched here, once, on first run
//! <helper>/src/workbench/*.ts            <- the modules it shares with the screens
//! ```
//!
//! Both sets share one marker, so a change to either rewrites both and no
//! half-updated helper is ever left behind.
//!
//! ## What is NOT carried, and why
//!
//! The kit the helper talks to Claude with. It is Anthropic's, published under
//! "all rights reserved", so putting a copy inside a binary we hand to somebody
//! else would be us redistributing their program. It is fetched from npm
//! instead, on the reader's own machine, against the lock this build carries —
//! which is where they would have got it anyway, and leaves the licence between
//! them and its author.
//!
//! Claude Code itself is not carried either, for a second reason on top of that
//! one: the kit ships a copy weighing a third of a gigabyte per platform, and
//! the reader already has the one they signed into. `workbench/src/claude-program.ts`
//! is where the helper goes looking for theirs.

use rust_embed::Embed;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use base64::Engine;
use serde::Serialize;

/// The helper's own files: everything it runs, and the two package files that
/// say what it needs. Its tests stay behind — they are for this repository,
/// not for the reader's machine.
#[derive(Embed)]
#[folder = "../workbench/"]
#[include = "package.json"]
#[include = "package-lock.json"]
#[include = "src/**/*.ts"]
#[exclude = "src/__tests__/*"]
struct Helper;

/// The modules the helper shares with the screens.
///
/// Every plain module is carried, not the dozen the helper reads today: the
/// helper gaining an import is a one-line change nobody would think to mirror
/// here, and the cost of being wrong is a chat that dies on a stranger's
/// machine. The `.tsx` files are the screens themselves and no help to a
/// program with no browser in it.
#[derive(Embed)]
#[folder = "../src/workbench/"]
#[include = "*.ts"]
// A pattern here matches across folders — `*.ts` alone reaches into
// `__tests__/` — so what stays behind is said outright.
#[exclude = "__tests__/*"]
struct Shared;

/// The helper's own package, under the folder everything is laid down in.
const PACKAGE: &str = "workbench";

/// The file that is started, under the same folder.
const ENTRY: &str = "workbench/src/server.ts";

/// The one file that says the kit really is there. A `node_modules` folder can
/// exist and hold nothing after an install that was interrupted.
const KIT: &str = "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

/// What the kit that is there was fetched against.
const KIT_MARKER: &str = ".kit";

/// A helper written out and ready to be started.
pub struct Laid {
    /// The file `node` is pointed at.
    pub entry: PathBuf,
    /// The folder its package sits in, where the kit is fetched.
    pub package: PathBuf,
}

#[derive(Serialize)]
struct PresentationRequest<'a> {
    args: &'a [String],
    stdin: String,
    files: std::collections::BTreeMap<String, String>,
}

fn presentation_request(rest: &[String], stdin: String) -> Result<PresentationRequest<'_>, String> {
    let mut files = std::collections::BTreeMap::new();
    for (at, word) in rest.iter().enumerate() {
        if matches!(word.as_str(), "--file" | "--input" | "--before" | "--after") {
            let path = rest.get(at + 1).ok_or_else(|| format!("missing value for {word}"))?;
            let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
            files.insert(path.clone(), base64::engine::general_purpose::STANDARD.encode(bytes));
        }
    }
    Ok(PresentationRequest { args: rest, stdin, files })
}

/// Hand temporary files to the running app; only its sidecar writes durable media.
pub async fn present(rest: &[String]) -> Result<i32, String> {
    use std::io::Read;
    let mut stdin = String::new();
    std::io::stdin().read_to_string(&mut stdin).map_err(|error| format!("stdin: {error}"))?;
    let port = std::env::var("ATELIER_PORT")
        .or_else(|_| std::env::var("BEADS_WEB_PORT"))
        .ok().and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    let output = present_to(rest, stdin, &format!("http://127.0.0.1:{port}")).await?;
    print!("{output}");
    Ok(0)
}

async fn present_to(rest: &[String], stdin: String, base: &str) -> Result<String, String> {
    let request = presentation_request(rest, stdin)?;
    let response = reqwest::Client::new()
        .post(format!("{base}/api/workbench/present"))
        .json(&request)
        .send().await.map_err(|error| format!("the running Atelier app could not receive the presentation: {error}"))?;
    let status = response.status();
    let value: serde_json::Value = response.json().await
        .map_err(|error| format!("Atelier returned an unreadable presentation response: {error}"))?;
    if !status.is_success() {
        return Err(value.get("error").and_then(|error| error.as_str()).unwrap_or("Atelier refused the presentation").to_string());
    }
    let output = value.get("output").and_then(|output| output.as_str())
        .ok_or_else(|| "Atelier returned no presentation output".to_string())?;
    Ok(output.to_string())
}

/// Lay the helper down beside the data.
///
/// Returns what went wrong rather than stopping the program: a copy that
/// cannot write there still serves the board, and only the Chat tab suffers.
pub fn install() -> Result<Laid, String> {
    let Some(dir) = crate::identity::helper_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
    };

    let mut files = crate::laid_down::gather::<Helper>(PACKAGE)?;
    files.extend(crate::laid_down::gather::<Shared>("src/workbench")?);
    crate::laid_down::install(&dir, &files)?;

    Ok(Laid { entry: dir.join(ENTRY), package: dir.join(PACKAGE) })
}

/// Fetch the kit the helper talks to Claude with, if it is not already there.
///
/// Guarded by the lock this build carries, so it is paid once per machine and
/// again only when the lock changes. `--omit=optional` leaves behind the copy
/// of Claude Code the kit would otherwise bring — a third of a gigabyte per
/// platform, for a program the reader already has — and `--omit=dev` leaves
/// the type declarations, which nothing reads at run time.
pub async fn fetch_kit(package: &Path) -> Result<(), String> {
    let lock = std::fs::read(package.join("package-lock.json"))
        .map_err(|e| format!("{}: {e}", package.join("package-lock.json").display()))?;
    let want = crate::laid_down::fingerprint(&vec![("package-lock.json".to_string(), lock)]);

    if already_fetched(package, &want) {
        return Ok(());
    }

    let npm = if cfg!(windows) { "npm.cmd" } else { "npm" };
    let run = tokio::process::Command::new(npm)
        .args(["ci", "--omit=optional", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"])
        .current_dir(package)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("{npm} could not be run ({e}); the chat needs it once, to fetch its kit"))?;

    if !run.status.success() {
        let said = String::from_utf8_lossy(&run.stderr);
        return Err(format!(
            "{npm} could not fetch the chat's kit ({}). It is fetched once, and needs the network \
             the first time: {}",
            run.status,
            said.trim()
        ));
    }
    if !package.join(KIT).exists() {
        return Err(format!("{npm} finished but {KIT} is not there"));
    }
    crate::laid_down::write_marker(package, KIT_MARKER, &want)
}

/// Whether the kit in `package` is the one `want` names.
///
/// Both halves are needed. The marker alone would trust a folder somebody
/// cleaned out, or an install that was interrupted half way; the file alone
/// would keep a kit fetched against a lock this build has moved past.
fn already_fetched(package: &Path, want: &str) -> bool {
    package.join(KIT).exists() && crate::laid_down::marker_says(package, KIT_MARKER, want)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn presentation_files_go_to_the_running_app_instead_of_its_data_directory() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc, Mutex};

        let seen = Arc::new(Mutex::new(None));
        let received = seen.clone();
        let app = Router::new().route("/api/workbench/present", post(move |Json(body): Json<serde_json::Value>| {
            *received.lock().unwrap() = Some(body);
            async { Json(serde_json::json!({ "output": "validated transcript\n" })) }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let temporary = tempfile::tempdir().unwrap();
        let image = temporary.path().join("agent-picture.png");
        std::fs::write(&image, b"temporary bytes").unwrap();
        let args = vec!["image".to_string(), "--file".to_string(), image.display().to_string(), "--alt".to_string(), "Proof".to_string()];
        let output = present_to(&args, String::new(), &format!("http://{address}")).await.unwrap();

        assert_eq!(output, "validated transcript\n");
        let request = seen.lock().unwrap().take().unwrap();
        let uploaded = request["files"][image.display().to_string()].as_str().unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(uploaded).unwrap(), b"temporary bytes");
    }

    #[test]
    fn the_build_carries_the_file_that_gets_started() {
        let names: Vec<String> = Helper::iter().map(|n| n.to_string()).collect();
        assert!(
            names.iter().any(|n| n == "src/server.ts"),
            "the helper's entry is not in this build; it carries {names:?}"
        );
        for driver in ["src/drivers/claude.ts", "src/drivers/codex.ts", "src/drivers/index.ts"] {
            assert!(names.iter().any(|n| n == driver), "{driver} is not carried");
        }
    }

    #[test]
    fn the_build_carries_what_says_which_kit_to_fetch() {
        let names: Vec<String> = Helper::iter().map(|n| n.to_string()).collect();
        for needed in ["package.json", "package-lock.json"] {
            assert!(names.iter().any(|n| n == needed), "{needed} is not carried; it has {names:?}");
        }
    }

    #[test]
    fn nothing_written_for_this_repository_is_carried() {
        for name in Helper::iter() {
            assert!(!name.contains("__tests__"), "{name} is a test of ours, not part of the helper");
        }
        for name in Shared::iter() {
            assert!(!name.contains("__tests__"), "{name} is a test of ours, not part of the helper");
        }
    }

    #[test]
    fn the_build_carries_every_shared_module_the_helper_reads() {
        let names: Vec<String> = Shared::iter().map(|n| n.to_string()).collect();
        // What `workbench/src` imports out of `src/workbench` today. Named one
        // by one so a module going missing is a red test here rather than a
        // dead Chat tab on somebody else's computer.
        for needed in [
            "chat-state.ts",
            "context-window.ts",
            "fold.ts",
            "imported-history.ts",
            "link-rules.ts",
            "machine-words.ts",
            "message-filter.ts",
            "plan-usage.ts",
            "protocol.ts",
            "running.ts",
            "token-picture.ts",
            "window-now.ts",
            "chat-widgets.ts",
        ] {
            assert!(names.iter().any(|n| n == needed), "{needed} is not carried; it has {names:?}");
        }
    }

    #[test]
    fn no_screen_is_carried_into_a_program_with_no_browser() {
        for name in Shared::iter() {
            assert!(!name.ends_with(".tsx"), "{name} is a screen, not something the helper runs");
        }
    }

    #[test]
    fn nothing_of_anthropics_own_travels_inside_this_product() {
        // The kit is published under "all rights reserved", so a copy of it in
        // here would be us redistributing somebody else's program. It is
        // fetched on the reader's machine instead.
        for name in Helper::iter().chain(Shared::iter()) {
            assert!(
                !name.contains("node_modules"),
                "{name} is somebody else's package, and this build must not carry one"
            );
        }
    }

    #[test]
    fn the_kit_is_fetched_where_node_looks_for_it_from_the_file_that_gets_started() {
        // `node` resolving a package from `<helper>/workbench/src/server.ts`
        // walks up: `workbench/src/node_modules`, then `workbench/node_modules`.
        // The second is the package folder the kit is fetched into, and this
        // says so in the one place a change to either constant would break it
        // silently.
        let entry = PathBuf::from(ENTRY);
        let from = entry.parent().expect("the entry is inside a folder");
        assert_eq!(from.parent().expect("and that folder is inside the package"), Path::new(PACKAGE));
        assert!(KIT.starts_with("node_modules/"));
    }

    #[test]
    fn the_shared_modules_sit_where_the_helper_reaches_for_them() {
        // `workbench/src/drivers/claude.ts` names them
        // `../../../src/workbench/protocol.ts`, so three steps up from the
        // driver's own folder has to land where they are laid down.
        let driver = PathBuf::from("workbench/src/drivers/claude.ts");
        let mut up = driver.parent().expect("the driver is inside a folder").to_path_buf();
        for _ in 0..3 {
            up = up.parent().expect("and there is somewhere above it").to_path_buf();
        }
        assert_eq!(up.join("src/workbench"), PathBuf::from("src/workbench"));
    }

    /// A folder with a kit in it, fetched against `marker`.
    fn fetched(dir: &Path, marker: &str) {
        std::fs::create_dir_all(dir.join(KIT).parent().unwrap()).unwrap();
        std::fs::write(dir.join(KIT), b"the kit").unwrap();
        crate::laid_down::write_marker(dir, KIT_MARKER, marker).unwrap();
    }

    #[test]
    fn a_kit_already_fetched_against_this_lock_is_not_fetched_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        fetched(dir.path(), "this lock");
        assert!(already_fetched(dir.path(), "this lock"));
    }

    #[test]
    fn a_kit_fetched_against_an_older_lock_is_fetched_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        fetched(dir.path(), "an older lock");
        assert!(!already_fetched(dir.path(), "this lock"));
    }

    #[test]
    fn a_folder_with_no_kit_in_it_is_fetched_into_however_the_marker_reads() {
        // The marker says this lock was already fetched, but the kit is not
        // there — an install that was interrupted, or a folder somebody
        // cleaned out. Starting a helper that cannot import anything is worse
        // than paying the fetch again.
        let dir = tempfile::tempdir().expect("a temporary directory");
        crate::laid_down::write_marker(dir.path(), KIT_MARKER, "this lock").unwrap();
        assert!(!already_fetched(dir.path(), "this lock"));
    }

    #[test]
    fn a_folder_nothing_has_ever_been_fetched_into_is_fetched_into() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        assert!(!already_fetched(dir.path(), "this lock"));
    }
}
