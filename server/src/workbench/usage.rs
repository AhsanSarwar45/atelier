//! Account-wide provider allowance normalization.

use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    pub available: bool,
    pub plan: Option<String>,
    pub session: Option<PlanWindow>,
    pub week: Option<PlanWindow>,
    pub per_model: Vec<PlanWindow>,
    pub credits: Option<PlanCredits>,
    pub driving: Vec<Driving>,
    pub at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    pub key: String,
    pub label: String,
    pub percent: Option<f64>,
    pub resets_at: Option<String>,
    pub severity: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PlanCredits {
    pub enabled: bool,
    pub percent: Option<f64>,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub currency: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Driving {
    pub span: &'static str,
    pub requests: i64,
    pub sessions: i64,
    pub traits: Vec<UsageTrait>,
    pub agents: Vec<NamedShare>,
    pub skills: Vec<NamedShare>,
    pub plugins: Vec<NamedShare>,
    pub servers: Vec<NamedShare>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UsageTrait {
    pub key: String,
    pub label: String,
    pub pct: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NamedShare {
    pub name: String,
    pub pct: f64,
}

fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}
fn severity(percent: Option<f64>, said: Option<&str>) -> &'static str {
    let rank = match said {
        Some("critical" | "exceeded" | "rejected") => 2,
        Some("warning") => 1,
        _ => 0,
    };
    let rank = rank.max(if percent.is_some_and(|p| p >= 95.0) {
        2
    } else if percent.is_some_and(|p| p >= 80.0) {
        1
    } else {
        0
    });
    ["normal", "warning", "critical"][rank]
}

fn named(raw: &Value, key: &str) -> Vec<NamedShare> {
    raw[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            Some(NamedShare {
                name: text(&row["name"])?,
                pct: number(&row["pct"]).unwrap_or_default(),
            })
        })
        .collect()
}

fn driving(span: &'static str, raw: Option<&Value>) -> Option<Driving> {
    let raw = raw.filter(|raw| raw.is_object())?;
    let traits = raw["behaviors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let key = text(&row["key"])?;
            let label = match key.as_str() {
                "cache_miss" => "Cache misses",
                "long_context" => "Long conversations",
                "subagent_heavy" => "Agents sent off",
                "high_parallel" => "Several at once",
                "cron" => "Scheduled runs",
                _ => &key,
            }
            .to_string();
            Some(UsageTrait {
                key,
                label,
                pct: number(&row["pct"]).unwrap_or_default(),
            })
        })
        .collect();
    Some(Driving {
        span,
        requests: raw["request_count"].as_i64().unwrap_or_default(),
        sessions: raw["session_count"].as_i64().unwrap_or_default(),
        traits,
        agents: named(raw, "agents"),
        skills: named(raw, "skills"),
        plugins: named(raw, "plugins"),
        servers: named(raw, "mcp_servers"),
    })
}

fn claude_window(
    key: &str,
    label: &str,
    limit: Option<&Value>,
    named: Option<&Value>,
) -> Option<PlanWindow> {
    let percent = limit
        .and_then(|v| number(&v["percent"]))
        .or_else(|| named.and_then(|v| number(&v["utilization"])));
    let resets_at = limit
        .and_then(|v| text(&v["resets_at"]))
        .or_else(|| named.and_then(|v| text(&v["resets_at"])));
    (percent.is_some() || resets_at.is_some()).then(|| PlanWindow {
        key: key.into(),
        label: label.into(),
        percent,
        resets_at,
        severity: severity(percent, limit.and_then(|v| v["severity"].as_str())),
    })
}

pub fn claude_usage(raw: Option<&Value>, at: impl Into<String>) -> PlanUsage {
    let at = at.into();
    let plan = raw.and_then(|v| text(&v["subscription_type"]));
    let Some(raw) =
        raw.filter(|v| v["rate_limits_available"] == true && v["rate_limits"].is_object())
    else {
        return PlanUsage {
            available: false,
            plan,
            session: None,
            week: None,
            per_model: vec![],
            credits: None,
            driving: vec![],
            at,
        };
    };
    let rate = &raw["rate_limits"];
    let limits = rate["limits"].as_array().cloned().unwrap_or_default();
    let of = |kind: &str| limits.iter().find(|limit| limit["kind"] == kind);
    let scoped: Vec<_> = limits
        .iter()
        .filter(|limit| limit["kind"] == "weekly_scoped")
        .collect();
    let per_model = if !scoped.is_empty() {
        scoped
            .into_iter()
            .enumerate()
            .filter_map(|(index, limit)| {
                let model = text(&limit["scope"]["model"]["display_name"])
                    .unwrap_or_else(|| "this model".into());
                claude_window(
                    &format!("model:{model}:{index}"),
                    &format!("This week · {model}"),
                    Some(limit),
                    None,
                )
            })
            .collect()
    } else {
        rate["model_scoped"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, model)| {
                let name = text(&model["display_name"]).unwrap_or_else(|| "this model".into());
                claude_window(
                    &format!("model:{name}:{index}"),
                    &format!("This week · {name}"),
                    None,
                    Some(model),
                )
            })
            .collect()
    };
    let credits = rate
        .get("extra_usage")
        .filter(|v| v.is_object())
        .map(|extra| PlanCredits {
            enabled: extra["is_enabled"] == true,
            percent: number(&extra["utilization"]),
            used: number(&extra["used_credits"]),
            limit: number(&extra["monthly_limit"]),
            currency: text(&extra["currency"]),
        });
    PlanUsage {
        available: true,
        plan,
        session: claude_window(
            "session",
            "This session",
            of("session"),
            rate.get("five_hour"),
        ),
        week: claude_window("week", "This week", of("weekly_all"), rate.get("seven_day")),
        per_model,
        credits,
        driving: [
            driving("day", raw.pointer("/behaviors/day")),
            driving("week", raw.pointer("/behaviors/week")),
        ]
        .into_iter()
        .flatten()
        .collect(),
        at,
    }
}

