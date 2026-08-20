//! File watcher SSE endpoint for real-time file change notifications.
//!
//! Provides Server-Sent Events for monitoring changes to a project's board.
//! What counts as a change is derived from where the board is actually stored:
//! a `.beads/issues.jsonl` file, or a Dolt database under `.beads/dolt/` or
//! `.beads/embeddeddolt/`.
//! For the jsonl store this module also recomputes epic statuses based on
//! their children's statuses.

use axum::{
    extract::Query,
    response::sse::{Event, Sse},
};
use futures::stream::Stream;
use notify::{
    event::ModifyKind, Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::{Deserialize, Serialize};
use std::{
    convert::Infallible,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::{broadcast::error::RecvError, mpsc};
use tokio_stream::wrappers::ReceiverStream;
use tracing::{error, info, warn};

use super::beads::{boards_read_again, recompute_epic_statuses, refresh_board, resolve_issues_path};
use super::validate_path_security;
use crate::db::Database;
use crate::dolt::DoltManager;
use axum::Extension;
use std::sync::Arc;

/// How long a burst of writes must be quiet before it is reported, in ms.
/// A single logical board write produces several filesystem writes.
const DEBOUNCE_MS: u64 = 100;

/// The names a Dolt board is kept under, inside `.beads`.
const DOLT_DIRS: [&str; 2] = ["dolt", "embeddeddolt"];

/// Where a project's board is stored, and therefore what has to change on disk
/// for the board itself to have changed.
enum BoardStore {
    /// Issues live in a `.beads/issues.jsonl` file.
    Jsonl { file: PathBuf },
    /// Issues live in a Dolt database, run by a server under `.beads/dolt/` or
    /// by beads itself under `.beads/embeddeddolt/`. Rows are persisted into
    /// the database's chunk journal, so that is what moves on a write.
    Dolt { root: PathBuf },
}

impl BoardStore {
    /// Decides a project's store from what exists on disk. A Dolt database
    /// takes precedence: when one is present the read path serves the board
    /// from it, so it is also what the board changes with.
    ///
    /// A Dolt board sits under one of two names: `dolt` when it belongs to a
    /// server, `embeddeddolt` when beads runs the database itself. Looking for
    /// only the first left a board of the second kind waiting on a
    /// `.beads/issues.jsonl` that is never written, so no card another agent
    /// moved ever reached the screen (bw-uiyz.15).
    fn resolve(project_path: &Path) -> Self {
        let beads = project_path.join(".beads");
        for name in DOLT_DIRS {
            let root = beads.join(name);
            if root.is_dir() {
                return BoardStore::Dolt { root };
            }
        }
        BoardStore::Jsonl {
            file: resolve_issues_path(project_path),
        }
    }

    /// The directory to hand to the filesystem watcher. For the jsonl store
    /// this is the containing directory, because the file may not exist yet.
    fn watch_root(&self) -> PathBuf {
        match self {
            BoardStore::Jsonl { file } => file
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(|| file.clone()),
            BoardStore::Dolt { root } => root.clone(),
        }
    }

    /// The path reported to the client as the thing that changed.
    fn reported_path(&self) -> &Path {
        match self {
            BoardStore::Jsonl { file } => file,
            BoardStore::Dolt { root } => root,
        }
    }

    /// Whether a filesystem event under the watch root means the board changed.
    fn is_board_change(&self, changed: &Path) -> bool {
        match self {
            BoardStore::Jsonl { file } => {
                changed.ends_with("issues.jsonl")
                    || changed.ends_with(".beads")
                    || changed == file
            }
            // Only the database's chunk journal carries rows. Dolt keeps its
            // query statistics in a second database under the server root and
            // rewrites it on a background schedule with no board write behind
            // it; treating that as a change would refresh an idle board.
            BoardStore::Dolt { .. } => {
                let mut under_noms = false;
                for component in changed.components() {
                    match component.as_os_str().to_str() {
                        Some("stats") => return false,
                        Some("noms") => under_noms = true,
                        _ => {}
                    }
                }
                under_noms
            }
        }
    }
}

/// Query parameters for the watch endpoint.
#[derive(Debug, Deserialize)]
pub struct WatchParams {
    /// The project path to watch for changes.
    pub path: String,
}

/// File change event sent to clients.
#[derive(Debug, Serialize)]
pub struct FileChangeEvent {
    /// The path of the changed file.
    pub path: String,
    /// The type of change (modified, created, removed).
    #[serde(rename = "type")]
    pub change_type: String,
}

/// SSE endpoint for watching a project's board for changes.
///
/// Takes the project directory as `path`, and returns a Server-Sent Events
/// stream of board change notifications.
pub async fn watch_beads(
    Extension(dolt_manager): Extension<Arc<DoltManager>>,
    Extension(db): Extension<Arc<Database>>,
    Query(params): Query<WatchParams>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let project_path = PathBuf::from(&params.path);

    // Reject dolt:// paths — no filesystem to watch
    if let Err(e) = validate_path_security(&project_path) {
        warn!("Watch rejected for invalid path: {}", e);
        let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(1);
        drop(tx); // Close immediately
        return Sse::new(ReceiverStream::new(rx));
    }

    let store = BoardStore::resolve(&project_path);

    info!("Starting board watcher for: {:?}", store.reported_path());

    // Create channel for events with buffer for debouncing
    let (tx, rx) = mpsc::channel::<Result<Event, Infallible>>(100);

    // Spawn the watcher task
    let watched = project_path.to_string_lossy().to_string();
    tokio::spawn(async move {
        if let Err(e) = run_watcher(store, watched, tx, dolt_manager, db).await {
            error!("Board watcher error: {}", e);
        }
    });

    let stream = ReceiverStream::new(rx);
    Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(30))
            .text("ping"),
    )
}

