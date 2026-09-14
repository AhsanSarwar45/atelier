//! Proportional memory owned by this Atelier process and its descendants.

use super::actor::ChatDb;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessesToUpdate, System};

pub const CHAT_ENV: &str = "ATELIER_CHAT_SESSION_ID";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMemory {
    pub session_id: String,
    pub title: String,
    pub bytes: u64,
    pub processes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemory {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub bytes: u64,
    pub session_id: Option<String>,
    pub chat_title: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub total_bytes: u64,
    pub metric: &'static str,
    pub process_count: usize,
    pub chats: Vec<ChatMemory>,
    pub process_details: Vec<ProcessMemory>,
}

fn belongs_to(pid: Pid, root: Pid, parents: &HashMap<Pid, Option<Pid>>) -> bool {
    let mut at = Some(pid);
    let mut seen = HashSet::new();
    while let Some(pid) = at {
        if pid == root {
            return true;
        }
        if !seen.insert(pid) {
            return false;
        }
        at = parents.get(&pid).copied().flatten();
    }
    false
}

fn chat_id(process: &sysinfo::Process) -> Option<String> {
    process.environ().iter().find_map(|entry| {
        let entry = entry.to_string_lossy();
        entry
            .strip_prefix(&format!("{CHAT_ENV}="))
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
    })
}

#[cfg(target_os = "linux")]
fn parse_pss(contents: &str) -> Option<u64> {
    contents.lines().find_map(|line| {
        let value = line
            .strip_prefix("Pss:")?
            .trim()
            .strip_suffix(" kB")?
            .trim();
        value.parse::<u64>().ok()?.checked_mul(1024)
    })
}

#[cfg(target_os = "linux")]
fn process_bytes(pid: Pid, _resident_bytes: u64) -> Result<Option<u64>, String> {
    let status_path = format!("/proc/{}/status", pid.as_u32());
    let status = match std::fs::read_to_string(&status_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read {status_path}: {error}")),
    };
    let thread_group = status
        .lines()
        .find_map(|line| line.strip_prefix("Tgid:")?.trim().parse::<u32>().ok())
        .ok_or_else(|| format!("missing Tgid in {status_path}"))?;
    if thread_group != pid.as_u32() {
        return Ok(None);
    }

    let path = format!("/proc/{}/smaps_rollup", pid.as_u32());
    match std::fs::read_to_string(&path) {
        Ok(contents) => parse_pss(&contents)
            .map(Some)
            .ok_or_else(|| format!("missing Pss in {path}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not read {path}: {error}")),
    }
}

#[cfg(not(target_os = "linux"))]
fn process_bytes(_pid: Pid, _resident_bytes: u64) -> Result<Option<u64>, String> {
    Err("proportional process memory is not available on this operating system".into())
}

const MEMORY_METRIC: &str = "pss";

pub async fn report(database: &ChatDb) -> Result<MemoryReport, String> {
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let root = Pid::from_u32(std::process::id());
    let parents = system
        .processes()
        .iter()
        .map(|(pid, process)| (*pid, process.parent()))
        .collect();
    let inherited_chat_id = system.process(root).and_then(chat_id);
    let mut total = 0u64;
    let mut grouped: HashMap<String, (u64, usize)> = HashMap::new();
    let mut details = Vec::new();
    let titles: HashMap<String, String> = database
        .list_sessions(None)
        .await?
        .into_iter()
        .map(|session| {
            (
                session.id,
                session.title.unwrap_or_else(|| "Untitled chat".into()),
            )
        })
        .collect();
    for (pid, process) in system.processes() {
        if !belongs_to(*pid, root, &parents) {
            continue;
        }
        let Some(bytes) = process_bytes(*pid, process.memory())? else {
            continue;
        };
        total = total.saturating_add(bytes);
        let session_id = chat_id(process).filter(|id| Some(id) != inherited_chat_id.as_ref());
        if let Some(id) = session_id.as_ref() {
            let entry = grouped.entry(id.clone()).or_default();
            entry.0 = entry.0.saturating_add(bytes);
            entry.1 += 1;
        }
        details.push(ProcessMemory {
            pid: pid.as_u32(),
            parent_pid: process.parent().map(Pid::as_u32),
            name: process.name().to_string_lossy().into_owned(),
            bytes,
            chat_title: session_id.as_ref().and_then(|id| titles.get(id)).cloned(),
            session_id,
        });
    }
    let mut chats = grouped
        .into_iter()
        .map(|(session_id, (bytes, processes))| ChatMemory {
            title: titles
                .get(&session_id)
                .cloned()
                .unwrap_or_else(|| "Active chat".into()),
            session_id,
            bytes,
            processes,
        })
        .collect::<Vec<_>>();
    chats.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.title.cmp(&b.title)));
    details.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.pid.cmp(&b.pid)));
    Ok(MemoryReport {
        total_bytes: total,
        metric: MEMORY_METRIC,
        process_count: details.len(),
        chats,
        process_details: details,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descendant_walk_stops_at_the_app_and_rejects_another_tree() {
        let root = Pid::from_u32(10);
        let parents = HashMap::from([
            (root, Some(Pid::from_u32(1))),
            (Pid::from_u32(11), Some(root)),
            (Pid::from_u32(12), Some(Pid::from_u32(11))),
            (Pid::from_u32(20), Some(Pid::from_u32(1))),
        ]);
        assert!(belongs_to(Pid::from_u32(12), root, &parents));
        assert!(!belongs_to(Pid::from_u32(20), root, &parents));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_pss_without_confusing_it_with_pss_anon() {
        let sample = "Rss:               12000 kB\nPss:                4321 kB\nPss_Anon:           4000 kB\n";
        assert_eq!(parse_pss(sample), Some(4_424_704));
    }
}
