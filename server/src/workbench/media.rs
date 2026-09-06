//! Native content-addressed presentation media and objective PNG evidence.

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Write};
use std::path::Path;

const IMAGE_LIMIT: usize = 25 * 1024 * 1024;
const ARTIFACT_LIMIT: usize = 1024 * 1024;
const PNG_MAGIC: &[u8] = &[137, 80, 78, 71, 13, 10, 26, 10];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ImageKind {
    Png,
    Jpg,
    Gif,
    Webp,
}
impl ImageKind {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpg => "jpg",
            Self::Gif => "gif",
            Self::Webp => "webp",
        }
    }
}

pub fn image_kind(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.starts_with(PNG_MAGIC) {
        Some(ImageKind::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageKind::Jpg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(ImageKind::Gif)
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn keep_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("media path has no parent")?)
        .map_err(|e| e.to_string())?;
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub fn import_image(bytes: &[u8], label: &str, directory: &Path) -> Result<String, String> {
    if bytes.len() > IMAGE_LIMIT {
        return Err(format!("{label} is larger than 25 MiB"));
    }
    let kind = image_kind(bytes)
        .ok_or_else(|| format!("{label} is not a PNG, JPEG, GIF, or WebP image"))?;
    let asset = format!("{}.{}", digest(bytes), kind.extension());
    keep_new(&directory.join(&asset), bytes)?;
    Ok(asset)
}

pub fn existing_image(asset: &str, directory: &Path) -> Result<String, String> {
    let Some((claimed, extension)) = asset.split_once('.') else {
        return Err("--asset must name a stored PNG, JPEG, GIF, or WebP".into());
    };
    if claimed.len() != 64
        || !claimed
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || !matches!(extension, "png" | "jpg" | "gif" | "webp")
    {
        return Err("--asset must name a stored PNG, JPEG, GIF, or WebP".into());
    }
    let bytes = fs::read(directory.join(asset))
        .map_err(|_| format!("presentation asset does not exist: {asset}"))?;
    let kind = image_kind(&bytes).map(ImageKind::extension);
    if kind != Some(extension) || digest(&bytes) != claimed {
        return Err(format!(
            "presentation asset failed content validation: {asset}"
        ));
    }
    Ok(asset.to_string())
}

fn valid_text(value: &Value, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.trim().is_empty() && text.len() <= max)
}

fn artifact(value: &Value) -> bool {
    if value["version"] != 1 || !valid_text(&value["title"], 200) {
        return false;
    }
    match value["kind"].as_str() {
        Some("mermaid") => valid_text(&value["source"], 50_000),
        Some("flow") => {
            value["nodes"]
                .as_array()
                .is_some_and(|v| (2..=100).contains(&v.len()))
                && value["edges"].as_array().is_some_and(|v| v.len() <= 200)
        }
        Some("scene") => {
            value["viewBox"].as_array().is_some_and(|v| v.len() == 4)
                && value["elements"]
                    .as_array()
                    .is_some_and(|v| (1..=200).contains(&v.len()))
                && value["states"]
                    .as_array()
                    .is_some_and(|v| (1..=30).contains(&v.len()))
        }
        Some("mockup") => {
            valid_text(&value["initialScreen"], 64)
                && value["screens"]
                    .as_array()
                    .is_some_and(|v| (1..=20).contains(&v.len()))
        }
        _ => false,
    }
}

fn ordered(value: &Value) -> Value {
    match value {
        Value::Array(rows) => Value::Array(rows.iter().map(ordered).collect()),
        Value::Object(row) => {
            let mut keys: Vec<_> = row.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), ordered(&row[key])))
                    .collect(),
            )
        }
        _ => value.clone(),
    }
}

pub fn import_artifact(
    bytes: &[u8],
    label: &str,
    directory: &Path,
) -> Result<(String, String, String), String> {
    if bytes.len() > ARTIFACT_LIMIT {
        return Err(format!("{label} is larger than 1 MiB"));
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("artifact is not valid JSON: {e}"))?;
    if !artifact(&value) {
        return Err("Artifact does not match the contract".into());
    }
    let mut canonical = serde_json::to_vec(&ordered(&value)).map_err(|e| e.to_string())?;
    canonical.push(b'\n');
    let asset = format!("{}.artifact.json", digest(&canonical));
    keep_new(&directory.join(&asset), &canonical)?;
    Ok((
        asset,
        value["title"].as_str().unwrap().into(),
        value["kind"].as_str().unwrap().into(),
    ))
}

