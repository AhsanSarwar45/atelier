//! Validation for the bounded numerical rendering artifact. Kept in agreement
//! with src/workbench/render-model.ts through the shared presentation corpus.
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    version: f64,
    kind: String,
    title: String,
    description: Option<String>,
    width: f64,
    height: f64,
    frames: f64,
    fps: f64,
    parameters: Vec<Parameter>,
    buffers: Vec<Buffer>,
    views: Vec<View>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Parameter {
    id: String,
    label: String,
    min: f64,
    max: f64,
    step: f64,
    value: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Buffer {
    id: String,
    label: String,
    channels: Vec<String>,
    values: Vec<Value>,
    initial: Option<Vec<f64>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct View {
    id: String,
    label: String,
    buffer: String,
    display: String,
    channels: Vec<f64>,
    range: Vec<f64>,
    encoding: Option<String>,
}
fn finite(v: f64) -> bool {
    v.is_finite() && v.abs() <= 1e6
}
fn integer(v: f64, min: f64, max: f64) -> bool {
    finite(v) && v.fract() == 0.0 && v >= min && v <= max
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= max
}
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.as_bytes()[0].is_ascii_alphabetic()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn arity(op: &str) -> Option<usize> {
    match op {
        "abs" | "floor" | "sin" | "cos" | "sqrt" => Some(1),
        "add" | "sub" | "mul" | "div" | "mod" | "min" | "max" | "lt" | "le" | "gt" | "ge"
        | "eq" | "and" | "or" => Some(2),
        "if" | "mix" | "clamp" => Some(3),
        _ => None,
    }
}
struct Expressions<'a> {
    variables: &'a BTreeSet<String>,
    buffers: &'a BTreeMap<String, usize>,
    available: BTreeSet<String>,
    nodes: usize,
}
impl Expressions<'_> {
    fn valid(&mut self, value: &Value, depth: usize) -> bool {
        self.nodes += 1;
        if self.nodes > 512 || depth > 12 {
            return false;
        }
        if let Some(n) = value.as_f64() {
            return finite(n);
        }
        if let Some(s) = value.as_str() {
            return self.variables.contains(s);
        }
        let Some(a) = value.as_array() else {
            return false;
        };
        let Some(op) = a.first().and_then(Value::as_str) else {
            return false;
        };
        if op == "sample" {
            if a.len() != 6 {
                return false;
            }
            let Some(name) = a[1].as_str() else {
                return false;
            };
            let Some(channels) = self.buffers.get(name) else {
                return false;
            };
            return a[2]
                .as_f64()
                .is_some_and(|c| integer(c, 0.0, (*channels - 1) as f64))
                && (a[5].as_str() == Some("previous")
                    || a[5].as_str() == Some("current") && self.available.contains(name))
                && self.valid(&a[3], depth + 1)
                && self.valid(&a[4], depth + 1);
        }
        arity(op).is_some_and(|n| a.len() == n + 1)
            && a[1..].iter().all(|v| self.valid(v, depth + 1))
    }
}
pub fn validate(value: &Value) -> Result<(), String> {
    // Optional means absent, not null (the reader makes the same distinction).
    if value.get("description").is_some_and(Value::is_null) {
        return Err("description must be text".into());
    }
    let m: Model = serde_json::from_value(value.clone())
        .map_err(|e| format!("invalid rendering model: {e}"))?;
    if m.version != 1.0
        || m.kind != "render"
        || !text(&m.title, 200)
        || m.description.as_ref().is_some_and(|s| !text(s, 1000))
        || !integer(m.width, 1.0, 64.0)
        || !integer(m.height, 1.0, 64.0)
        || !integer(m.frames, 1.0, 60.0)
        || !integer(m.fps, 1.0, 30.0)
        || m.parameters.len() > 8
        || !(1..=8).contains(&m.buffers.len())
        || !(2..=4).contains(&m.views.len())
    {
        return Err("render: use dimensions 1–64, frames 1–60, fps 1–30, up to 8 parameters/buffers, and 2–4 views".into());
    }
    let mut variables: BTreeSet<String> = ["x", "y", "width", "height", "frame"]
        .into_iter()
        .map(str::to_string)
        .collect();
    for p in &m.parameters {
        if !id(&p.id)
            || !variables.insert(p.id.clone())
            || !text(&p.label, 200)
            || ![p.min, p.max, p.step, p.value].into_iter().all(finite)
            || p.min >= p.max
            || p.step <= 0.0
            || p.step > p.max - p.min
            || p.value < p.min
            || p.value > p.max
        {
            return Err("render parameter: unique nonreserved id, label, finite bounds, positive step and an in-range value required".into());
        }
    }
    let mut buffers = BTreeMap::new();
    for (i, b) in m.buffers.iter().enumerate() {
        if value["buffers"][i]
            .get("initial")
            .is_some_and(Value::is_null)
            || !id(&b.id)
            || buffers.insert(b.id.clone(), b.channels.len()).is_some()
            || !text(&b.label, 200)
            || !(1..=4).contains(&b.channels.len())
            || !b.channels.iter().all(|s| text(s, 200))
            || b.channels.iter().collect::<BTreeSet<_>>().len() != b.channels.len()
            || b.values.len() != b.channels.len()
            || b.initial
                .as_ref()
                .is_some_and(|v| v.len() != b.channels.len() || !v.iter().all(|n| finite(*n)))
        {
            return Err("render buffer: unique id, label and 1–4 named channels with matching expressions/initial values required".into());
        }
    }
    let mut expressions = Expressions {
        variables: &variables,
        buffers: &buffers,
        available: BTreeSet::new(),
        nodes: 0,
    };
    for b in &m.buffers {
        if !b.values.iter().all(|v| expressions.valid(v, 0)) {
            return Err("render expression: unknown variable/operation/reference, forward current-frame read, invalid arity, or depth/node limit exceeded".into());
        }
        expressions.available.insert(b.id.clone());
    }
    if m.width * m.height * m.frames * expressions.nodes as f64 > 6_000_000.0 {
        return Err("render computation exceeds 6,000,000 expression evaluations; reduce dimensions, frames or expressions".into());
    }
    let mut views = BTreeSet::new();
    for (i, v) in m.views.iter().enumerate() {
        let count = match v.display.as_str() {
            "rgb" => 3,
            "scalar" => 1,
            "vector" => 2,
            _ => 0,
        };
        let channels = buffers.get(&v.buffer).copied().unwrap_or(0);
        if value["views"][i]
            .get("encoding")
            .is_some_and(Value::is_null)
            || !id(&v.id)
            || !views.insert(&v.id)
            || !text(&v.label, 200)
            || channels == 0
            || count == 0
            || v.channels.len() != count
            || !v
                .channels
                .iter()
                .all(|c| integer(*c, 0.0, channels as f64 - 1.0))
            || v.range.len() != 2
            || !v.range.iter().all(|n| finite(*n))
            || v.range[0] >= v.range[1]
            || v.encoding
                .as_ref()
                .is_some_and(|e| v.display != "rgb" || !["linear", "raw"].contains(&e.as_str()))
        {
            return Err("render view: unique id, existing buffer/channels, rgb/scalar/vector display and increasing range required; encoding is linear/raw for rgb only".into());
        }
    }
    Ok(())
}
