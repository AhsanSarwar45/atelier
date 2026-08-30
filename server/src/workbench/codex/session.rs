//! Transactional bridge from one native Codex driver to the durable chat actor.

use super::live::{NativeCodexDriver, StartOptions};
use super::normalize::DriverEvent;
use super::transport::CodexTransportConfig;
use crate::workbench::actor::ChatDb;
use crate::workbench::protocol::Event;
use crate::workbench::store::Session;
use chrono::Utc;
use serde_json::{json, Value};

pub struct NativeCodexSession {
    database: ChatDb,
    driver: NativeCodexDriver,
    session_id: String,
}

impl NativeCodexSession {
    /// Start the provider before making its database row visible. A missing or
    /// incompatible Codex executable therefore cannot leave a chat which the
    /// browser can open but nobody can drive.
    pub async fn start(
        database: ChatDb,
        config: CodexTransportConfig,
        options: StartOptions,
        mut session: Session,
    ) -> Result<Self, String> {
        let (driver, opened) = NativeCodexDriver::start(config, options)
            .await
            .map_err(|error| error.to_string())?;
        if let Some(started) = opened
            .iter()
            .find(|event| event["type"] == "session.started")
        {
            session.external_id = started["externalId"].as_str().map(str::to_string);
            session.model = started["model"].as_str().map(str::to_string);
            session.effort = started["effort"].as_str().map(str::to_string);
            session.collaboration_mode = started["collaborationMode"].as_str().map(str::to_string);
        }
        if let Err(error) = database.create_session(session.clone()).await {
            driver.close().await;
            return Err(error);
        }
        let mut native = Self {
            database,
            driver,
            session_id: session.id,
        };
        native.persist(opened).await?;
        Ok(native)
    }

    async fn persist(&mut self, events: Vec<DriverEvent>) -> Result<Vec<Event>, String> {
        let mut appended = Vec::new();
        for bare in events {
            let event = envelop(&self.session_id, bare)?;
            if let Some(event) = self.database.append(event).await? {
                appended.push(event);
            }
        }
        Ok(appended)
    }

    pub async fn send(&mut self, text: &str) -> Result<Vec<Event>, String> {
        let events = self
            .driver
            .send(text)
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn next(&mut self) -> Result<Vec<Event>, String> {
        let events = self
            .driver
            .next_events()
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn answer(
        &mut self,
        ask_id: &str,
        choice: &str,
        value: Option<&str>,
    ) -> Result<Vec<Event>, String> {
        let events = self
            .driver
            .answer(ask_id, choice, value)
            .await
            .map_err(|error| error.to_string())?;
        self.persist(events).await
    }

    pub async fn close(&self) {
        self.driver.close().await;
    }
}

fn envelop(session_id: &str, bare: DriverEvent) -> Result<Event, String> {
    let mut object = bare
        .as_object()
        .cloned()
        .ok_or_else(|| "Codex event was not an object".to_string())?;
    object.insert("sessionId".into(), json!(session_id));
    object.insert("seq".into(), json!(0));
    object.insert(
        "at".into(),
        json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    );
    serde_json::from_value(Value::Object(object)).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn session(id: &str) -> Session {
        Session {
            id: id.into(),
            brand: "codex".into(),
            external_id: None,
            project_id: "project-1".into(),
            project_path: "/project".into(),
            cwd: "/project".into(),
            model: Some("gpt-5".into()),
            permission_mode: "on-request".into(),
            effort: Some("high".into()),
            collaboration_mode: None,
            title: Some("Chat".into()),
            state: "idle".into(),
            origin: "app".into(),
            created_at: "2026-08-30T00:00:00.000Z".into(),
            last_active_at: "2026-08-30T00:00:00.000Z".into(),
            last_spoke_at: None,
        }
    }

    fn options() -> StartOptions {
        StartOptions {
            cwd: PathBuf::from("/project"),
            resume: None,
            model: Some("gpt-5".into()),
            permission_mode: "on-request".into(),
            effort: Some("high".into()),
            collaboration_mode: None,
            instructions: "rules".into(),
        }
    }

    #[tokio::test]
    async fn native_codex_process_failed_startup_never_creates_an_orphan_chat() {
        let directory = tempfile::tempdir().unwrap();
        let database = ChatDb::open(&directory.path().join("workbench.db")).unwrap();
        let mut config = CodexTransportConfig::app_server(PathBuf::from("/project").as_path());
        config.executable = PathBuf::from("/definitely/not/a/codex-executable");
        assert!(
            NativeCodexSession::start(database.clone(), config, options(), session("orphan"))
                .await
                .is_err()
        );
        assert!(database.list_sessions(None).await.unwrap().is_empty());
    }
}