/// The one contract, on the presenter's side. `src/workbench/chat-widgets.ts`
/// holds the reader's side of it and `tests/fixtures/presentation-corpus.json`
/// records the verdict both must reach; a rule changed here without changing
/// the corpus fails `tests/the_presenter_and_the_reader_agree.rs`.
///
/// Every refusal names the field at fault, because the agent that wrote the
/// payload sees only this string and cannot look at what was drawn.
pub fn widget_block(value: &Value) -> Result<String, String> {
    let object = value.as_object().ok_or("a widget is a JSON object")?;
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .ok_or("type is required and names the kind of widget")?;
    let allowed = match kind {
        "image" => &["type", "title", "asset", "alt", "caption"][..],
        "image_compare" => &["type", "title", "mode", "before", "after"][..],
        "artifact" => &["type", "title", "kind", "asset"][..],
        "metrics" | "progress" | "timeline" => &["type", "title", "items"][..],
        "chart" => &["type", "title", "chart", "series", "data"][..],
        "table" => &["type", "title", "columns", "rows"][..],
        "video" => &["type", "title", "src", "poster"][..],
        "explainer" => &[
            "type", "layout", "title", "summary", "nodes", "edges", "steps", "evidence",
        ][..],
        other => {
            return Err(format!(
                "{other} is not a widget type: use metrics, chart, progress, timeline, table, video, image, image_compare, artifact or explainer"
            ))
        }
    };
    only_fields(object, allowed, kind)?;
    optional_string(object, "title", 200)?;
    match kind {
        "image" => {
            stored_image(object.get("asset"), "asset")?;
            required_string(object, "alt", 200)?;
            optional_string(object, "caption", 200)?;
        }
        "image_compare" => {
            one_of(object, "mode", &["side_by_side", "wipe"], true)?;
            for side in ["before", "after"] {
                let shot = object
                    .get(side)
                    .and_then(Value::as_object)
                    .ok_or_else(|| format!("{side} is required and is an object"))?;
                only_fields(shot, &["asset", "alt"], side)?;
                stored_image(shot.get("asset"), &format!("{side}.asset"))?;
                required_string(shot, "alt", 200)?;
            }
        }
        "artifact" => {
            if !asset_name(object.get("asset").unwrap_or(&Value::Null), true) {
                return Err("asset must name a stored artifact, as <64 hex characters>.artifact.json".into());
            }
            one_of(object, "kind", &["mermaid", "flow", "scene", "mockup"], true)?;
        }
        "metrics" => {
            for item in list(object, "items", 1, 6)? {
                let item = row(item, "items")?;
                only_fields(item, &["label", "value", "detail", "trend"], "items")?;
                required_string(item, "label", 200)?;
                required_string(item, "value", 200)?;
                optional_string(item, "detail", 200)?;
                one_of(item, "trend", &["up", "down", "flat"], false)?;
            }
        }
        "progress" => {
            for item in list(object, "items", 1, 12)? {
                let item = row(item, "items")?;
                only_fields(item, &["label", "value", "max", "detail"], "items")?;
                required_string(item, "label", 200)?;
                number(item.get("value"), "items[].value")?;
                if let Some(max) = item.get("max") {
                    if number(Some(max), "items[].max")? <= 0.0 {
                        return Err("items[].max must be above zero".into());
                    }
                }
                optional_string(item, "detail", 200)?;
            }
        }
        "timeline" => {
            for item in list(object, "items", 1, 20)? {
                let item = row(item, "items")?;
                only_fields(item, &["label", "detail", "status"], "items")?;
                required_string(item, "label", 200)?;
                optional_string(item, "detail", 200)?;
                one_of(item, "status", &["done", "current", "next"], false)?;
            }
        }
        "chart" => {
            one_of(object, "chart", &["bar", "line"], true)?;
            let series = list(object, "series", 1, 4)?;
            for one in series {
                let one = row(one, "series")?;
                only_fields(one, &["name", "color"], "series")?;
                required_string(one, "name", 200)?;
                optional_string(one, "color", 200)?;
            }
            let width = series.len();
            for point in list(object, "data", 1, 30)? {
                let point = row(point, "data")?;
                only_fields(point, &["label", "values"], "data")?;
                required_string(point, "label", 200)?;
                let values = point
                    .get("values")
                    .and_then(Value::as_array)
                    .ok_or("data[].values is required and is a list of numbers")?;
                if values.len() != width {
                    return Err(format!(
                        "data[].values carries {}, but there are {}: give one value per series",
                        many(values.len(), "number"),
                        many(width, "series entry")
                    ));
                }
                for one in values {
                    number(Some(one), "data[].values")?;
                }
            }
        }
        "table" => {
            let columns = list(object, "columns", 1, 8)?;
            for column in columns {
                string(Some(column), "columns[]", 200)?;
            }
            let width = columns.len();
            let rows = object
                .get("rows")
                .and_then(Value::as_array)
                .ok_or("rows is required and is a list of rows")?;
            if rows.len() > 30 {
                return Err(format!(
                    "rows carries {}, and a table shows at most 30",
                    many(rows.len(), "row")
                ));
            }
            for cells in rows {
                let cells = cells
                    .as_array()
                    .ok_or("every row is a list of cells")?;
                if cells.len() != width {
                    return Err(format!(
                        "a row carries {}, but there are {}: every row matches the columns",
                        many(cells.len(), "cell"),
                        many(width, "column")
                    ));
                }
                for cell in cells {
                    string(Some(cell), "a table cell", 200)?;
                }
            }
        }
        "video" => {
            media_source(object.get("src"), "src")?;
            if object.contains_key("poster") {
                media_source(object.get("poster"), "poster")?;
            }
        }
        "explainer" => {
            one_of(object, "layout", &["flow", "sequence", "cycle", "layers"], false)?;
            optional_string(object, "summary", 200)?;
            let nodes = list(object, "nodes", 2, 12)?;
            let mut ids = std::collections::BTreeSet::new();
            for node in nodes {
                let node = row(node, "nodes")?;
                only_fields(node, &["id", "label", "detail"], "nodes")?;
                let id = required_string(node, "id", 200)?;
                required_string(node, "label", 200)?;
                optional_string(node, "detail", 200)?;
                if !ids.insert(id.to_string()) {
                    return Err(format!("two nodes are called {id}: node ids are unique"));
                }
            }
            for edge in list(object, "edges", 1, 20)? {
                let edge = row(edge, "edges")?;
                only_fields(edge, &["from", "to", "label"], "edges")?;
                for end in ["from", "to"] {
                    let named = required_string(edge, end, 200)?;
                    if !ids.contains(named) {
                        return Err(format!("an edge names {named} as its {end}, and no node has that id"));
                    }
                }
                optional_string(edge, "label", 200)?;
            }
            for step in list(object, "steps", 1, 12)? {
                let step = row(step, "steps")?;
                only_fields(step, &["label", "detail", "active"], "steps")?;
                required_string(step, "label", 200)?;
                optional_string(step, "detail", 200)?;
                let active = step
                    .get("active")
                    .and_then(Value::as_array)
                    .filter(|lit| !lit.is_empty())
                    .ok_or("steps[].active names at least one node to light")?;
                for named in active {
                    let named = string(Some(named), "steps[].active", 200)?;
                    if !ids.contains(named) {
                        return Err(format!("a step lights {named}, and no node has that id"));
                    }
                }
            }
            if let Some(evidence) = object.get("evidence") {
                let evidence = evidence
                    .as_array()
                    .filter(|lit| lit.len() <= 12)
                    .ok_or("evidence is a list of at most 12 entries")?;
                for one in evidence {
                    let one = row(one, "evidence")?;
                    only_fields(one, &["label", "path", "line"], "evidence")?;
                    required_string(one, "label", 200)?;
                    let path = required_string(one, "path", 4096)?;
                    if !absolute(path) {
                        return Err(format!("evidence[].path is {path}, and evidence paths are absolute"));
                    }
                    if let Some(line) = one.get("line") {
                        if line.as_u64().is_none_or(|at| at == 0) {
                            return Err("evidence[].line is a whole number from 1 upwards".into());
                        }
                    }
                }
            }
        }
        _ => unreachable!("the type was matched against the field allowlist above"),
    }
    Ok(format!(
        "```atelier-widget\n{}\n```\n",
        serde_json::to_string(&ordered(value)).unwrap()
    ))
}

