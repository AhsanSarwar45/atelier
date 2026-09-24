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
    /// Usage resets the account holds, or `None` when the provider did not say.
    pub resets: Option<PlanResets>,
    pub at: String,
}

/// The usage resets an account holds, in one shape for every provider.
///
/// Claude calls them grants and Codex calls them reset credits. Both are
/// earned or granted allowances that refill the current limit windows early,
/// and both expire, so the panel draws them the same way.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResets {
    /// How many the account holds. Can exceed `items` when the provider lists
    /// only some of them.
    pub available: i64,
    pub items: Vec<PlanReset>,
    /// Why none of them can be used right now, when the provider says.
    pub blocked: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReset {
    /// The provider's own id, handed back unchanged when the reset is used.
    pub id: String,
    pub title: String,
    pub detail: Option<String>,
    /// ISO 8601.
    pub granted_at: Option<String>,
    /// ISO 8601, or `None` when it never expires.
    pub expires_at: Option<String>,
    /// Whether it can be used now.
    pub usable: bool,
    /// Uses left in this reset, when one reset can be used more than once.
    pub left: Option<i64>,
    /// The windows it refills, as `PlanWindow::key` values. Empty when the
    /// provider does not say.
    pub clears: Vec<String>,
}

/// What happened when a reset was used, in one set of words for every provider.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetOutcome {
    /// `reset`, `nothing_to_reset`, `no_reset`, `already_used`, `cooldown`,
    /// `unavailable` or `unconfirmed`.
    pub outcome: &'static str,
    /// A sentence for the reader.
    pub message: String,
}

impl ResetOutcome {
    fn said(outcome: &'static str) -> Self {
        let message = match outcome {
            "reset" => "Usage limits reset.",
            "nothing_to_reset" => "Nothing to reset. No limit is in use yet, so the reset was kept.",
            "no_reset" => "No reset is available on this account.",
            "already_used" => "This reset was already used.",
            "cooldown" => "A reset was used recently. Try again later.",
            "unconfirmed" => "Could not confirm the reset. Check your usage in a moment before trying again.",
            _ => "Could not reset your limits. Nothing was used.",
        };
        Self { outcome, message: message.into() }
    }
}

fn unix_iso(seconds: Option<i64>) -> Option<String> {
    seconds
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds, 0))
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
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
                "cache_miss" => "Requests without cached context",
                "long_context" => "Long context requests",
                "subagent_heavy" => "Requests using subagents",
                "high_parallel" => "Parallel agent tasks",
                "cron" => "Scheduled task requests",
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
            resets: None,
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
        resets: None,
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
            resets: None,
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
        resets: codex_resets(&raw["rateLimitResetCredits"]),
        at,
    }
}

/// Codex's reset credits (`account/rateLimits/read`, `rateLimitResetCredits`).
///
/// `credits` is `null` when only the count is known, and may be shorter than
/// `availableCount` when the backend caps the list.
fn codex_resets(raw: &Value) -> Option<PlanResets> {
    if !raw.is_object() {
        return None;
    }
    let items: Vec<PlanReset> = raw["credits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|credit| {
            let status = credit["status"].as_str().unwrap_or("unknown");
            if status == "redeemed" {
                return None;
            }
            Some(PlanReset {
                id: text(&credit["id"])?,
                title: text(&credit["title"]).unwrap_or_else(|| "Usage limit reset".into()),
                detail: text(&credit["description"]),
                granted_at: unix_iso(credit["grantedAt"].as_i64()),
                expires_at: unix_iso(credit["expiresAt"].as_i64()),
                usable: status == "available",
                left: None,
                clears: vec![],
            })
        })
        .collect();
    let available = raw["availableCount"]
        .as_i64()
        .unwrap_or(items.len() as i64)
        .max(0);
    // Only the count is known: one row stands for them all, and an empty id
    // lets the backend choose the next credit.
    let mut items = items;
    if raw["credits"].is_null() && available > 0 {
        items.push(PlanReset {
            id: String::new(),
            title: "Usage limit reset".into(),
            detail: None,
            granted_at: None,
            expires_at: None,
            usable: true,
            left: Some(available),
            clears: vec![],
        });
    }
    Some(PlanResets {
        available,
        items,
        blocked: None,
    })
}

