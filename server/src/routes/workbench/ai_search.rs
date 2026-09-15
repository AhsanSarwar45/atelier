//! The chats as an AI search source (bw-21a2.5, bw-21a2.6).
//!
//! `POST /search/ask` hands a question to the agent chosen in Settings, which
//! finds the chats with `search_chats` and `read_chat` and names them. The run
//! itself, and the tools' endpoint, are shared with every search
//! (search/agent.rs); this says what the tools are and checks every chat named.

use super::{projects_named, ApiError, WorkbenchState};
use crate::routes::search_settings::{search_settings, SearchSettings, DEFAULT_TIME_LIMIT};
use crate::search::agent::{self, read_only, tool_error, tool_text, Called, Source, Steps};
use crate::search::named::Named;
use crate::workbench::search_index::{SearchIndex, Sort};
use axum::{extract::State, http::StatusCode, response::Response, Json};
use futures::future::BoxFuture;
use futures::FutureExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// How to search the chats, handed to the agent with the question.
const SKILL: &str = include_str!("../../../../machinery/skills/chat-search/SKILL.md");

struct Chats {
    index: SearchIndex,
    projects: Option<Arc<crate::db::Database>>,
}

impl Source for Chats {
    fn name(&self) -> &'static str {
        "chats"
    }

    fn skill(&self) -> &'static str {
        SKILL
    }

    fn tools(&self) -> Value {
        json!([
            {
                "name": "search_chats",
                "description": "Search every chat. Every word must appear somewhere in a chat. Supports \"phrases\", -word, title:, me:, agent:, tool:, project:, provider:, after:, before: and card:. Returns each chat once with its id, title, project, provider, last activity, match count and up to three snippets.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {"type":"string","description":"The words and keys to search for"},
                        "sort": {"type":"string","enum":["relevance","newest"]},
                        "offset": {"type":"integer","minimum":0},
                        "limit": {"type":"integer","minimum":1,"maximum":30}
                    },
                    "required": ["query"]
                },
                "annotations": read_only(),
            },
            {
                "name": "read_chat",
                "description": "Read one chat by id: its title and project, then what was said in order, a page at a time. Pass the returned next as offset for more.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "id": {"type":"string","description":"A chat id from search_chats"},
                        "offset": {"type":"integer","minimum":0},
                        "limit": {"type":"integer","minimum":1,"maximum":200}
                    },
                    "required": ["id"]
                },
                "annotations": read_only(),
            }
        ])
    }

    fn call(self: Arc<Self>, tool: String, arguments: Value, steps: Steps) -> BoxFuture<'static, Called> {
        async move {
            let number = |name: &str| arguments[name].as_u64().map(|n| n as usize);
            let offset = number("offset").unwrap_or(0);
            if tool == "search_chats" {
                let Some(query) = arguments["query"].as_str().map(str::to_string) else {
                    return Ok(tool_error("query is required"));
                };
                let _ = steps.send(format!("Searched {}", query.trim()));
                let sort = match arguments["sort"].as_str() {
                    Some("newest") => Sort::Newest,
                    _ => Sort::Relevance,
                };
                let limit = number("limit").unwrap_or(10).clamp(1, 30);
                let found = tokio::task::spawn_blocking(move || {
                    let parsed =
                        crate::workbench::search_query::parse(query.trim_start(), chrono::Local::now());
                    let ids = match (&self.projects, parsed.projects.is_empty()) {
                        (Some(projects), false) => projects_named(projects, &parsed.projects),
                        _ => Vec::new(),
                    };
                    self.index.search_chats(&parsed, &ids, sort, offset, limit)
                })
                .await
                .map_err(|error| (-32603, error.to_string()))?;
                return Ok(match found {
                    Err(error) => tool_error(&error),
                    Ok(page) => tool_text(json!({
                        "chats": page.chats.iter().map(|chat| json!({
                            "id": chat.session_id,
                            "title": chat.title,
                            "project": chat.project_path,
                            "provider": chat.brand,
                            "lastActiveAt": chat.last_active_at,
                            "matches": chat.matches,
                            "snippets": chat.snippets.iter().map(|snippet| json!({
                                "messageId": snippet.message_id,
                                "field": snippet.field,
                                "text": snippet.segments.iter().map(|s| s.text.as_str()).collect::<String>(),
                            })).collect::<Vec<_>>(),
                        })).collect::<Vec<_>>(),
                        "next": page.next,
                    })),
                });
            }
            let Some(id) = arguments["id"].as_str().map(str::to_string) else {
                return Ok(tool_error("id is required"));
            };
            let limit = number("limit").unwrap_or(60).clamp(1, 200);
            let read = tokio::task::spawn_blocking(move || self.index.chat_words(&id, offset, limit))
                .await
                .map_err(|error| (-32603, error.to_string()))?;
            Ok(match read {
                Err(error) => tool_error(&error),
                Ok(None) => tool_error("No chat has that id."),
                Ok(Some(chat)) => {
                    let named = chat.title.clone().unwrap_or_else(|| chat.session_id.clone());
                    let _ = steps.send(format!("Read {named}"));
                    tool_text(serde_json::to_value(chat).unwrap_or_default())
                }
            })
        }
        .boxed()
    }

    fn found(self: Arc<Self>, named: Vec<Named>) -> BoxFuture<'static, Vec<Option<Value>>> {
        async move {
            tokio::task::spawn_blocking(move || {
                named
                    .iter()
                    .map(|named| {
                        let chat = self.index.chat_words(&named.id, 0, 0).ok().flatten()?;
                        Some(json!({
                            "sessionId": chat.session_id,
                            "title": chat.title,
                            "projectId": chat.project_id,
                            "projectPath": chat.project_path,
                            "brand": chat.brand,
                            "lastActiveAt": chat.last_active_at,
                        }))
                    })
                    .collect()
            })
            .await
            .unwrap_or_default()
        }
        .boxed()
    }
}

