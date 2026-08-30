//! Native deterministic screen capture primitives without a Node/Playwright runtime.

use super::media::{compare_png, import_image, png_dimensions, Dimensions, PixelComparison};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Bounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NativeWindow {
    pub id: String,
    pub title: String,
    pub owner: String,
    pub bounds: Option<Bounds>,
    pub visible: bool,
    pub minimized: bool,
    pub foreground: bool,
}

fn number(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|n| n as i64))
        .unwrap_or_default()
}

pub fn parse_apple_windows(text: &str) -> Result<Vec<NativeWindow>, String> {
    let rows: Vec<Value> = serde_json::from_str(if text.trim().is_empty() { "[]" } else { text })
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .filter(|row| !row["id"].is_null() && !row["owner"].is_null())
        .map(|row| NativeWindow {
            id: row["id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| row["id"].to_string()),
            title: row["title"].as_str().unwrap_or("").into(),
            owner: row["owner"].as_str().unwrap_or("").into(),
            bounds: row.get("bounds").filter(|v| v.is_object()).map(|b| Bounds {
                x: number(&b["X"]),
                y: number(&b["Y"]),
                width: number(&b["Width"]),
                height: number(&b["Height"]),
            }),
            visible: true,
            minimized: false,
            foreground: row["foreground"] == true,
        })
        .collect())
}

fn window_id(id: &str) -> String {
    let trimmed = id.trim().to_lowercase();
    u64::from_str_radix(trimmed.trim_start_matches("0x"), 16)
        .map(|id| format!("{id:x}"))
        .unwrap_or_else(|_| {
            trimmed
                .trim_start_matches("0x")
                .trim_start_matches('0')
                .into()
        })
}

pub fn parse_linux_windows(
    text: &str,
    foreground: &str,
    hidden: &[String],
) -> Result<Vec<NativeWindow>, String> {
    let foreground = window_id(foreground);
    let hidden: Vec<_> = hidden.iter().map(|id| window_id(id)).collect();
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 8 {
                return Err(format!(
                    "WINDOW_DISCOVERY_UNAVAILABLE: unreadable wmctrl row: {line}"
                ));
            }
            let minimized = hidden.contains(&window_id(fields[0]));
            Ok(NativeWindow {
                id: fields[0].into(),
                title: fields
                    .get(8..)
                    .unwrap_or_default()
                    .join(" ")
                    .if_empty(fields[7]),
                owner: format!("pid {}", fields[2]),
                bounds: Some(Bounds {
                    x: fields[3].parse().unwrap_or_default(),
                    y: fields[4].parse().unwrap_or_default(),
                    width: fields[5].parse().unwrap_or_default(),
                    height: fields[6].parse().unwrap_or_default(),
                }),
                visible: !minimized,
                minimized,
                foreground: window_id(fields[0]) == foreground,
            })
        })
        .collect()
}

trait Empty {
    fn if_empty(self, fallback: &str) -> String;
}
impl Empty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}

pub fn parse_windows_windows(text: &str) -> Result<Vec<NativeWindow>, String> {
    let parsed: Value = serde_json::from_str(if text.trim().is_empty() { "[]" } else { text })
        .map_err(|e| e.to_string())?;
    let rows = parsed.as_array().cloned().unwrap_or_else(|| vec![parsed]);
    Ok(rows
        .into_iter()
        .filter(|row| !row["id"].is_null())
        .map(|row| NativeWindow {
            id: row["id"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| row["id"].to_string()),
            title: row["title"].as_str().unwrap_or("").into(),
            owner: row["owner"].as_str().unwrap_or("").into(),
            bounds: row.get("bounds").filter(|v| v.is_object()).map(|b| Bounds {
                x: number(&b["x"]),
                y: number(&b["y"]),
                width: number(&b["width"]),
                height: number(&b["height"]),
            }),
            visible: row["visible"] == true,
            minimized: row["minimized"] == true,
            foreground: row["foreground"] == true,
        })
        .collect())
}