fn codex_window(key: &str, label: String, raw: Option<&Value>) -> Option<PlanWindow> {
    let raw = raw?;
    let percent = number(&raw["usedPercent"]);
    Some(PlanWindow {
        key: key.into(),
        label,
        percent,
        resets_at: raw["resetsAt"]
            .as_f64()
            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds as i64, 0))
            .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        severity: if percent.is_some_and(|p| p >= 90.0) {
            "critical"
        } else if percent.is_some_and(|p| p >= 75.0) {
            "warning"
        } else {
            "normal"
        },
    })
}

pub fn codex_usage(raw: &Value, at: impl Into<String>) -> PlanUsage {
    let at = at.into();
    let limits = &raw["rateLimits"];
    if !limits.is_object() {
        return PlanUsage {
            available: false,
            plan: None,
            session: None,
            week: None,
            per_model: vec![],
            credits: None,
            driving: vec![],
            at,
        };
    }
    let buckets = raw["rateLimitsByLimitId"].as_object();
    let mut all = vec![(None, limits)];
    if let Some(buckets) = buckets {
        for (id, snapshot) in buckets {
            all.push((Some(id.as_str()), snapshot));
        }
    }
    fn windows(snapshot: &Value) -> impl Iterator<Item = &Value> {
        [snapshot.get("primary"), snapshot.get("secondary")]
            .into_iter()
            .flatten()
            .filter(|v| v.is_object())
    }
    let session_raw = all
        .iter()
        .flat_map(|(_, snapshot)| windows(snapshot))
        .find(|window| {
            number(&window["windowDurationMins"]).is_some_and(|minutes| minutes <= 1440.0)
        });
    let week_raw = all
        .iter()
        .filter(|(id, _)| id.is_none() || *id == Some("codex"))
        .flat_map(|(_, snapshot)| windows(snapshot))
        .find(|window| {
            number(&window["windowDurationMins"]).is_some_and(|minutes| minutes > 1440.0)
        })
        .or_else(|| {
            all.iter()
                .flat_map(|(_, snapshot)| windows(snapshot))
                .find(|window| {
                    number(&window["windowDurationMins"]).is_some_and(|minutes| minutes > 1440.0)
                })
        });
    let mut per_model = Vec::new();
    if let Some(buckets) = buckets {
        for (id, snapshot) in buckets {
            if id == "codex" {
                continue;
            }
            let weekly = windows(snapshot).find(|window| {
                number(&window["windowDurationMins"]).is_some_and(|minutes| minutes > 1440.0)
            });
            let label = text(&snapshot["limitName"]).unwrap_or_else(|| id.clone());
            if let Some(window) = codex_window(
                &format!("model:{id}"),
                format!("This week · {label}"),
                weekly,
            ) {
                per_model.push(window);
            }
        }
    }
    PlanUsage {
        available: session_raw.is_some() || week_raw.is_some(),
        plan: text(&limits["planType"]),
        session: codex_window("session", "This session".into(), session_raw),
        week: codex_window("week", "This week".into(), week_raw),
        per_model,
        credits: limits
            .get("credits")
            .filter(|v| v.is_object())
            .map(|credits| PlanCredits {
                enabled: credits["hasCredits"] == true || credits["unlimited"] == true,
                percent: None,
                used: None,
                limit: None,
                currency: None,
            }),
        driving: vec![],
        at,
    }
}

/// Read Claude's account allowance over the same native control channel as a
/// chat; no SDK process is needed.
pub async fn read_claude(
    transport: &crate::workbench::claude::transport::ClaudeTransport,
    at: impl Into<String>,
) -> Result<PlanUsage, String> {
    let raw = transport
        .call(json!({"subtype":"get_usage"}), Duration::from_secs(15))
        .await
        .map_err(|error| error.to_string())?;
    Ok(claude_usage(Some(&raw), at))
}

/// Read Codex's account allowance from its native app-server transport.
pub async fn read_codex(
    transport: &crate::workbench::codex::transport::CodexTransport,
    at: impl Into<String>,
) -> Result<PlanUsage, String> {
    let raw = transport
        .call(
            "account/rateLimits/read",
            json!({}),
            Duration::from_secs(15),
        )
        .await
        .map_err(|error| error.to_string())?;
    Ok(codex_usage(&raw, at))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_workbench_services_metadata_normalises_both_provider_allowances() {
        let claude = claude_usage(
            Some(
                &json!({"subscription_type":"max","rate_limits_available":true,"rate_limits":{"limits":[{"kind":"session","percent":81,"resets_at":"2026-08-30T12:00:00Z"},{"kind":"weekly_all","percent":96}]}}),
            ),
            "now",
        );
        assert_eq!(claude.session.unwrap().severity, "warning");
        assert_eq!(claude.week.unwrap().severity, "critical");
        let codex = codex_usage(
            &json!({"rateLimits":{"planType":"plus","primary":{"usedPercent":76,"windowDurationMins":300},"secondary":{"usedPercent":20,"windowDurationMins":10080}}}),
            "now",
        );
        assert_eq!(codex.session.unwrap().severity, "warning");
        assert_eq!(codex.week.unwrap().percent, Some(20.0));
    }
}
