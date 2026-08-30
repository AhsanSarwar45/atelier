//! Native isolated Chromium capture over the browser's own DevTools protocol.

use base64::Engine;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserRecipe {
    pub url: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub viewport: Option<Viewport>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub auth: Option<Auth>,
    #[serde(default)]
    pub actions: Vec<Value>,
    #[serde(default)]
    pub settle: Option<Settle>,
    #[serde(default)]
    pub capture: Option<Capture>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Auth {
    #[serde(default)]
    pub storage_state: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub http_credentials: Option<Credentials>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settle {
    #[serde(default)]
    pub network_idle_ms: Option<u64>,
    #[serde(default)]
    pub layout_stable_ms: Option<u64>,
    #[serde(default)]
    pub matching_frames: Option<u8>,
    #[serde(default)]
    pub disable_animations: Option<bool>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub clip: Option<Clip>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Clip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn parse_recipe(bytes: &[u8]) -> Result<BrowserRecipe, String> {
    if bytes.len() > 1024 * 1024 {
        return Err("browser recipe is too large".into());
    }
    let recipe: BrowserRecipe = serde_json::from_slice(bytes)
        .map_err(|e| format!("browser recipe must be valid JSON: {e}"))?;
    validate(&recipe)?;
    Ok(recipe)
}

fn bounded(text: &str, label: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > 10_000 {
        Err(format!("{label} must be a non-empty bounded string"))
    } else {
        Ok(())
    }
}

fn validate(recipe: &BrowserRecipe) -> Result<(), String> {
    let url = reqwest::Url::parse(&recipe.url).map_err(|_| "url must be an http or https URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("url must be an http or https URL".into());
    }
    if let Some(timeout) = recipe.timeout_ms {
        if !(100..=120_000).contains(&timeout) {
            return Err("timeout_ms must be an integer from 100 through 120000".into());
        }
    }
    if recipe.viewport.is_some() && recipe.device.is_some() {
        return Err("viewport and device are mutually exclusive".into());
    }
    if let Some(viewport) = &recipe.viewport {
        if !(100..=7680).contains(&viewport.width) || !(100..=4320).contains(&viewport.height) {
            return Err("viewport dimensions are out of range".into());
        }
    }
    if let Some(device) = recipe.device.as_deref() {
        if !matches!(device, "desktop" | "tablet" | "mobile") {
            return Err("device must be desktop, tablet, or mobile".into());
        }
    }
    if let Some(theme) = recipe.theme.as_deref() {
        if !matches!(theme, "light" | "dark" | "system") {
            return Err("theme must be light, dark, or system".into());
        }
    }
    if recipe.actions.len() > 50 {
        return Err("actions must contain at most 50 entries".into());
    }
    for (at, action) in recipe.actions.iter().enumerate() {
        validate_action(action, at)?;
    }
    if let Some(settle) = &recipe.settle {
        if settle.network_idle_ms.is_some_and(|v| v > 5000) {
            return Err("settle.network_idle_ms is out of range".into());
        }
        if settle
            .layout_stable_ms
            .is_some_and(|v| !(100..=5000).contains(&v))
        {
            return Err("settle.layout_stable_ms is out of range".into());
        }
        if settle
            .matching_frames
            .is_some_and(|v| !(2..=5).contains(&v))
        {
            return Err("settle.matching_frames is out of range".into());
        }
    }
    if let Some(capture) = &recipe.capture {
        let mode = capture.mode.as_deref().unwrap_or("viewport");
        if !matches!(mode, "viewport" | "full_page" | "element" | "clip") {
            return Err("capture.mode is invalid".into());
        }
        if mode == "element" && capture.selector.as_deref().is_none_or(str::is_empty) {
            return Err("capture.selector requires element mode".into());
        }
        if mode != "element" && capture.selector.is_some() {
            return Err("capture.selector requires element mode".into());
        }
        if mode == "clip"
            && capture.clip.as_ref().is_none_or(|clip| {
                clip.x < 0.0 || clip.y < 0.0 || clip.width < 1.0 || clip.height < 1.0
            })
        {
            return Err("capture.clip is invalid".into());
        }
        if mode != "clip" && capture.clip.is_some() {
            return Err("capture.clip requires clip mode".into());
        }
    }
    Ok(())
}

fn validate_action(action: &Value, at: usize) -> Result<(), String> {
    let row = action
        .as_object()
        .ok_or_else(|| format!("actions[{at}] must be an object"))?;
    let name = row
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("actions[{at}].action must be a string"))?;
    let fields: &[&str] = match name {
        "goto" => &["action", "url"],
        "click" | "check" | "uncheck" | "hover" => &["action", "selector"],
        "fill" => &["action", "selector", "value"],
        "type" => &["action", "selector", "text", "delay_ms"],
        "press" => &["action", "selector", "key"],
        "select" => &["action", "selector", "values"],
        "upload" => &["action", "selector", "file"],
        "wait" => &["action", "milliseconds"],
        "wait_for" => &["action", "selector", "state"],
        "wait_for_text" => &["action", "text"],
        _ => return Err(format!("actions[{at}] has unsupported action: {name}")),
    };
    if let Some(unknown) = row.keys().find(|key| !fields.contains(&key.as_str())) {
        return Err(format!("actions[{at}] has unknown field: {unknown}"));
    }
    for field in ["selector", "value", "text", "key", "file"] {
        if let Some(value) = row.get(field) {
            bounded(
                value.as_str().unwrap_or(""),
                &format!("actions[{at}].{field}"),
            )?;
        }
    }
    if name == "goto" {
        validate(&BrowserRecipe {
            url: row["url"].as_str().unwrap_or("").into(),
            timeout_ms: None,
            viewport: None,
            device: None,
            locale: None,
            timezone: None,
            theme: None,
            auth: None,
            actions: vec![],
            settle: None,
            capture: None,
        })?;
    }
    if name == "wait" && row["milliseconds"].as_u64().is_none_or(|v| v > 30_000) {
        return Err(format!("actions[{at}].milliseconds is out of range"));
    }
    if name == "select"
        && row["values"]
            .as_array()
            .is_none_or(|v| v.len() > 20 || v.iter().any(|x| !x.is_string()))
    {
        return Err(format!("actions[{at}].values must be bounded strings"));
    }
    Ok(())
}

pub fn browser_executable() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(target_os = "macos") {
        &[
            "google-chrome",
            "chromium",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
    } else if cfg!(windows) {
        &["chrome.exe", "msedge.exe"]
    } else {
        &["google-chrome", "chromium", "chromium-browser"]
    };
    if let Some(path) = crate::routes::find_tool("browser", names) {
        return Some(path);
    }
    for name in names {
        let path = Path::new(name);
        if path.is_absolute() && path.is_file() {
            return Some(path.into());
        }
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths) {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

struct BrowserChild {
    child: Child,
    profile: PathBuf,
}
impl Drop for BrowserChild {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.profile);
    }
}

async fn launch(executable: &Path, viewport: &Viewport) -> Result<(BrowserChild, String), String> {
    let profile = std::env::temp_dir().join(format!("atelier-browser-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&profile).map_err(|e| e.to_string())?;
    let mut child = Command::new(executable)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--remote-debugging-port=0",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!(
            "--window-size={},{}",
            viewport.width, viewport.height
        ))
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("WEB_CAPTURE_UNAVAILABLE: {e}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or("browser had no diagnostic stream")?;
    let mut lines = BufReader::new(stderr).lines();
    let endpoint = tokio::time::timeout(Duration::from_secs(15), async {
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(at) = line.find("ws://") {
                return Some(line[at..].trim().to_string());
            }
        }
        None
    })
    .await
    .map_err(|_| "WEB_CAPTURE_TIMEOUT: Chromium did not expose DevTools")?
    .ok_or("WEB_CAPTURE_UNAVAILABLE: Chromium ended before DevTools was ready")?;
    Ok((BrowserChild { child, profile }, endpoint))
}

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
struct Cdp {
    socket: Socket,
    next: u64,
    events: Vec<Value>,
}
impl Cdp {
    async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        self.socket
            .send(Message::Text(
                json!({"id":id,"method":method,"params":params}).to_string(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        while let Some(message) = self.socket.next().await {
            let message = message.map_err(|e| e.to_string())?;
            let Message::Text(text) = message else {
                continue;
            };
            let row: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if row["id"] == id {
                if let Some(error) = row.get("error") {
                    return Err(format!("DevTools {method} failed: {error}"));
                }
                return Ok(row.get("result").cloned().unwrap_or(Value::Null));
            }
            if row.get("method").is_some() {
                self.events.push(row);
            }
        }
        Err("Chromium DevTools connection closed".into())
    }
    async fn evaluate(&mut self, expression: String) -> Result<Value, String> {
        let result = self
            .call(
                "Runtime.evaluate",
                json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
            )
            .await?;
        if result["exceptionDetails"].is_object() {
            return Err(format!(
                "browser action failed: {}",
                result["exceptionDetails"]["text"]
                    .as_str()
                    .unwrap_or("JavaScript exception")
            ));
        }
        Ok(result["result"]["value"].clone())
    }
}

fn safe_url(raw: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(raw) else {
        return raw.split(['?', '#']).next().unwrap_or(raw).to_string();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    let keys: Vec<_> = url.query_pairs().map(|(key, _)| key.into_owned()).collect();
    if !keys.is_empty() {
        url.query_pairs_mut().clear();
        for key in keys {
            url.query_pairs_mut().append_pair(&key, "[redacted]");
        }
    }
    url.set_fragment(None);
    url.to_string()
}

fn network_active(events: &[Value]) -> HashSet<String> {
    let mut active = HashSet::new();
    for event in events {
        let method = event["method"].as_str().unwrap_or("");
        let id = event["params"]["requestId"].as_str().unwrap_or("");
        if id.is_empty() {
            continue;
        }
        match method {
            "Network.requestWillBeSent"
                if !matches!(
                    event["params"]["type"].as_str(),
                    Some("WebSocket" | "EventSource")
                ) =>
            {
                active.insert(id.to_string());
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                active.remove(id);
            }
            _ => {}
        }
    }
    active
}

async fn wait_for_network_quiet(
    cdp: &mut Cdp,
    idle: Duration,
    deadline: Instant,
) -> Result<(), String> {
    let mut quiet_since = None;
    loop {
        cdp.evaluate("true".into()).await?;
        if network_active(&cdp.events).is_empty() {
            let since = quiet_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= idle {
                return Ok(());
            }
        } else {
            quiet_since = None;
        }
        if Instant::now() >= deadline {
            return Err("WEB_CAPTURE_TIMEOUT: network did not become quiet".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn wait_for_layout_stable(
    cdp: &mut Cdp,
    stable: Duration,
    deadline: Instant,
) -> Result<(), String> {
    const SNAPSHOT: &str = "JSON.stringify({scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,rects:[...document.querySelectorAll('body *')].slice(0,500).map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10]})})";
    let mut prior = Value::Null;
    let mut stable_since = Instant::now();
    loop {
        let snapshot = cdp.evaluate(SNAPSHOT.into()).await?;
        if snapshot != prior {
            prior = snapshot;
            stable_since = Instant::now();
        } else if stable_since.elapsed() >= stable {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("WEB_CAPTURE_TIMEOUT: layout did not stabilize".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn screenshot(cdp: &mut Cdp, params: &Value) -> Result<Vec<u8>, String> {
    let shot = cdp.call("Page.captureScreenshot", params.clone()).await?;
    base64::engine::general_purpose::STANDARD
        .decode(
            shot["data"]
                .as_str()
                .ok_or("Chromium returned no screenshot")?,
        )
        .map_err(|e| e.to_string())
}

async fn stable_screenshot(
    cdp: &mut Cdp,
    params: &Value,
    required: u8,
    deadline: Instant,
) -> Result<(Vec<u8>, u8), String> {
    let mut prior = None;
    let mut matching = 0;
    for attempt in 1..=10 {
        let bytes = screenshot(cdp, params).await?;
        let hash = sha2::Sha256::digest(&bytes);
        if prior.as_ref() == Some(&hash) {
            matching += 1;
        } else {
            matching = 1;
        }
        prior = Some(hash);
        if matching >= required {
            return Ok((bytes, attempt));
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!(
        "WEB_CAPTURE_UNSTABLE: 10 screenshots did not produce {required} matching frames"
    ))
}

fn storage_state(
    recipe: &BrowserRecipe,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<Option<Value>, String> {
    let Some(name) = recipe
        .auth
        .as_ref()
        .and_then(|auth| auth.storage_state.as_deref())
    else {
        return Ok(None);
    };
    let bytes = files
        .get(name)
        .ok_or_else(|| format!("recipe storage state was not supplied: {name}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("browser storage state is too large".into());
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("browser storage state must be valid JSON: {e}"))?;
    if !value.is_object()
        || value["cookies"].as_array().is_none()
        || value["origins"].as_array().is_none()
    {
        return Err("browser storage state must contain cookies and origins arrays".into());
    }
    Ok(Some(value))
}

async fn apply_storage_state(
    cdp: &mut Cdp,
    recipe: &BrowserRecipe,
    files: &BTreeMap<String, Vec<u8>>,
    deadline: Instant,
) -> Result<(), String> {
    let Some(state) = storage_state(recipe, files)? else {
        return Ok(());
    };
    if !state["cookies"].as_array().unwrap().is_empty() {
        cdp.call("Network.setCookies", json!({"cookies":state["cookies"]}))
            .await?;
    }
    let target = reqwest::Url::parse(&recipe.url).map_err(|e| e.to_string())?;
    let origin = target.origin().ascii_serialization();
    let matching = state["origins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["origin"].as_str() == Some(&origin));
    if let Some(row) = matching {
        cdp.call("Page.navigate", json!({"url":format!("{origin}/")}))
            .await?;
        wait_until(
            cdp,
            || "document.readyState === 'complete'".into(),
            deadline,
        )
        .await?;
        let entries = row["localStorage"]
            .as_array()
            .ok_or("browser storage-state origin has invalid localStorage")?;
        for entry in entries {
            let name = entry["name"]
                .as_str()
                .ok_or("browser localStorage entry has no name")?;
            let value = entry["value"]
                .as_str()
                .ok_or("browser localStorage entry has no value")?;
            cdp.evaluate(format!(
                "localStorage.setItem({},{});true",
                serde_json::to_string(name).unwrap(),
                serde_json::to_string(value).unwrap()
            ))
            .await?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapture {
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub diagnostics: Vec<String>,
    pub final_url: String,
    #[serde(skip)]
    pub comparison_url: String,
    pub evidence: Value,
}

fn script_for(action: &Value) -> Result<Option<String>, String> {
    let kind = action["action"].as_str().unwrap();
    if matches!(
        kind,
        "goto" | "wait" | "wait_for" | "wait_for_text" | "upload"
    ) {
        return Ok(None);
    }
    let selector = serde_json::to_string(action["selector"].as_str().unwrap()).unwrap();
    let target = format!("document.querySelector({selector})");
    let body = match kind {
        "click" => format!("{target}?.click()"),
        "fill" => format!("(()=>{{const e={target};if(!e)throw Error('selector not found');e.value={};e.dispatchEvent(new Event('input',{{bubbles:true}}));}})()", serde_json::to_string(action["value"].as_str().unwrap()).unwrap()),
        "type" => format!("(()=>{{const e={target};if(!e)throw Error('selector not found');e.value=(e.value||'')+{};e.dispatchEvent(new Event('input',{{bubbles:true}}));}})()", serde_json::to_string(action["text"].as_str().unwrap()).unwrap()),
        "press" => format!("{target}?.dispatchEvent(new KeyboardEvent('keydown',{{key:{},bubbles:true}}))", serde_json::to_string(action["key"].as_str().unwrap()).unwrap()),
        "select" => format!("(()=>{{const e={target};const v={};for(const o of e.options)o.selected=v.includes(o.value);e.dispatchEvent(new Event('change',{{bubbles:true}}));}})()", action["values"]),
        "check" => format!("(()=>{{const e={target};e.checked=true;e.dispatchEvent(new Event('change',{{bubbles:true}}));}})()"),
        "uncheck" => format!("(()=>{{const e={target};e.checked=false;e.dispatchEvent(new Event('change',{{bubbles:true}}));}})()"),
        "hover" => format!("{target}?.dispatchEvent(new MouseEvent('mouseover',{{bubbles:true}}))"),
        _ => return Err(format!("unsupported browser action: {kind}")),
    };
    Ok(Some(body))
}

async fn wait_until(
    cdp: &mut Cdp,
    expression: impl Fn() -> String,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        if cdp.evaluate(expression()).await?.as_bool() == Some(true) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("WEB_CAPTURE_TIMEOUT: semantic wait did not settle".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn capture_recipe(
    recipe: &BrowserRecipe,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<BrowserCapture, String> {
    validate(recipe)?;
    let executable =
        browser_executable().ok_or("WEB_CAPTURE_UNAVAILABLE: install Chrome, Chromium, or Edge")?;
    let viewport = recipe
        .viewport
        .clone()
        .unwrap_or(match recipe.device.as_deref() {
            Some("tablet") => Viewport {
                width: 820,
                height: 1180,
            },
            Some("mobile") => Viewport {
                width: 390,
                height: 844,
            },
            _ => Viewport {
                width: 1280,
                height: 800,
            },
        });
    let timeout = Duration::from_millis(recipe.timeout_ms.unwrap_or(30_000));
    let deadline = Instant::now() + timeout;
    let (_child, browser_ws) = launch(&executable, &viewport).await?;
    let authority = browser_ws
        .trim_start_matches("ws://")
        .split('/')
        .next()
        .ok_or("malformed DevTools endpoint")?;
    let mut create =
        reqwest::Url::parse(&format!("http://{authority}/json/new")).map_err(|e| e.to_string())?;
    create.query_pairs_mut().append_pair("url", "about:blank");
    let target: Value = reqwest::Client::new()
        .put(create)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let page_ws = target["webSocketDebuggerUrl"]
        .as_str()
        .ok_or("Chromium did not create a page target")?;
    let (socket, _) = connect_async(page_ws).await.map_err(|e| e.to_string())?;
    let mut cdp = Cdp {
        socket,
        next: 0,
        events: Vec::new(),
    };
    for domain in ["Page.enable", "Runtime.enable", "Network.enable"] {
        cdp.call(domain, json!({})).await?;
    }
    cdp.call("Emulation.setDeviceMetricsOverride", json!({"width":viewport.width,"height":viewport.height,"deviceScaleFactor":if recipe.device.as_deref()==Some("mobile") {3} else if recipe.device.as_deref()==Some("tablet") {2} else {1},"mobile":matches!(recipe.device.as_deref(),Some("mobile"|"tablet"))})).await?;
    if let Some(locale) = &recipe.locale {
        cdp.call("Emulation.setLocaleOverride", json!({"locale":locale}))
            .await?;
    }
    if let Some(timezone) = &recipe.timezone {
        cdp.call(
            "Emulation.setTimezoneOverride",
            json!({"timezoneId":timezone}),
        )
        .await?;
    }
    if let Some(theme) = recipe.theme.as_deref().filter(|theme| *theme != "system") {
        cdp.call(
            "Emulation.setEmulatedMedia",
            json!({"features":[{"name":"prefers-color-scheme","value":theme}]}),
        )
        .await?;
    }
    let mut headers = recipe
        .auth
        .as_ref()
        .map(|auth| auth.headers.clone())
        .unwrap_or_default();
    if let Some(credentials) = recipe
        .auth
        .as_ref()
        .and_then(|auth| auth.http_credentials.as_ref())
    {
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", credentials.username, credentials.password));
        headers.insert("Authorization".into(), format!("Basic {encoded}"));
    }
    if !headers.is_empty() {
        cdp.call("Network.setExtraHTTPHeaders", json!({"headers":headers}))
            .await?;
    }
    apply_storage_state(&mut cdp, recipe, files, deadline).await?;
    cdp.call("Page.navigate", json!({"url":recipe.url})).await?;
    wait_until(
        &mut cdp,
        || "document.readyState === 'complete'".into(),
        deadline,
    )
    .await?;
    let action_started = Instant::now();
    for action in &recipe.actions {
        match action["action"].as_str().unwrap() {
            "goto" => {
                cdp.call("Page.navigate", json!({"url":action["url"]}))
                    .await?;
                wait_until(
                    &mut cdp,
                    || "document.readyState === 'complete'".into(),
                    deadline,
                )
                .await?;
            }
            "wait" => {
                let delay = Duration::from_millis(action["milliseconds"].as_u64().unwrap());
                if Instant::now() + delay > deadline {
                    return Err("WEB_CAPTURE_TIMEOUT: wait exceeds remaining time".into());
                }
                tokio::time::sleep(delay).await;
            }
            "wait_for" => {
                let selector = serde_json::to_string(action["selector"].as_str().unwrap()).unwrap();
                let state = action["state"].as_str().unwrap_or("visible").to_string();
                wait_until(
                    &mut cdp,
                    || {
                        format!(
                            "(()=>{{const e=document.querySelector({selector});return {} }})()",
                            match state.as_str() {
                                "attached" => "!!e",
                                "detached" => "!e",
                                "hidden" => "!e || !e.getClientRects().length",
                                _ => "!!e && !!e.getClientRects().length",
                            }
                        )
                    },
                    deadline,
                )
                .await?;
            }
            "wait_for_text" => {
                let text = serde_json::to_string(action["text"].as_str().unwrap()).unwrap();
                wait_until(
                    &mut cdp,
                    || format!("document.body?.innerText.includes({text})"),
                    deadline,
                )
                .await?;
            }
            "upload" => {
                let name = action["file"].as_str().unwrap();
                let bytes = files
                    .get(name)
                    .ok_or_else(|| format!("recipe upload was not supplied: {name}"))?;
                let path = _child
                    .profile
                    .join(Path::new(name).file_name().unwrap_or_default());
                std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
                let root = cdp.call("DOM.getDocument", json!({})).await?["root"]["nodeId"]
                    .as_i64()
                    .ok_or("DOM root missing")?;
                let node = cdp
                    .call(
                        "DOM.querySelector",
                        json!({"nodeId":root,"selector":action["selector"]}),
                    )
                    .await?["nodeId"]
                    .as_i64()
                    .filter(|id| *id > 0)
                    .ok_or("upload selector not found")?;
                cdp.call(
                    "DOM.setFileInputFiles",
                    json!({"nodeId":node,"files":[path]}),
                )
                .await?;
            }
            _ => {
                if let Some(script) = script_for(action)? {
                    cdp.evaluate(script).await?;
                }
            }
        }
    }
    let action_ms = action_started.elapsed().as_millis() as u64;
    let settle_started = Instant::now();
    let settle = recipe.settle.clone().unwrap_or_default();
    let network_idle = Duration::from_millis(settle.network_idle_ms.unwrap_or(500));
    wait_for_network_quiet(&mut cdp, network_idle, deadline).await?;
    if settle.disable_animations != Some(false) {
        cdp.evaluate("(()=>{const s=document.createElement('style');s.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';document.documentElement.append(s);return true})()".into()).await?;
    }
    wait_until(
        &mut cdp,
        || {
            "document.fonts?.status === 'loaded' && [...document.images].every(i=>i.complete)"
                .into()
        },
        deadline,
    )
    .await?;
    if let Some(selector) = settle.selector {
        let selector = serde_json::to_string(&selector).unwrap();
        wait_until(
            &mut cdp,
            || format!("!!document.querySelector({selector})"),
            deadline,
        )
        .await?;
    }
    if let Some(text) = settle.text {
        let text = serde_json::to_string(&text).unwrap();
        wait_until(
            &mut cdp,
            || format!("document.body?.innerText.includes({text})"),
            deadline,
        )
        .await?;
    }
    let layout_stable = Duration::from_millis(settle.layout_stable_ms.unwrap_or(300));
    wait_for_layout_stable(&mut cdp, layout_stable, deadline).await?;
    let capture = recipe.capture.clone().unwrap_or_default();
    let mode = capture.mode.as_deref().unwrap_or("viewport");
    let clip = match mode {
        "full_page" => {
            let metrics = cdp.call("Page.getLayoutMetrics", json!({})).await?;
            Some(
                json!({"x":0,"y":0,"width":metrics["cssContentSize"]["width"],"height":metrics["cssContentSize"]["height"],"scale":1}),
            )
        }
        "element" => {
            let selector = serde_json::to_string(capture.selector.as_deref().unwrap()).unwrap();
            let rect = cdp.evaluate(format!("(()=>{{const r=document.querySelector({selector})?.getBoundingClientRect();return r&&{{x:r.x,y:r.y,width:r.width,height:r.height}}}})()" )).await?;
            Some(
                json!({"x":rect["x"],"y":rect["y"],"width":rect["width"],"height":rect["height"],"scale":1}),
            )
        }
        "clip" => capture.clip.map(
            |clip| json!({"x":clip.x,"y":clip.y,"width":clip.width,"height":clip.height,"scale":1}),
        ),
        _ => None,
    };
    let mut params =
        json!({"format":"png","fromSurface":true,"captureBeyondViewport":mode=="full_page"});
    if let Some(clip) = clip {
        params["clip"] = clip;
    }
    let required_frames = settle.matching_frames.unwrap_or(2);
    let (bytes, frame_attempts) =
        stable_screenshot(&mut cdp, &params, required_frames, deadline).await?;
    let semantic = cdp.evaluate("(()=>({url:location.href,text:(document.body?.innerText||'').slice(0,100000),nodes:[...document.querySelectorAll('button,input,select,textarea,a,[role]')].slice(0,500).map(e=>({role:e.getAttribute('role')||e.tagName.toLowerCase(),name:e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||''}))}))()".into()).await?;
    let version = cdp.call("Browser.getVersion", json!({})).await?["product"]
        .as_str()
        .unwrap_or("Chromium")
        .to_string();
    let comparison_url = semantic["url"].as_str().unwrap_or(&recipe.url).to_string();
    let final_url = safe_url(&comparison_url);
    let failures = cdp
        .events
        .iter()
        .filter(|event| event["method"] == "Network.loadingFailed")
        .count();
    let console_errors = cdp
        .events
        .iter()
        .filter(|event| {
            event["method"] == "Runtime.consoleAPICalled" && event["params"]["type"] == "error"
        })
        .count();
    let status = cdp.events.iter().rev().find_map(|event| {
        (event["method"] == "Network.responseReceived" && event["params"]["type"] == "Document")
            .then(|| event["params"]["response"]["status"].as_u64())
            .flatten()
    });
    let redirects: Vec<_> = cdp
        .events
        .iter()
        .filter(|event| {
            event["method"] == "Network.requestWillBeSent"
                && event["params"]["redirectResponse"].is_object()
        })
        .map(|event| {
            json!({
                "url":safe_url(event["params"]["redirectResponse"]["url"].as_str().unwrap_or("")),
                "status":event["params"]["redirectResponse"]["status"]
            })
        })
        .collect();
    Ok(BrowserCapture {
        bytes,
        diagnostics: vec![
            format!("final-url={final_url}"),
            format!(
                "status={}",
                status.map_or_else(|| "unknown".into(), |v| v.to_string())
            ),
            format!("actions={}", recipe.actions.len()),
            "load=complete".into(),
            format!("network-idle-ms={}", network_idle.as_millis()),
            "fonts=ready".into(),
            "images=ready".into(),
            format!("layout-stable-ms={}", layout_stable.as_millis()),
            format!("capture={mode}"),
            format!("matching-frame-attempts={frame_attempts}"),
        ],
        final_url: final_url.clone(),
        comparison_url,
        evidence: json!({
            "source":"browser","final_url":final_url,"status":status,"redirects":redirects,"timing_ms":{"total":timeout.as_millis() as u64-(deadline.saturating_duration_since(Instant::now()).as_millis() as u64),"actions":action_ms,"settle":settle_started.elapsed().as_millis() as u64},
            "browser":{"engine":"chromium","version":version},"dimensions":{"width":viewport.width,"height":viewport.height,"device_scale_factor":if recipe.device.as_deref()==Some("mobile"){3}else if recipe.device.as_deref()==Some("tablet"){2}else{1},"mode":mode},
            "console":{"error_count":console_errors},"network":{"failure_count":failures},"visible_text":{"source":"dom","text":semantic["text"]},"accessibility":{"source":"dom-accessibility-outline","nodes":semantic["nodes"]}
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_workbench_services_media_strictly_validates_browser_recipes_and_discovers_explicit_browser(
    ) {
        let recipe = parse_recipe(br##"{"url":"https://app.test","device":"mobile","actions":[{"action":"click","selector":"#go"}],"capture":{"mode":"element","selector":"#card"}}"##).unwrap();
        assert_eq!(recipe.device.as_deref(), Some("mobile"));
        assert!(parse_recipe(br#"{"url":"file:///secret"}"#).is_err());
        assert!(parse_recipe(br#"{"url":"https://x","evaluate":"steal()"}"#).is_err());
        assert!(parse_recipe(
            br#"{"url":"https://x","actions":[{"action":"evaluate","text":"x"}]}"#
        )
        .is_err());
        assert_eq!(
            safe_url("https://user:secret@app.test/path?token=secret&next=private#piece"),
            "https://app.test/path?token=%5Bredacted%5D&next=%5Bredacted%5D"
        );

        let recipe = BrowserRecipe {
            url: "https://app.test/".into(),
            timeout_ms: None,
            viewport: None,
            device: None,
            locale: None,
            timezone: None,
            theme: None,
            auth: Some(Auth {
                storage_state: Some("state.json".into()),
                ..Auth::default()
            }),
            actions: vec![],
            settle: None,
            capture: None,
        };
        let files = BTreeMap::from([(
            "state.json".into(),
            br#"{"cookies":[],"origins":[]}"#.to_vec(),
        )]);
        assert!(storage_state(&recipe, &files).unwrap().is_some());
        assert!(storage_state(&recipe, &BTreeMap::new()).is_err());
    }

    #[tokio::test]
    async fn native_workbench_services_media_drives_an_isolated_real_browser_when_available() {
        if browser_executable().is_none() {
            return;
        }
        let app = axum::Router::new().route(
            "/",
            axum::routing::get(|| async {
                axum::response::Html(r#"<input id="input"><button onclick="document.querySelector('#out').textContent=document.querySelector('#input').value">Save</button><output id="out"></output>"#)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let recipe = BrowserRecipe {
            url: format!("http://{address}/"),
            timeout_ms: Some(15_000),
            viewport: None,
            device: None,
            locale: None,
            timezone: None,
            theme: None,
            auth: None,
            actions: vec![
                json!({"action":"fill","selector":"#input","value":"Ada"}),
                json!({"action":"click","selector":"button"}),
                json!({"action":"wait_for_text","text":"Ada"}),
            ],
            settle: Some(Settle {
                network_idle_ms: Some(0),
                ..Settle::default()
            }),
            capture: None,
        };
        let result = capture_recipe(&recipe, &BTreeMap::new()).await.unwrap();
        assert!(result.bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]));
        assert!(result.evidence["visible_text"]["text"]
            .as_str()
            .unwrap()
            .contains("Ada"));
        server.abort();
    }
}