type Row = serde_json::Map<String, Value>;

/// Counts in a refusal, so one of something never reads as "1 cells".
fn many(count: usize, noun: &str) -> String {
    if count == 1 {
        return format!("1 {noun}");
    }
    match noun.strip_suffix('y') {
        Some(stem) => format!("{count} {stem}ies"),
        None => format!("{count} {noun}s"),
    }
}

fn only_fields(object: &Row, allowed: &[&str], whose: &str) -> Result<(), String> {
    match object.keys().find(|key| !allowed.contains(&key.as_str())) {
        Some(unknown) => Err(format!(
            "{whose} carries an unknown field {unknown}: it takes only {}",
            allowed.join(", ")
        )),
        None => Ok(()),
    }
}

fn row<'a>(value: &'a Value, whose: &str) -> Result<&'a Row, String> {
    value
        .as_object()
        .ok_or_else(|| format!("every entry in {whose} is an object"))
}

fn string<'a>(value: Option<&'a Value>, whose: &str, max: usize) -> Result<&'a str, String> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{whose} is required and is text"))?;
    if text.trim().is_empty() {
        return Err(format!("{whose} is blank, and displayed text must say something"));
    }
    if text.len() > max {
        return Err(format!(
            "{whose} is {} characters, and stops at {max}",
            text.len()
        ));
    }
    Ok(text)
}

