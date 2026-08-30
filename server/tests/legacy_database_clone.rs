use atelier::workbench::actor::ChatDb;
use std::path::Path;

#[tokio::test]
#[ignore = "requires ATELIER_LEGACY_DB pointing at an isolated disposable clone"]
async fn isolated_legacy_database_survives_every_session_replay() {
    let path = std::env::var("ATELIER_LEGACY_DB")
        .expect("ATELIER_LEGACY_DB names the isolated database clone");
    let database = ChatDb::open(Path::new(&path)).expect("the cloned database opens");
    let sessions = database.list_sessions(None).await.expect("the worker lists sessions");
    assert_eq!(sessions.len(), 179);

    let mut events = 0usize;
    for session in sessions {
        events += database.events_since(session.id, 0).await
            .expect("the worker survives this legacy event stream").len();
    }
    assert_eq!(events, 1_114_782);
}
