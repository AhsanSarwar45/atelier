//! Provider-neutral ownership decision for complete native history.

use super::actor::ChatDb;

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
    let required = database
        .get_session(session_id.to_string())
        .await?
        .map(|session| super::store::import_recipe(&session.brand))
        .unwrap_or(super::store::IMPORT_RECIPE);
    if let Some(recipe) = database.imported_by(session_id.to_string()).await? {
        if recipe >= required {
            return Ok(HistoryChoice::Leave);
        }
        // The caller reached this decision only after resolving a complete
        // provider record. An older normalization generation must be allowed
        // to replace its cached provider transcript even when the app once
        // drove that session; otherwise migration fixes can never repair it.
        return Ok(HistoryChoice::Read);
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
                // Its OWN thread. Two chats cannot both be the same one another
                // program is holding, and the store now says so -- a shared id
                // here is a fixture describing something the app forbids
                // (bw-t26l.20).
                external_id: Some(format!("outside-{id}")),
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
        let path = root.path().join("db");
        let database = ChatDb::open(&path).unwrap();
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
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE session SET imported_at='then',imported_recipe=?1 WHERE id='local'",
                [super::super::store::IMPORT_RECIPE],
            )
            .unwrap();
        assert_eq!(
            complete_history_choice(&database, "local").await.unwrap(),
            HistoryChoice::Read,
            "a resolved provider record can upgrade its older cached transcript"
        );
        database.mark_imported("local".into()).await.unwrap();
        assert_eq!(
            complete_history_choice(&database, "local").await.unwrap(),
            HistoryChoice::Leave
        );
    }
}
