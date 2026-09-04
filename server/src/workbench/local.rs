//! Local model runtimes exposed through the same ACP seam as hosted agents.
//!
//! Discovery is read-only and bounded: a missing runtime must not delay the
//! provider picker. The model ids returned by the runtime are the only catalog
//! Atelier exposes; there is deliberately no compiled-in model list.

use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub const BRAND: &str = "local";

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub value: String,
    pub display_name: String,
    pub runtime: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The runtime already has this model in memory, so starting on it costs
    /// nothing. On a card that fits one model at a time this is the whole
    /// difference between typing straight away and waiting out a swap.
    pub resident: bool,
}

/// One model as a runtime described it, before it is given Atelier's shape.
struct Candidate {
    value: String,
    family: Option<String>,
    publisher: Option<String>,
    resident: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Runtime {
    Ollama,
    OpenAiCompatible,
}

impl Runtime {
    pub fn id(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai-compatible",
        }
    }

    pub fn provider(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai",
        }
    }

    pub fn endpoint(self) -> String {
        match self {
            Self::Ollama => std::env::var("ATELIER_OLLAMA_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:11434".into()),
            Self::OpenAiCompatible => std::env::var("ATELIER_OPENAI_COMPATIBLE_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8080".into()),
        }
        .trim_end_matches('/')
        .to_string()
    }

    pub fn api_key(self) -> Option<String> {
        match self {
            Self::Ollama => std::env::var("ATELIER_OLLAMA_API_KEY").ok(),
            Self::OpenAiCompatible => std::env::var("ATELIER_OPENAI_COMPATIBLE_API_KEY").ok(),
        }
        .filter(|key| !key.trim().is_empty())
    }
}

pub fn runtime(id: &str) -> Option<Runtime> {
    match id {
        "ollama" => Some(Runtime::Ollama),
        "openai-compatible" => Some(Runtime::OpenAiCompatible),
        _ => None,
    }
}

pub fn encode_model(runtime: Runtime, model: &str) -> String {
    format!("{}::{model}", runtime.id())
}

pub fn decode_model(value: &str) -> Option<(Runtime, &str)> {
    let (runtime_id, model) = value.split_once("::")?;
    Some((runtime(runtime_id)?, model))
}

/// Discovery's budget: a runtime that is not there must not delay the picker.
const DISCOVERY_PATIENCE: Duration = Duration::from_millis(120);

/// The budget for asking whether a runtime is still there, which is a
/// different question from whether it is there at all. Nothing is waiting on
/// this answer, and a busy server that is loading a model can be slow to
/// answer a catalog request while being perfectly alive — so saying it stopped
/// on a 120ms silence would be a lie told to a working machine.
const LIVENESS_PATIENCE: Duration = Duration::from_secs(2);

async fn get_json(runtime: Runtime, url: String) -> Option<Value> {
    get_json_within(runtime, url, DISCOVERY_PATIENCE).await
}

async fn get_json_within(runtime: Runtime, url: String, patience: Duration) -> Option<Value> {
    // Half the budget to get a socket, the whole of it to get an answer, with
    // a floor so the fast discovery pass still gives up on a port nobody is
    // listening on almost at once. A flat 60ms cap would have applied to the
    // liveness check too, and calling a busy server dead because it took
    // 61ms to accept is the exact mistake this file is here to stop.
    let connect = (patience / 2).max(Duration::from_millis(60));
    let client = reqwest::Client::builder()
        .connect_timeout(connect.min(patience))
        .timeout(patience)
        .build()
        .ok()?;
    let request = client.get(url);
    let request = match runtime.api_key() {
        Some(key) => request.bearer_auth(key),
        None => request,
    };
    request
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()
}

