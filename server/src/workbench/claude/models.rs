//! Claude's install-backed aliases plus the numbered models its register knows.
use chrono::{NaiveDate, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;

struct Model {
    id: &'static str,
    name: &'static str,
    window: i64,
    input: i64,
    output: i64,
    cutoff: &'static str,
    efforts: &'static [&'static str],
    end: Option<&'static str>,
    unavailable: Option<&'static str>,
}
const ALL: &[&str] = &["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: &[&str] = &["low", "medium", "high", "max"];
const PLAIN: &[&str] = &["low", "medium", "high"];
const NONE: &[&str] = &[];
const CATALOG: &[Model] = &[
    Model {
        id: "claude-fable-5",
        name: "Fable 5",
        window: 1_000_000,
        input: 10,
        output: 50,
        cutoff: "January 2026",
        efforts: ALL,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-opus-5",
        name: "Opus 5",
        window: 1_000_000,
        input: 5,
        output: 25,
        cutoff: "May 2026",
        efforts: ALL,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-opus-4-8",
        name: "Opus 4.8",
        window: 1_000_000,
        input: 5,
        output: 25,
        cutoff: "January 2026",
        efforts: ALL,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-opus-4-7",
        name: "Opus 4.7",
        window: 1_000_000,
        input: 5,
        output: 25,
        cutoff: "January 2026",
        efforts: ALL,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        window: 200_000,
        input: 5,
        output: 25,
        cutoff: "May 2025",
        efforts: NO_XHIGH,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-opus-4-5",
        name: "Opus 4.5",
        window: 200_000,
        input: 5,
        output: 25,
        cutoff: "May 2025",
        efforts: PLAIN,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-opus-4-1",
        name: "Opus 4.1",
        window: 200_000,
        input: 15,
        output: 75,
        cutoff: "January 2025",
        efforts: NONE,
        end: Some("2026-08-05"),
        unavailable: None,
    },
    Model {
        id: "claude-opus-4-0",
        name: "Opus 4",
        window: 200_000,
        input: 15,
        output: 75,
        cutoff: "January 2025",
        efforts: NONE,
        end: Some("2026-06-15"),
        unavailable: None,
    },
    Model {
        id: "claude-sonnet-5",
        name: "Sonnet 5",
        window: 1_000_000,
        input: 2,
        output: 10,
        cutoff: "January 2026",
        efforts: ALL,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-sonnet-4-6",
        name: "Sonnet 4.6",
        window: 200_000,
        input: 3,
        output: 15,
        cutoff: "August 2025",
        efforts: NO_XHIGH,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-sonnet-4-5",
        name: "Sonnet 4.5",
        window: 200_000,
        input: 3,
        output: 15,
        cutoff: "January 2025",
        efforts: NONE,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-sonnet-4-0",
        name: "Sonnet 4",
        window: 200_000,
        input: 3,
        output: 15,
        cutoff: "January 2025",
        efforts: NONE,
        end: Some("2026-06-15"),
        unavailable: None,
    },
    Model {
        id: "claude-haiku-4-5",
        name: "Haiku 4.5",
        window: 200_000,
        input: 1,
        output: 5,
        cutoff: "February 2025",
        efforts: NONE,
        end: None,
        unavailable: None,
    },
    Model {
        id: "claude-mythos-5",
        name: "Mythos 5",
        window: 1_000_000,
        input: 10,
        output: 50,
        cutoff: "January 2026",
        efforts: ALL,
        end: None,
        unavailable: Some("Project Glasswing only"),
    },
];
fn description(m: &Model) -> String {
    format!(
        "{} context · Knowledge to {}\n${}/${} per Mtok",
        if m.window >= 1_000_000 { "1M" } else { "200K" },
        m.cutoff,
        m.input,
        m.output
    )
}
fn catalogued(value: &str) -> Option<&'static Model> {
    let bare = value.strip_suffix("[1m]").unwrap_or(value);
    let bare = if bare.len() > 9
        && bare.as_bytes()[bare.len() - 9] == b'-'
        && bare[bare.len() - 8..].bytes().all(|b| b.is_ascii_digit())
    {
        &bare[..bare.len() - 9]
    } else {
        bare
    };
    CATALOG.iter().find(|m| m.id == bare)
}
fn priced_alias(row: &Value) -> Option<String> {
    let mut said = row["description"].as_str().map(str::to_string);
    if let Some(text) = said.as_mut() {
        if let Some(at) = text.rfind(" · $") {
            let rate = text[at + 3..].trim_start().to_string();
            text.replace_range(at.., &format!("\n{rate}"));
        }
        if text.contains("per Mtok") {
            return said;
        }
    }
    let model = row["resolvedModel"].as_str().and_then(catalogued)?;
    Some(match said {
        Some(text) if !text.is_empty() => {
            format!("{text}\n${}/${} per Mtok", model.input, model.output)
        }
        _ => format!("${}/${} per Mtok", model.input, model.output),
    })
}
fn unavailable(m: &Model) -> Option<String> {
    if let Some(reason) = m.unavailable {
        return Some(reason.into());
    }
    let end = m.end?;
    let day = NaiveDate::parse_from_str(end, "%Y-%m-%d").ok()?;
    if Utc::now().date_naive() < day {
        return None;
    }
    Some(format!(
        "Reached end of life on {}",
        day.format("%-d %B %Y")
    ))
}
pub fn rows(announced: &[Value]) -> Vec<Value> {
    let named: HashSet<_> = announced
        .iter()
        .filter_map(|r| r["value"].as_str())
        .collect();
    let mut rows = announced.to_vec();
    rows.extend(CATALOG.iter().filter(|m|!named.contains(m.id)).map(|m|json!({"value":m.id,"resolvedModel":m.id,"displayName":m.name,"description":description(m),"supportsEffort":!m.efforts.is_empty(),"supportedEffortLevels":m.efforts})));
    rows
}
pub fn menu(announced: &[Value]) -> Vec<Value> {
    let named: HashSet<_> = announced
        .iter()
        .filter_map(|r| r["value"].as_str())
        .collect();
    let mut menu=announced.iter().map(|r|json!({"value":r["value"],"displayName":r["displayName"],"description":priced_alias(r),"group":"alias"})).collect::<Vec<_>>();
    menu.extend(CATALOG.iter().filter(|m|!named.contains(m.id)).map(|m|{let mut row=json!({"value":m.id,"displayName":m.name,"description":description(m),"group":"version"});if let Some(reason)=unavailable(m){row["unavailable"]=json!(reason)}row}));
    menu
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restores_numbered_catalog_and_efforts() {
        let announced = vec![
            json!({"value":"opus","displayName":"Opus","resolvedModel":"claude-opus-5","description":"Latest · $5/$25 per Mtok","supportedEffortLevels":["low"]}),
        ];
        let menu = menu(&announced);
        assert_eq!(menu.len(), 15);
        assert_eq!(menu[0]["description"], "Latest\n$5/$25 per Mtok");
        assert_eq!(
            menu.iter()
                .find(|r| r["value"] == "claude-opus-4-1")
                .unwrap()["unavailable"],
            "Reached end of life on 5 August 2026"
        );
        let rows = rows(&announced);
        assert_eq!(
            rows.iter()
                .find(|r| r["value"] == "claude-opus-4-8")
                .unwrap()["supportedEffortLevels"][4],
            "max"
        );
    }
}
