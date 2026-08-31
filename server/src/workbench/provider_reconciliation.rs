//! Provider-neutral ownership decision for complete native history.

use super::{actor::ChatDb, store::IMPORT_RECIPE};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryChoice {
    Read,
    Leave,
    KeepLocal,
}

pub async fn complete_history_choice(
    database: &ChatDb,
    session_id: &str,
) -> Result<HistoryChoice, String> {
    if database
        .imported_by(session_id.to_string())
        .await?
        .is_some_and(|recipe| recipe >= IMPORT_RECIPE)
    {
        return Ok(HistoryChoice::Leave);
    }
    if database.timeline_count(session_id.to_string()).await? > 0
        && database.was_driven_here(session_id.to_string()).await?
    {
        return Ok(HistoryChoice::KeepLocal);
    }
    Ok(HistoryChoice::Read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workbench::{protocol::Event, store::Session};
    use serde_json::json;

    async fn chat(database: &ChatDb, id: &str) {
        database
            .create_session(Session {
                id: id.into(),
                brand: "claude".into(),
                external_id: Some("outside".into()),
                project_id: "p".into(),
                project_path: "/p".into(),
                cwd: "/p".into(),
                model: None,
                permission_mode: "default".into(),
                effort: None,
                collaboration_mode: None,
                title: None,
                state: "dormant".into(),
                origin: "terminal".into(),
                created_at: "now".into(),
                last_active_at: "now".into(),
                last_spoke_at: None,
            })
            .await
            .unwrap();
    }

    async fn append(database: &ChatDb, id: &str, value: serde_json::Value) {
        let mut object = value.as_object().unwrap().clone();
        object.insert("sessionId".into(), json!(id));
        object.insert("seq".into(), json!(0));
        object.insert("at".into(), json!("now"));
        database
            .append(serde_json::from_value::<Event>(serde_json::Value::Object(object)).unwrap())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn complete_history_rebuilds_external_only_but_protects_local_turns() {
        let root = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&root.path().join("db")).unwrap();
        chat(&database, "external").await;
        append(&database,"external",json!({"type":"tool.started","toolCallId":"t","name":"Read","input":{},"title":"Read","parentToolCallId":null})).await;
        assert_eq!(
            complete_history_choice(&database, "external")
                .await
                .unwrap(),
            HistoryChoice::Read
        );

        chat(&database, "local").await;
        append(&database,"local",json!({"type":"session.started","brand":"claude","externalId":"outside","model":null,"cwd":"/p","permissionMode":"default","readOnly":false})).await;
        append(&database,"local",json!({"type":"tool.started","toolCallId":"t","name":"Read","input":{},"title":"Read","parentToolCallId":null})).await;
        assert_eq!(
            complete_history_choice(&database, "local").await.unwrap(),
            HistoryChoice::KeepLocal
        );
        database.mark_imported("local".into()).await.unwrap();
        assert_eq!(
            complete_history_choice(&database, "local").await.unwrap(),
            HistoryChoice::Leave
        );
    }
}