fn required_string<'a>(object: &'a Row, key: &str, max: usize) -> Result<&'a str, String> {
    string(object.get(key), key, max)
}

/// Absent is allowed; present-but-null is not, because the reader tells the
/// two apart and a payload that means "no title" leaves the key out.
fn optional_string(object: &Row, key: &str, max: usize) -> Result<(), String> {
    match object.get(key) {
        None => Ok(()),
        Some(value) => string(Some(value), key, max).map(|_| ()),
    }
}

fn one_of(object: &Row, key: &str, allowed: &[&str], required: bool) -> Result<(), String> {
    match object.get(key) {
        None if !required => Ok(()),
        None => Err(format!("{key} is required and is one of {}", allowed.join(", "))),
        Some(value) => match value.as_str() {
            Some(word) if allowed.contains(&word) => Ok(()),
            _ => Err(format!("{key} is one of {}", allowed.join(", "))),
        },
    }
}

fn number(value: Option<&Value>, whose: &str) -> Result<f64, String> {
    value
        .and_then(Value::as_f64)
        .filter(|one| one.is_finite())
        .ok_or_else(|| format!("{whose} is required and is a number"))
}

fn list<'a>(object: &'a Row, key: &str, least: usize, most: usize) -> Result<&'a Vec<Value>, String> {
    let items = object
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{key} is required and is a list"))?;
    if items.len() < least {
        return Err(format!("{key} is empty, and needs at least {least}"));
    }
    if items.len() > most {
        return Err(format!(
            "{key} carries {}, and takes at most {most}",
            many(items.len(), "entry")
        ));
    }
    Ok(items)
}

fn absolute(path: &str) -> bool {
    path.starts_with('/')
        || path
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
            && path.as_bytes().get(1) == Some(&b':')
            && matches!(path.as_bytes().get(2), Some(b'/' | b'\\'))
}

fn media_source(value: Option<&Value>, whose: &str) -> Result<(), String> {
    let source = string(value, whose, 4096)?;
    let scheme = ["http:", "https:", "data:video/", "blob:", "file:"]
        .iter()
        .any(|start| source.starts_with(start));
    if scheme || absolute(source) {
        return Ok(());
    }
    Err(format!(
        "{whose} is {source}: name an absolute path, or a http, https, data:video, blob or file location"
    ))
}

fn stored_image(value: Option<&Value>, whose: &str) -> Result<(), String> {
    if asset_name(value.unwrap_or(&Value::Null), false) {
        return Ok(());
    }
    Err(format!(
        "{whose} must name a stored image, as <64 hex characters> and .png, .jpg, .gif or .webp"
    ))
}