fn unique_models(
    runtime: Runtime,
    values: impl IntoIterator<Item = Candidate>,
) -> Vec<LocalModel> {
    let mut values = values
        .into_iter()
        .filter(|candidate| !candidate.value.trim().is_empty())
        .collect::<Vec<_>>();
    values.sort_by_key(|candidate| candidate.value.to_lowercase());
    values.dedup_by(|left, right| left.value == right.value);
    values
        .into_iter()
        .map(|candidate| LocalModel {
            display_name: candidate.value.clone(),
            value: encode_model(runtime, &candidate.value),
            runtime: runtime.id(),
            family: candidate.family,
            publisher: candidate.publisher,
            description: None,
            resident: candidate.resident,
        })
        .collect()
}

/// Which model a chat should start on when nobody named one.
///
/// The order is the order of what starting costs the person. A model the
/// runtime is already holding starts instantly; anything else makes a
/// one-model-at-a-time runtime unload what it has and read a new file off
/// disk first. So residency wins, and only when nothing is resident does the
/// question become which model they meant — the last one they used here, and
/// failing that the first one offered. A remembered model the runtime no
/// longer serves is not an answer, so it is skipped rather than returned.
pub fn preferred_model(models: &[LocalModel], remembered: Option<&str>) -> Option<String> {
    if let Some(model) = models.iter().find(|model| model.resident) {
        return Some(model.value.clone());
    }
    if let Some(value) = remembered {
        if models.iter().any(|model| model.value == value) {
            return Some(value.to_string());
        }
    }
    models.first().map(|model| model.value.clone())
}

fn catalog_url(runtime: Runtime) -> String {
    match runtime {
        Runtime::Ollama => format!("{}/api/tags", runtime.endpoint()),
        Runtime::OpenAiCompatible => {
            let base = runtime.endpoint();
            if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            }
        }
    }
}

/// The address of the runtime behind this model, when it has stopped
/// answering — and nothing when it is still there.
///
/// Asked at the end of a local turn, because that is the one moment the app
/// is told an answer is complete and has no way to check. See
/// {@link Normalizer::finish_turn_cut_off} for why the agent cannot tell us.
pub async fn unreachable_endpoint(model: &str) -> Option<String> {
    let (runtime, _) = decode_model(model)?;
    let endpoint = runtime.endpoint();
    match get_json_within(runtime, catalog_url(runtime), LIVENESS_PATIENCE).await {
        Some(_) => None,
        None => Some(endpoint),
    }
}

pub async fn models(runtime: Runtime) -> Vec<LocalModel> {
    match runtime {
        Runtime::Ollama => {
            // `/api/ps` is what Ollama has loaded right now; asking for it
            // alongside the catalog costs no extra wall clock and is the only
            // way to know which model is free to start on.
            let (value, running) = tokio::join!(
                get_json(runtime, catalog_url(runtime)),
                get_json(runtime, format!("{}/api/ps", runtime.endpoint()))
            );
            let Some(value) = value else {
                return Vec::new();
            };
            ollama_catalog(&value, running.as_ref())
        }
        Runtime::OpenAiCompatible => {
            let Some(value) = get_json(runtime, catalog_url(runtime)).await else {
                return Vec::new();
            };
            openai_catalog(&value)
        }
    }
}

fn ollama_catalog(value: &Value, running: Option<&Value>) -> Vec<LocalModel> {
    let loaded = running
        .map(|running| {
            running["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|model| model["name"].as_str().or_else(|| model["model"].as_str()))
                .map(str::to_string)
                .collect::<std::collections::HashSet<_>>()
        })
        .unwrap_or_default();
    unique_models(
        Runtime::Ollama,
        value["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                let id = model["name"].as_str().or_else(|| model["model"].as_str())?;
                let family = model["details"]["family"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        model["details"]["families"]
                            .as_array()
                            .and_then(|families| families.first())
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    });
                Some(Candidate {
                    resident: loaded.contains(id),
                    value: id.to_string(),
                    family,
                    publisher: None,
                })
            }),
    )
}

