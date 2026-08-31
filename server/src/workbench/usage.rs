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

/// Translate Claude's live context report into the browser contract. Keep the
/// provider's own totals instead of re-adding bands whose measurements are not
/// defined to sum to the same value.
pub fn window_now(raw: &Value) -> Option<Value> {
    let num = |value: &Value| value.as_f64().filter(|n| n.is_finite()).unwrap_or_default();
    let window = {
        let raw_max = num(&raw["rawMaxTokens"]);
        if raw_max > 0.0 {
            raw_max
        } else {
            num(&raw["maxTokens"])
        }
    };
    if window <= 0.0 {
        return None;
    }
    let used = num(&raw["totalTokens"]);
    let mut pieces = Vec::new();
    let mut spare = Vec::new();
    let mut waiting = Vec::new();
    for band in raw["categories"].as_array().into_iter().flatten() {
        let tokens = num(&band["tokens"]);
        if tokens <= 0.0 {
            continue;
        }
        let name = band["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("unnamed");
        let row = json!({"name":name,"tokens":tokens,"share":tokens/window});
        if band["isDeferred"] == true {
            waiting.push(row)
        } else if name.eq_ignore_ascii_case("free space")
            || name.eq_ignore_ascii_case("autocompact buffer")
        {
            spare.push(row)
        } else {
            pieces.push(row)
        }
    }
    let sort = |rows: &mut Vec<Value>| {
        rows.sort_by(|a, b| {
            b["tokens"]
                .as_f64()
                .partial_cmp(&a["tokens"].as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    };
    sort(&mut pieces);
    sort(&mut spare);
    sort(&mut waiting);
    let inside=raw.get("messageBreakdown").filter(|v|v.is_object()).and_then(|m|{let written=num(&m["assistantMessageTokens"]);let typed=num(&m["userMessageTokens"]);let calls=num(&m["toolCallTokens"]);let answers=num(&m["toolResultTokens"]);let attachments=num(&m["attachmentTokens"]);let carried=num(&m["redirectedContextTokens"]);let rest=num(&m["unattributedTokens"]);let total=written+typed+calls+answers+attachments+carried+rest;if total==0.0{return None}let mut by_tool=m["toolCallsByType"].as_array().into_iter().flatten().map(|r|json!({"name":r["name"].as_str().filter(|s|!s.is_empty()).unwrap_or("unnamed"),"tokens":num(&r["callTokens"])+num(&r["resultTokens"])})).collect::<Vec<_>>();let mut by_attachment=m["attachmentsByType"].as_array().into_iter().flatten().map(|r|json!({"name":r["name"].as_str().filter(|s|!s.is_empty()).unwrap_or("unnamed"),"tokens":num(&r["tokens"])})).collect::<Vec<_>>();sort(&mut by_tool);sort(&mut by_attachment);Some(json!({"written":written,"typed":typed,"calls":calls,"answers":answers,"attachments":attachments,"carried":carried,"rest":rest,"total":total,"byTool":by_tool,"byAttachment":by_attachment}))});
    let mut memory=raw["memoryFiles"].as_array().into_iter().flatten().map(|r|json!({"name":r["path"].as_str().filter(|s|!s.is_empty()).unwrap_or("unnamed"),"tokens":num(&r["tokens"])})).collect::<Vec<_>>();
    sort(&mut memory);
    let mut servers: std::collections::HashMap<String, (f64, i64, i64)> =
        std::collections::HashMap::new();
    for tool in raw["mcpTools"].as_array().into_iter().flatten() {
        let name = tool["serverName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("unnamed")
            .to_string();
        let row = servers.entry(name).or_default();
        row.0 += num(&tool["tokens"]);
        row.1 += 1;
        if tool["isLoaded"] == true {
            row.2 += 1
        }
    }
    let mut servers=servers.into_iter().map(|(name,(tokens,tools,loaded))|json!({"name":name,"tokens":tokens,"tools":tools,"loaded":loaded})).collect::<Vec<_>>();
    sort(&mut servers);
    Some(
        json!({"model":raw["model"].as_str(),"used":used,"window":window,"free":0f64.max(window-used),"percent":num(&raw["percentage"]),"forgetsAt":if raw["isAutoCompactEnabled"]==true&&num(&raw["autoCompactThreshold"])>0.0{json!(num(&raw["autoCompactThreshold"]))}else{Value::Null},"pieces":pieces,"spare":spare,"waiting":waiting,"inside":inside,"memory":memory,"servers":servers}),
    )
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
        let window=window_now(&json!({"rawMaxTokens":200,"totalTokens":80,"percentage":40,"categories":[{"name":"Messages","tokens":50},{"name":"free space","tokens":120},{"name":"Tools","tokens":10,"isDeferred":true}],"messageBreakdown":{"userMessageTokens":7,"assistantMessageTokens":3},"memoryFiles":[{"path":"AGENTS.md","tokens":5}],"mcpTools":[{"serverName":"board","tokens":4,"isLoaded":true},{"serverName":"board","tokens":6,"isLoaded":false}]})).unwrap();
        assert_eq!(window["used"], 80.0);
        assert_eq!(window["pieces"][0]["name"], "Messages");
        assert_eq!(window["spare"][0]["name"], "free space");
        assert_eq!(window["waiting"][0]["name"], "Tools");
        assert_eq!(
            window["servers"][0],
            json!({"name":"board","tokens":10.0,"tools":2,"loaded":1})
        );
    }
}