fn fenced<'a>(text: &'a str, language: &str) -> Vec<&'a str> {
    let marker = format!("```{language}");
    let mut rest = text;
    let mut found = Vec::new();
    while let Some(start) = rest.find(&marker) {
        let after = &rest[start + marker.len()..];
        let after = after
            .strip_prefix('\n')
            .or_else(|| after.trim_start_matches([' ', '\t']).strip_prefix('\n'));
        let Some(after) = after else { break };
        let Some(end) = after.find("\n```") else {
            break;
        };
        found.push(&after[..end]);
        rest = &after[end + 4..];
    }
    found
}
pub fn widget_specs(text: &str) -> Vec<Value> {
    fenced(text, "atelier-widget")
        .into_iter()
        .filter_map(|source| serde_json::from_str::<Value>(source).ok())
        .filter(|value| widget_block(value).is_ok())
        .collect()
}

fn picture(cwd: &Path, named: &Value, fallback: &str) -> Option<Value> {
    let root = fs::canonicalize(cwd).ok()?;
    let path = fs::canonicalize(root.join(named["path"].as_str()?)).ok()?;
    let allowed = path.starts_with(&root)
        || path.parent().and_then(Path::parent) == Some(std::env::temp_dir().as_path())
            && path
                .parent()
                .and_then(Path::file_name)
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("atelier-codex-images-"));
    if !allowed {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let mime = match image_kind(&bytes)? {
        ImageKind::Png => "image/png",
        ImageKind::Jpg => "image/jpeg",
        ImageKind::Gif => "image/gif",
        ImageKind::Webp => "image/webp",
    };
    Some(
        serde_json::json!({"mime":mime,"dataUrl":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes)),"alt":named["caption"].as_str().filter(|s|!s.is_empty()).unwrap_or(fallback)}),
    )
}
pub fn comparison_specs(text: &str, cwd: &Path) -> Vec<Value> {
    fenced(text,"atelier-image-compare").into_iter().filter_map(|source|serde_json::from_str::<Value>(source).ok()).filter_map(|spec|{let mode=spec["mode"].as_str().unwrap_or("side_by_side");if !matches!(mode,"side_by_side"|"wipe"){return None}Some(serde_json::json!({"mode":mode,"before":picture(cwd,&spec["before"],"Before")?,"after":picture(cwd,&spec["after"],"After")?}))}).collect()
}

fn option<'a>(args: &'a [String], name: &str) -> Result<Option<&'a str>, String> {
    let mut found = None;
    for pair in args.get(1..).unwrap_or_default().chunks(2) {
        if pair.len() != 2 {
            return Err(format!("missing value for {}", pair[0]));
        }
        if pair[0] == name {
            if found.is_some() {
                return Err(format!("duplicate option: {name}"));
            }
            found = Some(pair[1].as_str());
        }
    }
    Ok(found)
}

fn validate_options(args: &[String], allowed: &[&str]) -> Result<(), String> {
    for pair in args.get(1..).unwrap_or_default().chunks(2) {
        if pair.len() != 2 || pair[1].starts_with("--") {
            return Err(format!("missing value for {}", pair[0]));
        }
        if !allowed.contains(&pair[0].as_str()) {
            return Err(format!("unknown option: {}", pair[0]));
        }
    }
    for name in allowed {
        option(args, name)?;
    }
    Ok(())
}

fn uploaded<'a>(files: &'a BTreeMap<String, Vec<u8>>, name: &str) -> Result<&'a [u8], String> {
    files
        .get(name)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("the presentation command did not upload {name}"))
}

fn image_asset(
    args: &[String],
    file_flag: &str,
    asset_flag: &str,
    files: &BTreeMap<String, Vec<u8>>,
    directory: &Path,
) -> Result<String, String> {
    match (option(args, file_flag)?, option(args, asset_flag)?) {
        (Some(file), None) => import_image(uploaded(files, file)?, file, directory),
        (None, Some(asset)) => existing_image(asset, directory),
        _ => Err(format!(
            "provide exactly one of {file_flag} or {asset_flag}"
        )),
    }
}