fn openai_catalog(value: &Value) -> Vec<LocalModel> {
    unique_models(
        Runtime::OpenAiCompatible,
        value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|model| {
                Some(Candidate {
                    value: model["id"].as_str()?.to_string(),
                    family: None,
                    publisher: model["owned_by"].as_str().map(str::to_string),
                    // A router that serves one model at a time reports each
                    // model's state here. `loaded` and `sleeping` are both in
                    // memory, and `loading` is on its way with no second
                    // unload to pay for; every other state means a swap.
                    resident: matches!(
                        model["status"]["value"].as_str(),
                        Some("loaded" | "loading" | "sleeping")
                    ),
                })
            }),
    )
}

pub async fn catalog() -> Vec<LocalModel> {
    type CatalogCache = tokio::sync::Mutex<Option<(Instant, Vec<LocalModel>)>>;
    static CACHE: OnceLock<CatalogCache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut cached = cache.lock().await;
    if let Some((at, models)) = cached.as_ref() {
        if at.elapsed() < Duration::from_secs(30) {
            return models.clone();
        }
    }
    let (ollama, openai) = tokio::join!(models(Runtime::Ollama), models(Runtime::OpenAiCompatible));
    let mut models = ollama.into_iter().chain(openai).collect::<Vec<_>>();
    let mut counts = std::collections::HashMap::<String, usize>::new();
    for model in &models {
        *counts.entry(model.display_name.to_lowercase()).or_default() += 1;
    }
    for model in &mut models {
        if counts
            .get(&model.display_name.to_lowercase())
            .copied()
            .unwrap_or_default()
            > 1
        {
            model.description = Some(
                match model.runtime {
                    "ollama" => "Served by Ollama",
                    _ => "Served by an OpenAI-compatible local runtime",
                }
                .into(),
            );
        }
    }
    *cached = Some((Instant::now(), models.clone()));
    models
}

/// Why local cannot be started, in the words of the thing that is missing.
///
/// "Unavailable" on its own is the least useful true sentence the picker can
/// say: the reader cannot tell a runtime they forgot to start from an install
/// that is broken, and those want opposite things done about them. Both are
/// named here, and the addresses that were tried are part of the answer —
/// they are the reader's own loopback ports, and knowing which one was asked
/// is most of knowing what to start. The API key is never part of it
/// (bw-u6cl.9).
fn unavailable_reason(models: &[LocalModel], adapter: Option<&std::path::PathBuf>) -> Option<String> {
    if adapter.is_none() {
        return Some("the bundled local ACP adapter was not found".into());
    }
    if models.is_empty() {
        return Some(format!(
            "no local model runtime answered at {} or {}",
            Runtime::OpenAiCompatible.endpoint(),
            Runtime::Ollama.endpoint()
        ));
    }
    None
}