fn run(program: &str, args: &[&str], label: &str) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{label}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "{label}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn native_windows() -> Result<Vec<NativeWindow>, String> {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none() {
            return Err("WINDOW_CAPTURE_UNAVAILABLE: this Wayland session exposes no safe per-window capture API".into());
        }
        run(
            "xdpyinfo",
            &[],
            "CAPTURE_PERMISSION_REQUIRED: cannot access the X display",
        )?;
        let active = run(
            "xprop",
            &["-root", "_NET_ACTIVE_WINDOW"],
            "WINDOW_DISCOVERY_UNAVAILABLE: install xprop",
        )?;
        let active = active
            .split_whitespace()
            .find(|word| word.starts_with("0x"))
            .unwrap_or("");
        let listing = run(
            "wmctrl",
            &["-lpG"],
            "WINDOW_DISCOVERY_UNAVAILABLE: install wmctrl",
        )?;
        let initial = parse_linux_windows(&listing, active, &[])?;
        let mut hidden = Vec::new();
        let mut inspected = Vec::new();
        for window in initial {
            if let Ok(state) = run("xprop", &["-id", &window.id, "_NET_WM_STATE"], "xprop") {
                inspected.push(window.id.clone());
                if state.contains("_NET_WM_STATE_HIDDEN") {
                    hidden.push(window.id);
                }
            }
        }
        return Ok(parse_linux_windows(&listing, active, &hidden)?
            .into_iter()
            .filter(|window| inspected.contains(&window.id))
            .collect());
    }
    #[cfg(target_os = "macos")]
    {
        const LIST:&str="ObjC.import('CoreGraphics');const a=ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,$.kCGNullWindowID)).filter(w=>w.kCGWindowLayer===0);JSON.stringify(a.map((w,i)=>({id:String(w.kCGWindowNumber),owner:w.kCGWindowOwnerName,title:w.kCGWindowName||'',bounds:w.kCGWindowBounds,foreground:i===0})))";
        return parse_apple_windows(&run(
            "osascript",
            &["-l", "JavaScript", "-e", LIST],
            "WINDOW_DISCOVERY_UNAVAILABLE",
        )?);
    }
    #[cfg(windows)]
    {
        const LIST:&str="$s='[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);[DllImport(\"user32.dll\")]public static extern bool IsIconic(IntPtr h);[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();';Add-Type -MemberDefinition $s -Name W -Namespace A;$f=[A.W]::GetForegroundWindow();Get-Process|Where-Object {$_.MainWindowHandle -ne 0}|ForEach-Object {[pscustomobject]@{id=$_.MainWindowHandle.ToInt64().ToString();title=$_.MainWindowTitle;owner=$_.ProcessName;visible=[A.W]::IsWindowVisible($_.MainWindowHandle);minimized=[A.W]::IsIconic($_.MainWindowHandle);foreground=$_.MainWindowHandle -eq $f}}|ConvertTo-Json -Compress";
        return parse_windows_windows(&run(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", LIST],
            "WINDOW_DISCOVERY_UNAVAILABLE",
        )?);
    }
    #[allow(unreachable_code)]
    Err("WINDOW_CAPTURE_UNAVAILABLE: unsupported platform".into())
}