/// Codex's answer to `account/rateLimitResetCredit/consume`.
pub fn codex_reset_outcome(raw: &Value) -> ResetOutcome {
    ResetOutcome::said(match raw["outcome"].as_str() {
        Some("reset") => "reset",
        Some("nothingToReset") => "nothing_to_reset",
        Some("noCredit") => "no_reset",
        Some("alreadyRedeemed") => "already_used",
        _ => "unavailable",
    })
}

/// The windows a Claude grant names, as this app's window keys.
fn claude_clears(raw: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    for name in raw.as_array().into_iter().flatten().filter_map(Value::as_str) {
        let key = match name {
            "five_hour" => "session",
            "seven_day" | "seven_day_overage_included" => "week",
            _ => continue,
        };
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
        }
    }
    keys
}

/// Claude's usage resets: the `cedar_ember` block of the account usage read.
///
/// Claude Code offers only `next_grant_id`, and only while it is usable, not
/// paused and not past `ends_at`. The same rule decides `usable` here, so the
/// panel never offers a reset the provider would refuse.
pub fn claude_resets(raw: &Value, now: chrono::DateTime<chrono::Utc>) -> Option<PlanResets> {
    if !raw.is_object() {
        return None;
    }
    let parse = |value: &Value| {
        text(value)
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(&at).ok())
            .map(|at| at.with_timezone(&chrono::Utc))
    };
    let iso = |at: chrono::DateTime<chrono::Utc>| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let next = text(&raw["next_grant_id"]);
    let cooling = parse(&raw["cooldown_until"]).filter(|until| *until > now);
    let blocked = if raw["eligible"] == false {
        Some(match raw["ineligible_reason"].as_str() {
            Some("tier" | "seat") => "Resets are not offered on this plan.".to_string(),
            Some("cli_version") => "Update Claude Code to use resets.".to_string(),
            Some("no_grant") => "This account has no resets.".to_string(),
            _ => "Resets are not available on this account right now.".to_string(),
        })
    } else {
        cooling.map(|until| format!("A reset was used recently. The next one can be used after {}.", iso(until)))
    };
    let items: Vec<PlanReset> = raw["grants"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|grant| {
            let id = text(&grant["id"])?;
            let ends = parse(&grant["ends_at"]);
            if ends.is_some_and(|ends| ends <= now) {
                return None;
            }
            let left = grant["resets_left"].as_i64();
            if left.is_some_and(|left| left <= 0) {
                return None;
            }
            let waits_for: Vec<String> = claude_clears(&grant["blocking"]);
            let detail = (!waits_for.is_empty()).then(|| {
                format!(
                    "Can be used after your {} limit resets.",
                    waits_for.iter().map(|k| if k == "session" { "session" } else { "weekly" }).collect::<Vec<_>>().join(" and ")
                )
            });
            Some(PlanReset {
                usable: blocked.is_none()
                    && grant["usable_now"] == true
                    && grant["paused"] != true
                    && next.as_deref() == Some(id.as_str()),
                title: text(&grant["label"]).unwrap_or_else(|| "Usage limit reset".into()),
                detail,
                granted_at: parse(&grant["starts_at"]).map(iso),
                expires_at: ends.map(iso),
                left,
                clears: claude_clears(&grant["clears"]),
                id,
            })
        })
        .collect();
    Some(PlanResets {
        available: items.iter().map(|item| item.left.unwrap_or(1)).sum(),
        items,
        blocked,
    })
}

/// Claude's answer to `POST /api/organizations/{org}/reset_rate_limits`.
pub fn claude_reset_outcome(raw: &Value) -> ResetOutcome {
    ResetOutcome::said(match raw["result"].as_str() {
        Some("reset") => "reset",
        Some("already_used") => "already_used",
        Some("not_limited") => "nothing_to_reset",
        Some("cooldown") => "cooldown",
        Some("ineligible") => "no_reset",
        _ if raw["reason"] == "reset_unconfirmed" => "unconfirmed",
        _ => "unavailable",
    })
}

