//! How much of the disk the app takes, and what takes it.
//!
//! Measured by walking the app's own folders, the way `du` would, and
//! answered as parts with plain ids; the screen names them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::Serialize;

use super::cleanup::Chat;
use super::storage_index::{Indexed, Progress};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub id: &'static str,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub free: u64,
    pub total: u64,
}

/// Chats last used within one span of time.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgeGroup {
    pub id: &'static str,
    pub chats: usize,
    /// The chats' own records in the chat database.
    pub bytes: u64,
    /// Pictures and files the chats show.
    pub media: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub total: u64,
    pub parts: Vec<Part>,
    pub disk: Option<Disk>,
    /// Space inside the chat database that deleted chats left behind.
    pub unused_chat_bytes: Option<u64>,
    pub chats: usize,
    pub ages: Vec<AgeGroup>,
    pub index: Progress,
}

/// Size of a file or everything under a folder, never following a link.
pub fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|entry| size_of(&entry.path())).sum())
        .unwrap_or(0)
}

/// Which part a top-level name in the data folder belongs to.
fn part_of(name: &str) -> &'static str {
    match name {
        n if n.starts_with("workbench.db") => "chats",
        n if n.starts_with("search.db") => "search",
        "presentation-media" => "media",
        "library-snapshots" | "skill-bundles" => "skills",
        "migration-backups" => "backups",
        _ => "other",
    }
}

const ORDER: [&str; 9] = ["chats", "media", "claude", "codex", "search", "skills", "browser", "backups", "other"];

/// Measure the data folder, the shared media folder when it lives elsewhere,
/// and the browser profiles the app keeps.
pub fn measure(data: &Path, media: Option<&Path>, browser: Option<&Path>) -> (u64, Vec<Part>) {
    let mut sizes: HashMap<&'static str, u64> = HashMap::new();
    let media_inside = media.map_or(false, |media| media.parent() == Some(data));
    for entry in std::fs::read_dir(data).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "profiles" {
            for brand in std::fs::read_dir(entry.path()).into_iter().flatten().flatten() {
                let part = match brand.file_name().to_string_lossy().as_ref() {
                    "claude" => "claude",
                    "codex" => "codex",
                    _ => "other",
                };
                *sizes.entry(part).or_default() += size_of(&brand.path());
            }
            continue;
        }
        if name == "presentation-media" && !media_inside {
            // A copy of the app pointed at its own media folder: this one is
            // not what it shows.
            *sizes.entry("other").or_default() += size_of(&entry.path());
            continue;
        }
        *sizes.entry(part_of(&name)).or_default() += size_of(&entry.path());
    }
    if let Some(media) = media.filter(|_| !media_inside) {
        *sizes.entry("media").or_default() += size_of(media);
    }
    if let Some(browser) = browser {
        *sizes.entry("browser").or_default() += size_of(browser);
    }
    let parts: Vec<Part> = ORDER
        .iter()
        .map(|id| Part {
            id,
            bytes: sizes.get(id).copied().unwrap_or(0),
        })
        .collect();
    (parts.iter().map(|p| p.bytes).sum(), parts)
}

/// The browser profiles the app keeps, one per checkout (`chrome.rs`).
pub fn browser_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|h| PathBuf::from(h).join(".local/state")))
        .map(|state| state.join("atelier/chrome"))
}

pub fn disk(path: &Path) -> Option<Disk> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is a valid NUL-terminated path and `stat` is ours to fill.
    if unsafe { libc::statvfs(name.as_ptr(), &mut stat) } != 0 {
        return None;
    }
    let block = stat.f_frsize as u64;
    Some(Disk {
        free: stat.f_bavail as u64 * block,
        total: stat.f_blocks as u64 * block,
    })
}

const AGES: [(&str, i64); 6] = [
    ("week", 7),
    ("month", 30),
    ("quarter", 90),
    ("half", 180),
    ("year", 365),
    ("older", i64::MAX),
];

/// Chats grouped by how long ago they were last used, with what each group
/// holds.
pub fn ages(chats: &[Chat], indexed: &Indexed, sizes: &HashMap<String, u64>) -> Vec<AgeGroup> {
    let now = Utc::now();
    let mut groups: Vec<AgeGroup> = AGES
        .iter()
        .map(|(id, _)| AgeGroup {
            id,
            ..AgeGroup::default()
        })
        .collect();
    let mut group_of: HashMap<&str, usize> = HashMap::new();
    for chat in chats {
        let days = (now - chat.last_at).num_days();
        let at = AGES.iter().position(|(_, most)| days < *most).unwrap_or(AGES.len() - 1);
        groups[at].chats += 1;
        groups[at].bytes += indexed.chats.get(&chat.id).map_or(0, |(bytes, _)| (*bytes).max(0) as u64);
        group_of.insert(chat.id.as_str(), at);
    }
    // Each file once, in the newest group that shows it: it stays on disk as
    // long as that chat does.
    let mut newest: HashMap<&str, usize> = HashMap::new();
    for r in &indexed.refs {
        let Some(at) = group_of.get(r.session_id.as_str()) else {
            continue;
        };
        let cleared = indexed
            .cleared
            .get(&(r.session_id.clone(), super::storage_index::Kind::of(&r.asset)))
            .map_or(false, |through| r.last_seq <= *through);
        if cleared {
            continue;
        }
        let slot = newest.entry(r.asset.as_str()).or_insert(*at);
        *slot = (*slot).min(*at);
    }
    for (asset, at) in newest {
        groups[at].media += sizes.get(asset).copied().unwrap_or(0);
    }
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_folder_is_split_into_named_parts() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(data.join("profiles/claude/a")).unwrap();
        std::fs::create_dir_all(data.join("profiles/codex")).unwrap();
        std::fs::create_dir_all(data.join("presentation-media")).unwrap();
        std::fs::write(data.join("workbench.db"), [0; 100]).unwrap();
        std::fs::write(data.join("workbench.db-wal"), [0; 10]).unwrap();
        std::fs::write(data.join("profiles/claude/a/x.jsonl"), [0; 30]).unwrap();
        std::fs::write(data.join("profiles/codex/y"), [0; 7]).unwrap();
        std::fs::write(data.join("presentation-media/p.png"), [0; 5]).unwrap();
        std::fs::write(data.join("settings.db"), [0; 3]).unwrap();
        let media = data.join("presentation-media");
        let (total, parts) = measure(&data, Some(&media), None);
        let of = |id| parts.iter().find(|p| p.id == id).unwrap().bytes;
        assert_eq!((of("chats"), of("claude"), of("codex"), of("media"), of("other")), (110, 30, 7, 5, 3));
        assert_eq!(total, 155);
    }
}