fn capture_once(id: &str) -> Result<Vec<u8>, String> {
    let root = std::env::temp_dir().join(format!("atelier-window-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    let out = root.join("window.png");
    let result = if cfg!(target_os = "linux") {
        run(
            "import",
            &["-window", id, out.to_str().unwrap()],
            "CAPTURE_PERMISSION_REQUIRED: install ImageMagick and grant window capture",
        )
    } else if cfg!(target_os = "macos") {
        run(
            "screencapture",
            &["-x", "-l", id, out.to_str().unwrap()],
            "CAPTURE_PERMISSION_REQUIRED",
        )
    } else if cfg!(windows) {
        const CAPTURE: &str = "$id=[IntPtr]::new([long]$args[0]);$out=$args[1];Add-Type -AssemblyName System.Drawing;$s='[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport(\"user32.dll\")]public static extern bool PrintWindow(IntPtr h,IntPtr d,uint f);public struct R{public int L;public int T;public int Rg;public int B;}';Add-Type -MemberDefinition $s -Name C -Namespace A;$r=New-Object A.C+R;if(![A.C]::GetWindowRect($id,[ref]$r)){exit 3};$w=$r.Rg-$r.L;$h=$r.B-$r.T;if($w -lt 1 -or $h -lt 1){exit 3};$b=New-Object Drawing.Bitmap $w,$h;$g=[Drawing.Graphics]::FromImage($b);$dc=$g.GetHdc();$ok=[A.C]::PrintWindow($id,$dc,2);$g.ReleaseHdc($dc);if(!$ok){$g.Dispose();$b.Dispose();exit 3};$b.Save($out,[Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$b.Dispose()";
        run(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                CAPTURE,
                id,
                out.to_str().unwrap(),
            ],
            "CAPTURE_PERMISSION_REQUIRED",
        )
    } else {
        Err("WINDOW_CAPTURE_UNAVAILABLE: capture is not available on this platform build".into())
    };
    let bytes = result.and_then(|_| std::fs::read(&out).map_err(|e| e.to_string()));
    let _ = std::fs::remove_dir_all(root);
    let bytes = bytes?;
    if png_dimensions(&bytes).is_none() {
        return Err("CAPTURE_PERMISSION_REQUIRED: capture did not produce a PNG".into());
    }
    Ok(bytes)
}

pub trait WindowSource: Send {
    fn list(&mut self) -> Result<Vec<NativeWindow>, String>;
    fn capture(&mut self, id: &str) -> Result<Vec<u8>, String>;
    fn name(&self) -> &str;
}
pub struct NativeWindowSource;
impl WindowSource for NativeWindowSource {
    fn list(&mut self) -> Result<Vec<NativeWindow>, String> {
        native_windows()
    }
    fn capture(&mut self, id: &str) -> Result<Vec<u8>, String> {
        capture_once(id)
    }
    fn name(&self) -> &str {
        "native-window"
    }
}

pub async fn stable_window_capture(
    source: &mut dyn WindowSource,
    id: &str,
    interval: Duration,
    retries: u8,
) -> Result<(Vec<u8>, NativeWindow, Vec<String>), String> {
    if !(2..=20).contains(&retries) || !(50..=5000).contains(&(interval.as_millis() as u64)) {
        return Err("window stability settings are out of range".into());
    }
    let window = source
        .list()?
        .into_iter()
        .find(|window| window.id == id)
        .ok_or("WINDOW_NOT_FOUND: list windows again and use one exact current ID")?;
    if !window.visible || window.minimized {
        return Err("WINDOW_NOT_CAPTURABLE: the selected window is hidden or minimized".into());
    }
    if !window.foreground {
        return Err("WINDOW_OCCLUDED: bring the selected window fully to the foreground, then list windows again".into());
    }
    let mut previous = None;
    for attempt in 1..=retries {
        let bytes = source.capture(id)?;
        let hash = Sha256::digest(&bytes);
        if previous.as_ref() == Some(&hash) {
            return Ok((
                bytes,
                window,
                vec![
                    format!("adapter={}", source.name()),
                    format!("window={id}"),
                    "stable-frames=2".into(),
                    format!("attempts={attempt}"),
                ],
            ));
        }
        previous = Some(hash);
        tokio::time::sleep(interval).await;
    }
    Err(format!(
        "WINDOW_UNSTABLE: {retries} captures did not produce two matching frames"
    ))
}

#[derive(Clone, Debug, Serialize)]
pub struct StoredCapture {
    pub asset: String,
    pub label: String,
    pub evidence: Value,
}
pub fn store_static(
    bytes: &[u8],
    label: &str,
    source: &str,
    media: &Path,
) -> Result<StoredCapture, String> {
    let dimensions: Option<Dimensions> = png_dimensions(bytes);
    let asset = import_image(bytes, label, media)?;
    Ok(StoredCapture {
        asset,
        label: label.into(),
        evidence: json!({"source":source,"dimensions":dimensions,"visible_text":{"source":"vision-required","text":""},"accessibility":Value::Null}),
    })
}

#[derive(Debug)]
pub struct StoredComparison {
    pub before: StoredCapture,
    pub after: StoredCapture,
    pub objective: PixelComparison,
    pub diff_asset: Option<String>,
}
pub fn compare_and_store(
    before: &[u8],
    after: &[u8],
    media: &Path,
) -> Result<StoredComparison, String> {
    let before = store_static(before, "Before", "image", media)?;
    let after_stored = store_static(after, "After", "image", media)?;
    let objective = compare_png(
        &std::fs::read(media.join(&before.asset)).map_err(|e| e.to_string())?,
        after,
        0.1,
    );
    let diff_asset = objective
        .diff
        .as_deref()
        .map(|diff| import_image(diff, "Objective pixel difference", media))
        .transpose()?;
    Ok(StoredComparison {
        before,
        after: after_stored,
        objective,
        diff_asset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        frames: Vec<Vec<u8>>,
    }
    impl WindowSource for Fake {
        fn list(&mut self) -> Result<Vec<NativeWindow>, String> {
            Ok(vec![NativeWindow {
                id: "42".into(),
                title: "App".into(),
                owner: "test".into(),
                bounds: None,
                visible: true,
                minimized: false,
                foreground: true,
            }])
        }
        fn capture(&mut self, _: &str) -> Result<Vec<u8>, String> {
            Ok(self.frames.remove(0))
        }
        fn name(&self) -> &str {
            "fake"
        }
    }
    #[tokio::test]
    async fn native_workbench_services_media_parses_and_stabilises_explicit_windows() {
        let rows = parse_linux_windows("0x2 0 77 1 2 300 200 host A Window", "0x2", &[]).unwrap();
        assert!(rows[0].foreground);
        assert_eq!(rows[0].title, "A Window");
        let mut fake = Fake {
            frames: vec![b"a".to_vec(), b"b".to_vec(), b"b".to_vec()],
        };
        let (_, _, diagnostics) =
            stable_window_capture(&mut fake, "42", Duration::from_millis(50), 5)
                .await
                .unwrap();
        assert!(diagnostics.contains(&"attempts=3".into()));
    }
}
