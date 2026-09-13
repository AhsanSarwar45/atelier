//! Resident memory owned by this Atelier process and its descendants.

use super::actor::ChatDb;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessesToUpdate, System};

pub const CHAT_ENV: &str = "ATELIER_CHAT_SESSION_ID";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMemory { pub session_id: String, pub title: String, pub bytes: u64, pub processes: usize }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport { pub total_bytes: u64, pub app_bytes: u64, pub processes: usize, pub chats: Vec<ChatMemory> }

fn belongs_to(pid: Pid, root: Pid, parents: &HashMap<Pid, Option<Pid>>) -> bool {
    let mut at = Some(pid);
    let mut seen = HashSet::new();
    while let Some(pid) = at {
        if pid == root { return true; }
        if !seen.insert(pid) { return false; }
        at = parents.get(&pid).copied().flatten();
    }
    false
}

fn chat_id(process: &sysinfo::Process) -> Option<String> {
    process.environ().iter().find_map(|entry| {
        let entry = entry.to_string_lossy();
        entry.strip_prefix(&format!("{CHAT_ENV}=")).filter(|id| !id.is_empty()).map(str::to_owned)
    })
}

pub async fn report(database: &ChatDb) -> Result<MemoryReport, String> {
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let root = Pid::from_u32(std::process::id());
    let parents = system.processes().iter().map(|(pid, process)| (*pid, process.parent())).collect();
    let (mut total, mut app, mut count) = (0u64, 0u64, 0usize);
    let mut grouped: HashMap<String, (u64, usize)> = HashMap::new();
    for (pid, process) in system.processes() {
        if !belongs_to(*pid, root, &parents) { continue; }
        let bytes = process.memory();
        total = total.saturating_add(bytes);
        count += 1;
        if let Some(id) = chat_id(process) {
            let entry = grouped.entry(id).or_default();
            entry.0 = entry.0.saturating_add(bytes);
            entry.1 += 1;
        } else { app = app.saturating_add(bytes); }
    }
    let titles: HashMap<String, String> = database.list_sessions(None).await?
        .into_iter().map(|session| (session.id, session.title.unwrap_or_else(|| "Untitled chat".into()))).collect();
    let mut chats = grouped.into_iter().map(|(session_id, (bytes, processes))| ChatMemory {
        title: titles.get(&session_id).cloned().unwrap_or_else(|| "Active chat".into()), session_id, bytes, processes,
    }).collect::<Vec<_>>();
    chats.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.title.cmp(&b.title)));
    Ok(MemoryReport { total_bytes: total, app_bytes: app, processes: count, chats })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn descendant_walk_stops_at_the_app_and_rejects_another_tree() {
        let root = Pid::from_u32(10);
        let parents = HashMap::from([(root, Some(Pid::from_u32(1))), (Pid::from_u32(11), Some(root)), (Pid::from_u32(12), Some(Pid::from_u32(11))), (Pid::from_u32(20), Some(Pid::from_u32(1)))]);
        assert!(belongs_to(Pid::from_u32(12), root, &parents));
        assert!(!belongs_to(Pid::from_u32(20), root, &parents));
    }
}