/// Render a presentation request using only files explicitly uploaded with the
/// request. This is the native counterpart of the former Node helper boundary.
pub fn present_uploaded(
    args: &[String],
    stdin: &str,
    files: &BTreeMap<String, Vec<u8>>,
    directory: &Path,
) -> Result<String, String> {
    match args.first().map(String::as_str) {
        Some("widget") => {
            validate_options(args, &["--input"])?;
            let source = match option(args, "--input")? {
                Some(file) => std::str::from_utf8(uploaded(files, file)?)
                    .map_err(|_| "widget input is not UTF-8")?,
                None => stdin,
            };
            if source.trim().is_empty() {
                return Err("Widget input is empty. Use stdin or --input.".into());
            }
            let value: Value = serde_json::from_str(source)
                .map_err(|e| format!("widget input is not valid JSON: {e}"))?;
            widget_block(&value)
        }
        Some("image") => {
            validate_options(args, &["--file", "--asset", "--alt", "--caption"])?;
            let asset = image_asset(args, "--file", "--asset", files, directory)?;
            let alt = option(args, "--alt")?.ok_or("--alt is required")?;
            let mut value = serde_json::json!({"type":"image","asset":asset,"alt":alt});
            if let Some(caption) = option(args, "--caption")? {
                value["caption"] = Value::String(caption.into());
            }
            widget_block(&value)
        }
        Some("compare") => {
            validate_options(
                args,
                &[
                    "--before",
                    "--before-asset",
                    "--after",
                    "--after-asset",
                    "--before-alt",
                    "--after-alt",
                    "--mode",
                ],
            )?;
            let before = image_asset(args, "--before", "--before-asset", files, directory)?;
            let after = image_asset(args, "--after", "--after-asset", files, directory)?;
            let before_alt = option(args, "--before-alt")?.ok_or("--before-alt is required")?;
            let after_alt = option(args, "--after-alt")?.ok_or("--after-alt is required")?;
            let mode = option(args, "--mode")?.unwrap_or("side_by_side");
            if !matches!(mode, "side_by_side" | "wipe") {
                return Err("--mode must be side_by_side or wipe".into());
            }
            widget_block(&serde_json::json!({
                "type":"image_compare","mode":mode,
                "before":{"asset":before,"alt":before_alt},
                "after":{"asset":after,"alt":after_alt}
            }))
        }
        Some("artifact") => {
            validate_options(args, &["--file"])?;
            let file = option(args, "--file")?.ok_or("--file is required")?;
            let (asset, title, kind) = import_artifact(uploaded(files, file)?, file, directory)?;
            widget_block(&serde_json::json!({
                "type":"artifact","asset":asset,"title":title,"kind":kind
            }))
        }
        _ => Err("usage: atelier tool present widget|image|compare|artifact".into()),
    }
}

