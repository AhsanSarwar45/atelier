//! The chats as an AI search source (bw-21a2.5, bw-21a2.6).
//!
//! `POST /search/ask` hands a question to the agent chosen in Settings, which
//! finds the chats with `search_chats` and `read_chat` and names them. The run
//! itself, and the tools' endpoint, are shared with every search
//! (search/agent.rs); this says what the tools are and checks every chat named.
//!
//! An ask made from inside a project stays in it (bw-c1ti.2). It is held here
//! rather than suggested to the agent, because an agent handed a suggestion
//! drops it: whatever project its own query names, the search is made in the
//! project the panel was opened on.

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
    /// The project the panel was opened on: its id, and its name for the agent.
    here: Option<(String, String)>,
}

/// Where a search is made: the project it is held in, or the ones its own words
/// named. A held search cannot be talked out of where it is.
fn searched_in(here: Option<&(String, String)>, named: Vec<String>) -> Vec<String> {
    match here {
        Some((id, _)) => vec![id.clone()],
        None => named,
    }
}

impl Source for Chats {
    fn name(&self) -> &'static str {
        "chats"
    }

    fn skill(&self) -> &'static str {
        SKILL
    }

    fn tools(&self) -> Value {
        let searches = match &self.here {
            Some((_, name)) => format!("Search the chats of the {name} project; chats of other projects cannot be reached from here."),
            None => "Search every chat.".to_string(),
        };
        json!([
            {
                "name": "search_chats",
                "description": format!("{searches} Every word must appear somewhere in a chat. Supports \"phrases\", -word, title:, me:, agent:, tool:, project:, provider:, after:, before: and card:. Returns each chat once with its id, title, project, provider, last activity, match count and up to three snippets."),
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

    fn call(
        self: Arc<Self>,
        tool: String,
        arguments: Value,
        steps: Steps,
    ) -> BoxFuture<'static, Called> {
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
                    let named = match (&self.projects, parsed.projects.is_empty()) {
                        (Some(projects), false) => projects_named(projects, &parsed.projects),
                        _ => Vec::new(),
                    };
                    let ids = searched_in(self.here.as_ref(), named);
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
                            // The one naming rule, fed what the index knows:
                            // the project's folder rather than the chat's own
                            // (chat_name, bw-altj.7).
                            "name": crate::workbench::chat_name::name_of(
                                &crate::workbench::chat_name::Chat {
                                    title: chat.title.as_deref(),
                                    named_by_owner: chat.named_by_owner,
                                    cwd: Some(&chat.cwd),
                                    project_path: &chat.project_path,
                                    folder: crate::workbench::notice::folder_of(&chat.project_path)
                                        .as_deref(),
                                    brand: &chat.brand,
                                },
                            ),
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
    /// The project the panel was opened on, if it was opened on one.
    #[serde(default)]
    project: Option<String>,
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
    // A project the app cannot name is still searched: an id that names no
    // chats finds nothing, which is the safe way to be wrong about where you
    // are. Wandering into every other project is not.
    let here = asking.project.as_ref().map(|id| {
        let name = state
            .projects
            .as_ref()
            .and_then(|db| db.get_project(id).ok())
            .map(|project| project.name)
            .unwrap_or_else(|| "this".to_string());
        (id.clone(), name)
    });
    let source = Arc::new(Chats {
        index,
        projects: state.projects.clone(),
        here,
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
        assert!(
            skill.starts_with("# Finding the chat someone describes"),
            "{skill}"
        );
        let index = SearchIndex::open(
            &tempfile::tempdir().unwrap().keep().join("search.db"),
            &tempfile::tempdir().unwrap().keep().join("workbench.db"),
            Arc::new(|_: &str| Vec::new()),
        );
        let Ok(index) = index else { return };
        let tools = Chats {
            index,
            projects: None,
            here: None,
        }
        .tools();
        let tools = tools.as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert!(tools
            .iter()
            .all(|tool| tool["annotations"]["readOnlyHint"] == true));
    }

    #[test]
    fn an_ask_made_inside_a_project_searches_that_project_whatever_its_agent_asks_for() {
        let here = ("p-1".to_string(), "beads-web".to_string());
        // The agent named another project; it is searched here all the same.
        assert_eq!(
            searched_in(Some(&here), vec!["p-2".to_string()]),
            vec!["p-1".to_string()],
        );
        // And naming none does not widen it either.
        assert_eq!(
            searched_in(Some(&here), Vec::new()),
            vec!["p-1".to_string()]
        );
        // An ask made outside a project still goes where its words say.
        assert_eq!(
            searched_in(None, vec!["p-2".to_string()]),
            vec!["p-2".to_string()],
        );
    }

    #[test]
    fn the_agent_is_told_which_project_it_is_searching() {
        let index = SearchIndex::open(
            &tempfile::tempdir().unwrap().keep().join("search.db"),
            &tempfile::tempdir().unwrap().keep().join("workbench.db"),
            Arc::new(|_: &str| Vec::new()),
        );
        let Ok(index) = index else { return };
        let chats = Chats {
            index,
            projects: None,
            here: Some(("p-1".to_string(), "beads-web".to_string())),
        };
        let tools = chats.tools();
        let said = tools[0]["description"].as_str().unwrap().to_string();
        assert!(
            said.starts_with("Search the chats of the beads-web project"),
            "{said}"
        );
    }
}