/// What Claude's account API needs: the claude.ai login and its organisation.
///
/// Read from the account's own files, the way Claude Code keeps them. The
/// token is never refreshed here: refreshing rotates it, and the CLI that owns
/// the file would then hold a dead one. The usage reader keeps it fresh.
struct ClaudeLogin {
    token: String,
    /// Needed only to use a reset, never to read them.
    organization: Option<String>,
}

fn claude_login(directory: &std::path::Path) -> Result<ClaudeLogin, String> {
    let read = |path: std::path::PathBuf| -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
    };
    let credentials = read(directory.join(".credentials.json"))
        .ok_or("Claude login not found for this account")?;
    let oauth = &credentials["claudeAiOauth"];
    let token = text(&oauth["accessToken"]).ok_or("This account is not signed in to claude.ai")?;
    if oauth["expiresAt"]
        .as_i64()
        .is_some_and(|ms| ms <= chrono::Utc::now().timestamp_millis())
    {
        return Err("The claude.ai login has expired. Open a Claude chat to renew it.".into());
    }
    // `.claude.json` sits inside a relocated config directory, and beside the
    // default `~/.claude` directory otherwise.
    let beside = directory
        .parent()
        .filter(|_| directory.file_name().is_some_and(|name| name == ".claude"))
        .map(|home| home.join(".claude.json"));
    let organization = [Some(directory.join(".claude.json")), beside]
        .into_iter()
        .flatten()
        .filter_map(read)
        .find_map(|config| text(&config["oauthAccount"]["organizationUuid"]));
    Ok(ClaudeLogin { token, organization })
}

const CLAUDE_API: &str = "https://api.anthropic.com";

fn claude_request(login: &ClaudeLogin, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder
        .bearer_auth(&login.token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("Content-Type", "application/json")
        .header("User-Agent", claude_user_agent())
}

/// Claude Code's own User-Agent, with the installed version.
///
/// The account API offers resets only to a request that names itself as the
/// CLI (`claude-cli/<version> (external, cli)`); any other agent reads as
/// ineligible (measured 2026-09-24 against 2.1.280).
fn claude_user_agent() -> &'static str {
    static AGENT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        let version = crate::routes::find_tool("claude", &[])
            .and_then(|claude| std::process::Command::new(claude).arg("--version").output().ok())
            .and_then(|out| {
                String::from_utf8(out.stdout)
                    .ok()?
                    .split_whitespace()
                    .next()
                    .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "2.1.280".into());
        format!("claude-cli/{version} (external, cli)")
    })
}

/// Read the resets a Claude account holds.
pub async fn read_claude_resets(directory: &std::path::Path) -> Result<Option<PlanResets>, String> {
    let login = claude_login(directory)?;
    let raw: Value = claude_request(
        &login,
        reqwest::Client::new().get(format!("{CLAUDE_API}/api/oauth/usage?cedar_ember=1&skip_spend=1")),
    )
    .timeout(Duration::from_secs(10))
    .send()
    .await
    .and_then(reqwest::Response::error_for_status)
    .map_err(|error| error.to_string())?
    .json()
    .await
    .map_err(|error| error.to_string())?;
    Ok(claude_resets(&raw["cedar_ember"], chrono::Utc::now()))
}

/// Use one Claude reset. `attempt` identifies the attempt, so a retry of the
/// same attempt cannot use a second reset.
pub async fn use_claude_reset(directory: &std::path::Path, id: &str, attempt: &str) -> ResetOutcome {
    let login = claude_login(directory).ok().filter(|_| !id.is_empty());
    let Some((login, organization)) =
        login.and_then(|login| login.organization.clone().map(|org| (login, org)))
    else {
        return ResetOutcome::said("unavailable");
    };
    let sent = claude_request(
        &login,
        reqwest::Client::new().post(format!(
            "{CLAUDE_API}/api/organizations/{organization}/reset_rate_limits"
        )),
    )
    .json(&json!({"program": "cedar_ember", "grant_id": id, "request_id": attempt}))
    .timeout(Duration::from_secs(25))
    .send()
    .await;
    match sent {
        // A request that left but never answered may have gone through.
        Err(error) if error.is_timeout() => ResetOutcome::said("unconfirmed"),
        Err(_) => ResetOutcome::said("unavailable"),
        Ok(response) => match response.json::<Value>().await {
            Ok(raw) => claude_reset_outcome(&raw),
            Err(_) => ResetOutcome::said("unconfirmed"),
        },
    }
}