fn asset_name(value: &Value, artifact: bool) -> bool {
    value.as_str().is_some_and(|name| {
        let suffixes = if artifact {
            &[".artifact.json"][..]
        } else {
            &[".png", ".jpg", ".gif", ".webp"][..]
        };
        suffixes.iter().any(|suffix| {
            name.strip_suffix(suffix).is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
        })
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

pub fn png_dimensions(bytes: &[u8]) -> Option<Dimensions> {
    if !bytes.starts_with(PNG_MAGIC) {
        return None;
    }
    let size = Dimensions {
        width: u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
        height: u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
    };
    (size.width > 0 && size.height > 0).then_some(size)
}

#[derive(Clone, Debug, Serialize)]
pub struct PixelAlignment {
    pub basis: &'static str,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PixelComparison {
    pub method: &'static str,
    pub threshold: f64,
    pub aligned: bool,
    pub alignment: PixelAlignment,
    pub changed_pixels: Option<u64>,
    pub total_pixels: Option<u64>,
    pub difference_ratio: Option<f64>,
    #[serde(skip)]
    pub diff: Option<Vec<u8>>,
}

fn rgba(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size().ok_or("PNG is too large")?];
    let output = reader.next_frame(&mut buffer).map_err(|e| e.to_string())?;
    let source = &buffer[..output.buffer_size()];
    let pixels = (output.width as usize) * (output.height as usize);
    let mut out = Vec::with_capacity(pixels * 4);
    match output.color_type {
        png::ColorType::Rgba => out.extend_from_slice(source),
        png::ColorType::Rgb => {
            for px in source.chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for gray in source {
                out.extend_from_slice(&[*gray, *gray, *gray, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for px in source.chunks_exact(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        png::ColorType::Indexed => return Err("indexed PNG was not expanded".into()),
    }
    Ok((output.width, output.height, out))
}

pub fn compare_png(before: &[u8], after: &[u8], threshold: f64) -> PixelComparison {
    let (left, right) = match (rgba(before), rgba(after)) {
        (Ok(left), Ok(right)) => (left, right),
        _ => {
            return PixelComparison {
                method: "pixelmatch",
                threshold,
                aligned: false,
                alignment: PixelAlignment {
                    basis: "equal-pixel-dimensions",
                    width: None,
                    height: None,
                    reason: Some("both inputs must be valid PNG images".into()),
                },
                changed_pixels: None,
                total_pixels: None,
                difference_ratio: None,
                diff: None,
            }
        }
    };
    if (left.0, left.1) != (right.0, right.1) {
        return PixelComparison {
            method: "pixelmatch",
            threshold,
            aligned: false,
            alignment: PixelAlignment {
                basis: "equal-pixel-dimensions",
                width: Some(left.0),
                height: Some(left.1),
                reason: Some(format!(
                    "dimension mismatch: {}x{} versus {}x{}",
                    left.0, left.1, right.0, right.1
                )),
            },
            changed_pixels: None,
            total_pixels: None,
            difference_ratio: None,
            diff: None,
        };
    }
    let mut changed = 0u64;
    let mut diff_pixels = Vec::with_capacity(left.2.len());
    for (a, b) in left.2.chunks_exact(4).zip(right.2.chunks_exact(4)) {
        let delta = ((a[0] as f64 - b[0] as f64).powi(2)
            + (a[1] as f64 - b[1] as f64).powi(2)
            + (a[2] as f64 - b[2] as f64).powi(2))
        .sqrt()
            / (255.0 * 3f64.sqrt());
        if delta > threshold {
            changed += 1;
            diff_pixels.extend_from_slice(&[255, 0, 0, 255]);
        } else {
            let gray = ((a[0] as u16 + a[1] as u16 + a[2] as u16) / 6 + 128) as u8;
            diff_pixels.extend_from_slice(&[gray, gray, gray, 255]);
        }
    }
    let mut diff = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut diff, left.0, left.1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        if let Ok(mut writer) = encoder.write_header() {
            let _ = writer.write_image_data(&diff_pixels);
        }
    }
    let total = (left.0 as u64) * (left.1 as u64);
    PixelComparison {
        method: "pixelmatch",
        threshold,
        aligned: true,
        alignment: PixelAlignment {
            basis: "equal-pixel-dimensions",
            width: Some(left.0),
            height: Some(left.1),
            reason: None,
        },
        changed_pixels: Some(changed),
        total_pixels: Some(total),
        difference_ratio: Some(changed as f64 / total as f64),
        diff: Some(diff),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(colors: &[[u8; 4]]) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, colors.len() as u32, 1);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&colors.concat()).unwrap();
        }
        bytes
    }
    #[test]
    fn native_workbench_services_media_validates_stores_and_compares_pixels() {
        let before = png(&[[255, 0, 0, 255], [0, 0, 0, 255]]);
        let after = png(&[[255, 0, 0, 255], [255, 255, 255, 255]]);
        let root = tempfile::tempdir().unwrap();
        let asset = import_image(&before, "before", root.path()).unwrap();
        assert_eq!(existing_image(&asset, root.path()).unwrap(), asset);
        let comparison = compare_png(&before, &after, 0.1);
        assert!(comparison.aligned);
        assert_eq!(comparison.changed_pixels, Some(1));
        assert_eq!(comparison.difference_ratio, Some(0.5));
        assert_eq!(
            png_dimensions(&before),
            Some(Dimensions {
                width: 2,
                height: 1
            })
        );

        let files = BTreeMap::from([("before.png".into(), before)]);
        let rendered = present_uploaded(
            &[
                "image".into(),
                "--file".into(),
                "before.png".into(),
                "--alt".into(),
                "A red and black image".into(),
            ],
            "",
            &files,
            root.path(),
        )
        .unwrap();
        assert!(rendered.starts_with("```atelier-widget\n"));
        assert!(rendered.contains("A red and black image"));
        assert_eq!(widget_specs(&rendered).len(), 1);
        std::fs::write(root.path().join("before.png"), &files["before.png"]).unwrap();
        std::fs::write(root.path().join("after.png"), &after).unwrap();
        let comparisons=comparison_specs("```atelier-image-compare\n{\"mode\":\"wipe\",\"before\":{\"path\":\"before.png\"},\"after\":{\"path\":\"after.png\"}}\n```",root.path());
        assert_eq!(comparisons.len(), 1);
        assert_eq!(comparisons[0]["mode"], "wipe");
        assert!(comparisons[0]["before"]["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }
}