/// Runs the board watcher and sends events through the channel.
async fn run_watcher(
    store: BoardStore,
    watched: String,
    tx: mpsc::Sender<Result<Event, Infallible>>,
    dolt_manager: Arc<DoltManager>,
    db: Arc<Database>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Create a channel for notify events
    let (notify_tx, mut notify_rx) = mpsc::channel(100);

    // Create the watcher
    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // Only forward relevant events
                let _ = notify_tx.blocking_send(event);
            }
        },
        Config::default().with_poll_interval(Duration::from_millis(100)),
    )?;

    let watch_root = store.watch_root();

    // Fall back to the parent when the store's directory has not been created
    // yet, so a board that appears later still starts reporting.
    let actual_watch_path = if watch_root.exists() {
        watch_root.clone()
    } else if let Some(parent) = watch_root.parent().filter(|p| p.exists()) {
        warn!("Watch path does not exist yet: {:?}", watch_root);
        parent.to_path_buf()
    } else {
        error!("Neither watch path nor parent exists: {:?}", watch_root);
        return Ok(());
    };

    watcher.watch(&actual_watch_path, RecursiveMode::Recursive)?;
    info!("Board watcher active on: {:?}", actual_watch_path);

    let reported_path = store.reported_path().to_string_lossy().to_string();

    // Send initial connection event
    let connect_event = Event::default().data(
        serde_json::to_string(&FileChangeEvent {
            path: reported_path.clone(),
            change_type: "connected".to_string(),
        })
        .unwrap_or_default(),
    );
    let _ = tx.send(Ok(connect_event)).await;

    // Trailing-edge debounce: a burst is reported once it goes quiet, so the
    // client always refetches after the final write rather than before it.
    let debounce = Duration::from_millis(DEBOUNCE_MS);
    let mut pending: Option<&'static str> = None;
    let mut read_again = boards_read_again();

    loop {
        tokio::select! {
            // Bias so a queued event always wins over a timer that is already
            // due, keeping the quiet period measured from the last write.
            biased;

            received = notify_rx.recv() => {
                let Some(event) = received else { break };

                if !event.paths.iter().any(|p| store.is_board_change(p)) {
                    continue;
                }

                let change_type = match event.kind {
                    EventKind::Create(_) => "created",
                    EventKind::Modify(ModifyKind::Data(_)) => "modified",
                    EventKind::Modify(_) => "modified",
                    EventKind::Remove(_) => "removed",
                    _ => continue, // Ignore other events
                };

                pending = Some(change_type);
            }

            // A board read again behind everyone's back, ours or another
            // screen's: whoever is watching this one is told, and asks for
            // what changed out of a board that is already read (bw-uiyz.17).
            read_again = read_again.recv() => {
                match read_again {
                    Ok(board) if board == watched => {
                        let sse_event = Event::default().data(
                            serde_json::to_string(&FileChangeEvent {
                                path: reported_path.clone(),
                                change_type: "modified".to_string(),
                            })
                            .unwrap_or_default(),
                        );
                        if tx.send(Ok(sse_event)).await.is_err() {
                            info!("Client disconnected, stopping watcher");
                            break;
                        }
                    }
                    // Another project's board, or we fell behind the others'.
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }

            _ = tokio::time::sleep(debounce), if pending.is_some() => {
                let change_type = pending.take().unwrap_or("modified");

                info!("Board change detected: {:?}", reported_path);

                // Only the jsonl store has a file to recompute epic status
                // from; a Dolt board is served from the database.
                if let BoardStore::Jsonl { file } = &store {
                    if change_type == "modified" || change_type == "created" {
                        match recompute_epic_statuses(file) {
                            Ok(updated_epics) => {
                                if !updated_epics.is_empty() {
                                    info!("Updated epic statuses: {:?}", updated_epics);
                                }
                            }
                            Err(e) => {
                                warn!("Failed to recompute epic statuses: {}", e);
                            }
                        }
                    }
                }

                // The board on disk moved, so what we last read of it is no
                // longer the truth — but throwing it away only moves the wait
                // onto the next reader. It is read again here, with nobody
                // waiting, and the screen is told once that read has landed
                // (bw-uiyz.17). The telling is the arm above; if the read
                // could not run we say so ourselves rather than leave the
                // screen holding an answer the change made wrong.
                if !refresh_board(&dolt_manager, &db, &watched).await {
                    let sse_event = Event::default().data(
                        serde_json::to_string(&FileChangeEvent {
                            path: reported_path.clone(),
                            change_type: change_type.to_string(),
                        })
                        .unwrap_or_default(),
                    );
                    if tx.send(Ok(sse_event)).await.is_err() {
                        info!("Client disconnected, stopping watcher");
                        break;
                    }
                }
            }
        }
    }

    // Watcher is automatically dropped and cleaned up here
    info!("Board watcher stopped");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_file_change_event_serialization() {
        let event = FileChangeEvent {
            path: "/test/path".to_string(),
            change_type: "modified".to_string(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("\"path\":\"/test/path\""));
        assert!(json.contains("\"type\":\"modified\""));
    }

    #[test]
    fn test_watch_params_deserialization() {
        let params: WatchParams =
            serde_json::from_str(r#"{"path": "/test/project"}"#).unwrap();
        assert_eq!(params.path, "/test/project");
    }

    #[test]
    fn jsonl_store_reports_only_its_own_file() {
        let store = BoardStore::Jsonl {
            file: PathBuf::from("/p/.beads/issues.jsonl"),
        };
        assert!(store.is_board_change(Path::new("/p/.beads/issues.jsonl")));
        assert!(!store.is_board_change(Path::new("/p/.beads/config.yaml")));
    }

    #[test]
    fn dolt_store_reports_a_row_write() {
        let store = BoardStore::Dolt {
            root: PathBuf::from("/p/.beads/dolt"),
        };
        assert!(store.is_board_change(Path::new(
            "/p/.beads/dolt/cor/.dolt/noms/journal.idx"
        )));
    }

    #[test]
    fn dolt_store_ignores_its_own_statistics() {
        let store = BoardStore::Dolt {
            root: PathBuf::from("/p/.beads/dolt"),
        };
        // Written by a background job with no board write behind it.
        assert!(!store.is_board_change(Path::new(
            "/p/.beads/dolt/.dolt/stats/.dolt/noms/journal.idx"
        )));
        // Locks and spool files move constantly during a write.
        assert!(!store.is_board_change(Path::new("/p/.beads/dolt/cor/.dolt/temptf")));
    }

    #[test]
    fn a_dolt_project_resolves_to_the_dolt_store() {
        let dir = std::env::temp_dir().join("beads-web-watch-store-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".beads").join("dolt")).unwrap();

        assert!(matches!(BoardStore::resolve(&dir), BoardStore::Dolt { .. }));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_board_dolt_runs_itself_resolves_to_the_dolt_store() {
        // The board this app is built on is one of these, and it was being
        // watched as a jsonl board that has no file (bw-uiyz.15).
        let dir = std::env::temp_dir().join("beads-web-watch-store-test-embedded");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".beads").join("embeddeddolt").join("bw")).unwrap();

        let store = BoardStore::resolve(&dir);
        assert!(matches!(store, BoardStore::Dolt { .. }));
        assert!(store.is_board_change(&dir.join(".beads/embeddeddolt/bw/.dolt/noms/journal.idx")));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_project_without_dolt_resolves_to_the_jsonl_store() {
        let dir = std::env::temp_dir().join("beads-web-watch-store-test-jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".beads")).unwrap();

        assert!(matches!(BoardStore::resolve(&dir), BoardStore::Jsonl { .. }));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