pub async fn providers() -> Vec<Value> {
    let models = catalog().await;
    let adapter = super::acp::adapter::find(BRAND);
    let reason = unavailable_reason(&models, adapter.as_ref());
    let providers = vec![serde_json::json!({
        "brand":BRAND, "name":"Local models",
        "available":reason.is_none(),
        "path":Value::Null, "adapterPath":adapter,
        "availabilityReason":reason,
        "installUrl":"https://block.github.io/goose/docs/getting-started/providers",
        "models":models,
    })];
    providers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(value: &str, family: Option<&str>) -> Candidate {
        Candidate {
            value: value.into(),
            family: family.map(str::to_string),
            publisher: None,
            resident: false,
        }
    }

    fn model(value: &str, resident: bool) -> LocalModel {
        LocalModel {
            value: value.into(),
            display_name: value.into(),
            runtime: "ollama",
            family: None,
            publisher: None,
            description: None,
            resident,
        }
    }

    #[test]
    fn local_provider_names_are_transport_not_model_names() {
        assert_eq!(runtime("ollama"), Some(Runtime::Ollama));
        assert_eq!(
            runtime("openai-compatible"),
            Some(Runtime::OpenAiCompatible)
        );
        assert_eq!(runtime("codex"), None);
        assert_eq!(
            decode_model("ollama::qwen"),
            Some((Runtime::Ollama, "qwen"))
        );
    }

    #[test]
    fn a_catalog_is_sorted_and_contains_only_runtime_values() {
        let models = unique_models(
            Runtime::Ollama,
            [
                candidate("Qwen", Some("qwen")),
                candidate("", None),
                candidate("Gemma", Some("gemma")),
                candidate("Qwen", None),
            ],
        );
        assert_eq!(
            models
                .iter()
                .map(|model| model.value.as_str())
                .collect::<Vec<_>>(),
            ["ollama::Gemma", "ollama::Qwen"]
        );
    }

    #[test]
    fn ollama_metadata_reaches_the_visible_model_contract() {
        let models = ollama_catalog(
            &serde_json::json!({"models":[
                {"name":"Qwen3.8 IQ3","details":{"family":"qwen3"}},
                {"model":"gemma-26B","details":{"families":["gemma3"]}}
            ]}),
            None,
        );
        assert_eq!(models[0].display_name, "gemma-26B");
        assert_eq!(models[0].family.as_deref(), Some("gemma3"));
        assert_eq!(models[1].value, "ollama::Qwen3.8 IQ3");
        assert_eq!(models[1].family.as_deref(), Some("qwen3"));
    }

    #[test]
    fn openai_compatible_ownership_is_metadata_not_a_runtime_brand() {
        let models = openai_catalog(&serde_json::json!({"data":[
            {"id":"private-alias","owned_by":"deepseek"}
        ]}));
        assert_eq!(models[0].value, "openai-compatible::private-alias");
        assert_eq!(models[0].publisher.as_deref(), Some("deepseek"));
        assert_eq!(models[0].runtime, "openai-compatible");
    }

    #[test]
    fn a_chat_starts_on_the_model_the_runtime_is_already_holding() {
        // The remembered model and the first of the list both lose to the one
        // that costs nothing to start: that is the whole point of the order.
        let models = [
            model("openai-compatible::gemma", false),
            model("openai-compatible::qwen", true),
        ];
        assert_eq!(
            preferred_model(&models, Some("openai-compatible::gemma")).as_deref(),
            Some("openai-compatible::qwen")
        );
    }

    #[test]
    fn with_nothing_resident_a_chat_starts_on_the_model_last_used_here() {
        let models = [model("ollama::gemma", false), model("ollama::qwen", false)];
        assert_eq!(
            preferred_model(&models, Some("ollama::qwen")).as_deref(),
            Some("ollama::qwen")
        );
        // A model the runtime has stopped serving is not an answer.
        assert_eq!(
            preferred_model(&models, Some("ollama::deleted")).as_deref(),
            Some("ollama::gemma")
        );
    }

    #[test]
    fn a_first_run_with_no_memory_and_nothing_resident_starts_on_the_first_offered() {
        let models = [model("ollama::gemma", false), model("ollama::qwen", false)];
        assert_eq!(
            preferred_model(&models, None).as_deref(),
            Some("ollama::gemma")
        );
        assert_eq!(preferred_model(&[], None), None);
    }

    #[test]
    fn a_router_that_holds_one_model_says_which_one_and_it_is_read() {
        let models = openai_catalog(&serde_json::json!({"data":[
            {"id":"gemma-26B","status":{"value":"unloaded"}},
            {"id":"qwen-27B","status":{"value":"loaded"}},
            {"id":"waking-27B","status":{"value":"sleeping"}},
            {"id":"absent-27B"}
        ]}));
        let resident = models
            .iter()
            .filter(|model| model.resident)
            .map(|model| model.display_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(resident, ["qwen-27B", "waking-27B"]);
    }

    #[test]
    fn ollama_residency_comes_from_what_is_running_not_what_is_installed() {
        let models = ollama_catalog(
            &serde_json::json!({"models":[{"name":"qwen:7b"},{"name":"gemma:9b"}]}),
            Some(&serde_json::json!({"models":[{"name":"qwen:7b"}]})),
        );
        assert_eq!(
            models
                .iter()
                .map(|model| (model.display_name.as_str(), model.resident))
                .collect::<Vec<_>>(),
            [("gemma:9b", false), ("qwen:7b", true)]
        );
    }
}