/// Use one Codex reset credit.
pub async fn use_codex_reset(
    transport: &crate::workbench::codex::transport::CodexTransport,
    id: &str,
    attempt: &str,
) -> ResetOutcome {
    match transport
        .call(
            "account/rateLimitResetCredit/consume",
            json!({"creditId": (!id.is_empty()).then_some(id), "idempotencyKey": attempt}),
            Duration::from_secs(25),
        )
        .await
    {
        Ok(raw) => codex_reset_outcome(&raw),
        // Codex was asked and said no, so nothing was used.
        Err(crate::workbench::codex::transport::CodexTransportError::Request(_)) => {
            ResetOutcome::said("unavailable")
        }
        Err(_) => ResetOutcome::said("unconfirmed"),
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

    #[test]
    fn usage_resets_read_the_same_from_claude_and_codex() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-24T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let claude = claude_resets(
            &json!({"eligible":true,"next_grant_id":"launch","cooldown_until":null,"grants":[
                {"id":"launch","label":"Launch reset","resets_left":1,"starts_at":"2026-09-22T16:00:00+00:00","ends_at":"2026-10-22T16:00:00+00:00","clears":["five_hour","seven_day","seven_day_overage_included"],"paused":false,"usable_now":true,"blocking":[]},
                {"id":"later","label":"Queued","resets_left":1,"ends_at":"2026-11-01T00:00:00Z","clears":["seven_day"],"usable_now":true,"blocking":["five_hour"]},
                {"id":"gone","label":"Expired","resets_left":1,"ends_at":"2026-09-01T00:00:00Z","usable_now":true},
                {"id":"spent","label":"Spent","resets_left":0,"usable_now":true}
            ]}),
            now,
        )
        .unwrap();
        assert_eq!(claude.available, 2);
        assert_eq!(claude.blocked, None);
        assert_eq!(claude.items.len(), 2);
        let first = &claude.items[0];
        assert!(first.usable);
        assert_eq!(first.expires_at.as_deref(), Some("2026-10-22T16:00:00.000Z"));
        assert_eq!(first.clears, vec!["session", "week"]);
        // Only the provider's next grant is offered.
        assert!(!claude.items[1].usable);
        assert!(claude.items[1].detail.as_deref().unwrap().contains("session"));

        let cooling = claude_resets(
            &json!({"eligible":true,"next_grant_id":"a","cooldown_until":"2026-09-25T00:00:00Z","grants":[{"id":"a","label":"A","resets_left":1,"usable_now":true}]}),
            now,
        )
        .unwrap();
        assert!(cooling.blocked.is_some());
        assert!(!cooling.items[0].usable);

        let codex = codex_usage(
            &json!({"rateLimits":{"primary":{"usedPercent":10,"windowDurationMins":300}},
                "rateLimitResetCredits":{"availableCount":3,"credits":[
                    {"id":"c1","title":"Referral reset","description":"Thanks for inviting a friend","grantedAt":1790000000,"expiresAt":1792000000,"resetType":"codexRateLimits","status":"available"},
                    {"id":"c2","grantedAt":1790000000,"expiresAt":null,"resetType":"codexRateLimits","status":"redeemed"}
                ]}}),
            "now",
        );
        let resets = codex.resets.unwrap();
        assert_eq!(resets.available, 3);
        assert_eq!(resets.items.len(), 1);
        assert_eq!(resets.items[0].title, "Referral reset");
        assert_eq!(resets.items[0].expires_at.as_deref(), Some("2026-10-14T17:46:40.000Z"));
        assert!(resets.items[0].usable);

        assert_eq!(codex_reset_outcome(&json!({"outcome":"reset"})).outcome, "reset");
        assert_eq!(codex_reset_outcome(&json!({"outcome":"noCredit"})).outcome, "no_reset");
        assert_eq!(claude_reset_outcome(&json!({"result":"not_limited"})).outcome, "nothing_to_reset");
        assert_eq!(claude_reset_outcome(&json!({"result":"unavailable","reason":"reset_unconfirmed"})).outcome, "unconfirmed");
    }
}