#[derive(Deserialize)]
pub(super) struct Asking {
    question: String,
}

pub(super) async fn ask(
    State(state): State<WorkbenchState>,
    Json(asking): Json<Asking>,
) -> Result<Response, ApiError> {
    if asking.question.trim().is_empty() {
        return Err(ApiError {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            message: "Say what the chat was about.".into(),
        });
    }
    let Some(index) = state.search.clone() else {
        return Err(ApiError::unavailable("the search index is not open".into()));
    };
    let settings = match &state.projects {
        Some(db) => search_settings(db).map_err(ApiError::from)?,
        None => SearchSettings {
            provider: None,
            profile: None,
            model: None,
            effort: None,
            time_limit_seconds: DEFAULT_TIME_LIMIT,
        },
    };
    let source = Arc::new(Chats {
        index,
        projects: state.projects.clone(),
    });
    let registry = &state.registry;
    agent::start(source, &asking.question, settings, |brand| {
        if brand == "claude" {
            registry.claude_config_directory().to_path_buf()
        } else {
            registry.codex_home_directory().to_path_buf()
        }
    })
    .map_err(|(status, message)| ApiError { status, message })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_search_gives_its_agent_two_read_only_tools_and_the_chat_skill() {
        let skill = agent::prompt(SKILL, "where we fixed the loader");
        assert!(skill.starts_with("# Finding the chat someone describes"), "{skill}");
        let index = SearchIndex::open(
            &tempfile::tempdir().unwrap().keep().join("search.db"),
            &tempfile::tempdir().unwrap().keep().join("workbench.db"),
            Arc::new(|_: &str| Vec::new()),
        );
        let Ok(index) = index else { return };
        let tools = Chats { index, projects: None }.tools();
        let tools = tools.as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().all(|tool| tool["annotations"]["readOnlyHint"] == true));
    }
}
