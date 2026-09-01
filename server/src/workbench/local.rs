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

async fn get_json(runtime: Runtime, url: String) -> Option<Value> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(60))
        .timeout(Duration::from_millis(120))
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
    values: impl IntoIterator<Item = (String, Option<String>, Option<String>)>,
) -> Vec<LocalModel> {
    let mut values = values
        .into_iter()
        .filter(|(value, _, _)| !value.trim().is_empty())
        .collect::<Vec<_>>();
    values.sort_by_key(|(value, _, _)| value.to_lowercase());
    values.dedup_by(|left, right| left.0 == right.0);
    values
        .into_iter()
        .map(|(value, family, publisher)| LocalModel {
            display_name: value.clone(),
            value: encode_model(runtime, &value),
            runtime: runtime.id(),
            family,
            publisher,
            description: None,
        })
        .collect()
}

pub async fn models(runtime: Runtime) -> Vec<LocalModel> {
    match runtime {
        Runtime::Ollama => {
            let Some(value) = get_json(runtime, format!("{}/api/tags", runtime.endpoint())).await
            else {
                return Vec::new();
            };
            ollama_catalog(&value)
        }
        Runtime::OpenAiCompatible => {
            let base = runtime.endpoint();
            let url = if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            };
            let Some(value) = get_json(runtime, url).await else {
                return Vec::new();
            };
            openai_catalog(&value)
        }
    }
}

fn ollama_catalog(value: &Value) -> Vec<LocalModel> {
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
                Some((id.to_string(), family, None))
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
                Some((
                    model["id"].as_str()?.to_string(),
                    None,
                    model["owned_by"].as_str().map(str::to_string),
                ))
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

pub async fn providers() -> Vec<Value> {
    let models = catalog().await;
    let providers = vec![serde_json::json!({
        "brand":BRAND, "name":"Local models",
        "available":!models.is_empty() && super::acp::adapter::find(BRAND).is_some(),
        "path":Value::Null, "adapterPath":super::acp::adapter::find(BRAND),
        "installUrl":"https://block.github.io/goose/docs/getting-started/providers",
        "models":models,
    })];
    providers
}

#[cfg(test)]
mod tests {
    use super::*;

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
                ("Qwen".into(), Some("qwen".into()), None),
                ("".into(), None, None),
                ("Gemma".into(), Some("gemma".into()), None),
                ("Qwen".into(), None, None),
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
        let models = ollama_catalog(&serde_json::json!({"models":[
            {"name":"Qwen3.8 IQ3","details":{"family":"qwen3"}},
            {"model":"gemma-26B","details":{"families":["gemma3"]}}
        ]}));
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
}
