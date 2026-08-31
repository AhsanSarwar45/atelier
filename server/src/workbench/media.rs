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

pub fn widget_block(value: &Value) -> Result<String, String> {
    let kind = value["type"]
        .as_str()
        .ok_or("Widget contract mismatch or unknown fields")?;
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
        _ => return Err("Widget contract mismatch or unknown fields".into()),
    };
    let object = value
        .as_object()
        .ok_or("Widget contract mismatch or unknown fields")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Widget contract mismatch or unknown fields".into());
    }
    let valid = match kind {
        "image" => asset_name(&value["asset"], false) && valid_text(&value["alt"], 200),
        "image_compare" => {
            matches!(value["mode"].as_str(), Some("side_by_side" | "wipe"))
                && asset_name(&value["before"]["asset"], false)
                && valid_text(&value["before"]["alt"], 200)
                && asset_name(&value["after"]["asset"], false)
                && valid_text(&value["after"]["alt"], 200)
        }
        "artifact" => {
            asset_name(&value["asset"], true)
                && matches!(
                    value["kind"].as_str(),
                    Some("mermaid" | "flow" | "scene" | "mockup")
                )
        }
        "metrics" | "progress" | "timeline" => value["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty()),
        "chart" => {
            value["series"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
                && value["data"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
        }
        "table" => {
            value["columns"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
                && value["rows"].is_array()
        }
        "video" => valid_text(&value["src"], 4096),
        "explainer" => {
            value["nodes"]
                .as_array()
                .is_some_and(|items| items.len() >= 2)
                && value["edges"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                && value["steps"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
        }
        _ => false,
    };
    if !valid {
        return Err("Widget contract mismatch or unknown fields".into());
    }
    Ok(format!(
        "```atelier-widget\n{}\n```\n",
        serde_json::to_string(&ordered(value)).unwrap()
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
