//! What a chat has running, offered when it is closed, and stopping the parts
//! of it a person ticks (bw-fbtyy.1).
//!
//! Closing a chat kills its adapter's process group and nothing else. A
//! program a tool started in a group of its own, or whose shell exited and
//! left it to systemd, outlives the close; so does every container the chat
//! started. Each still carries the chat's id: a process in its environment,
//! a container in its label. That id is what finds them here, wherever in the
//! process tree they now sit.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatProcess {
    pub pid: u32,
    pub parent_pid: Option<u32>,
    pub name: String,
    pub command: String,
    pub bytes: u64,
    pub start_time: u64,
    /// `agent` for the chat's adapter and provider, `subprocess` for the rest.
    pub role: &'static str,
    /// In the adapter's process group, so closing the chat stops it whether
    /// or not it is ticked.
    pub closes_with_chat: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub project: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub processes: Vec<ChatProcess>,
    pub containers: Vec<ChatContainer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picked {
    pub pid: u32,
    pub start_time: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopRequest {
    #[serde(default)]
    pub processes: Vec<Picked>,
    #[serde(default)]
    pub containers: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    pub processes: usize,
    pub containers: usize,
    pub failures: Vec<String>,
}

/// One process carrying the chat's id, before it is placed in the tree.
#[derive(Debug, Clone)]
struct Seen {
    pid: u32,
    parent: Option<u32>,
    group: Option<u32>,
    name: String,
    command: String,
    bytes: u64,
    start_time: u64,
}

/// Name each process's role and whether the close itself reaches it. The
/// adapter is the app's own `-acp` child, as the memory report names it; the
/// provider is the adapter's. A terminal the agent opens is also the app's
/// own child, but it is a tool the close does not reach. The adapter leads
/// its own group, and the close kills that group.
fn placed(seen: Vec<Seen>, app: u32) -> Vec<ChatProcess> {
    let adapters: HashSet<u32> = seen
        .iter()
        .filter(|process| process.parent == Some(app) && process.name.ends_with("-acp"))
        .map(|process| process.pid)
        .collect();
    seen.into_iter()
        .map(|process| {
            let agent = adapters.contains(&process.pid)
                || process.parent.is_some_and(|parent| adapters.contains(&parent));
            ChatProcess {
                closes_with_chat: process.group.is_some_and(|group| adapters.contains(&group)),
                role: if agent { "agent" } else { "subprocess" },
                pid: process.pid,
                parent_pid: process.parent,
                name: process.name,
                command: process.command,
                bytes: process.bytes,
                start_time: process.start_time,
            }
        })
        .collect()
}

/// Deepest first, so a child is signalled before its parent can exit and
/// leave it behind.
fn deepest_first(pids: &mut [u32], parents: &HashMap<u32, Option<u32>>) {
    let depth = |mut pid: u32| {
        let mut depth = 0usize;
        let mut seen = HashSet::new();
        while seen.insert(pid) {
            match parents.get(&pid).copied().flatten() {
                Some(parent) => {
                    depth += 1;
                    pid = parent;
                }
                None => break,
            }
        }
        depth
    };
    pids.sort_by_key(|pid| std::cmp::Reverse(depth(*pid)));
}

#[cfg(target_os = "linux")]
fn processes_of(session_id: &str) -> Vec<ChatProcess> {
    use super::memory::{environ_chat, process_cost, read_stat};
    let app = std::process::id();
    let mut seen = Vec::new();
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<u32>().ok()) else {
            continue;
        };
        if pid == app {
            continue;
        }
        let Some(stat) = read_stat(pid) else { continue };
        if stat.state == 'Z' || environ_chat(pid, stat.started).as_deref() != Some(session_id) {
            continue;
        }
        let command = std::fs::read(format!("/proc/{pid}/cmdline"))
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .split('\0')
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let bytes = process_cost(sysinfo::Pid::from_u32(pid))
            .ok()
            .flatten()
            .map(|cost| cost.total())
            .unwrap_or(0);
        seen.push(Seen {
            pid,
            parent: stat.parent,
            group: stat.group,
            start_time: stat.started_at(),
            name: stat.name,
            command,
            bytes,
        });
    }
    let mut placed = placed(seen, app);
    placed.sort_by_key(|process| process.pid);
    placed
}

#[cfg(not(target_os = "linux"))]
fn processes_of(_session_id: &str) -> Vec<ChatProcess> {
    Vec::new()
}

async fn containers_of(session_id: &str) -> Vec<ChatContainer> {
    super::docker::running()
        .await
        .into_iter()
        .filter(|container| {
            container.labels.get(super::docker::CHAT_LABEL).map(String::as_str) == Some(session_id)
        })
        .map(|container| ChatContainer {
            id: container.id.chars().take(12).collect(),
            project: container.labels.get("com.docker.compose.project").cloned(),
            name: container.name,
            image: container.image,
        })
        .collect()
}

pub async fn running(session_id: &str) -> Result<Running, String> {
    let id = session_id.to_owned();
    let processes = tokio::task::spawn_blocking(move || processes_of(&id))
        .await
        .map_err(|error| format!("process scan failed: {error}"))?;
    Ok(Running {
        processes,
        containers: containers_of(session_id).await,
    })
}

/// Whether the process is still the one that was ticked, and still running.
#[cfg(target_os = "linux")]
fn still_there(pid: u32, start_time: u64) -> bool {
    super::memory::read_stat(pid).is_some_and(|stat| stat.state != 'Z' && stat.started_at() == start_time)
}

/// Stop what was ticked and nothing else. Each process is checked again
/// against a fresh scan: it must still carry the chat's id and the start time
/// it was listed with, so a number the kernel has since handed to another
/// program is left alone. The chat's own agent is never stopped here; closing
/// the chat does that. Each gets SIGTERM, and whatever is still running a few
/// seconds later gets SIGKILL.
pub async fn stop(session_id: &str, request: StopRequest) -> Result<Stopped, String> {
    let mut stopped = Stopped::default();
    let id = session_id.to_owned();
    let processes = request.processes;
    let (count, failures) = tokio::task::spawn_blocking(move || stop_processes(&id, processes))
        .await
        .map_err(|error| format!("stopping processes failed: {error}"))?;
    stopped.processes = count;
    stopped.failures.extend(failures);

    let labelled: HashSet<String> = containers_of(session_id)
        .await
        .into_iter()
        .map(|container| container.id)
        .collect();
    let mut stops = Vec::new();
    for id in request.containers {
        if !labelled.contains(&id) {
            stopped.failures.push(format!("container {id} is not running for this chat"));
            continue;
        }
        stops.push(async move { (super::docker::stop(&id, 5).await, id) });
    }
    for (result, id) in futures::future::join_all(stops).await {
        match result {
            Ok(()) => stopped.containers += 1,
            Err(error) => stopped.failures.push(format!("container {id}: {error}")),
        }
    }
    Ok(stopped)
}

#[cfg(target_os = "linux")]
fn stop_processes(session_id: &str, picked: Vec<Picked>) -> (usize, Vec<String>) {
    let current: HashMap<u32, ChatProcess> = processes_of(session_id)
        .into_iter()
        .map(|process| (process.pid, process))
        .collect();
    let mut failures = Vec::new();
    let mut targets: Vec<u32> = Vec::new();
    for pick in picked {
        match current.get(&pick.pid) {
            Some(process) if process.start_time != pick.start_time => {
                failures.push(format!("process {} has changed since it was listed", pick.pid))
            }
            Some(process) if process.role == "agent" => {
                failures.push(format!("process {} is the chat's agent", pick.pid))
            }
            Some(_) => targets.push(pick.pid),
            // Already gone, perhaps with its parent: nothing to do.
            None => {}
        }
    }
    let parents: HashMap<u32, Option<u32>> =
        current.values().map(|process| (process.pid, process.parent_pid)).collect();
    deepest_first(&mut targets, &parents);
    let start = |pid: &u32| current[pid].start_time;
    for pid in &targets {
        // SAFETY: kill has no memory preconditions; the pid was checked
        // against its start time just above.
        unsafe { libc::kill(*pid as i32, libc::SIGTERM) };
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::time::Instant::now() < deadline && targets.iter().any(|pid| still_there(*pid, start(pid))) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    for pid in &targets {
        if still_there(*pid, start(pid)) {
            // SAFETY: as above, and the start time is checked again first.
            unsafe { libc::kill(*pid as i32, libc::SIGKILL) };
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(200));
    for pid in &targets {
        if still_there(*pid, start(pid)) {
            failures.push(format!("process {pid} did not stop"));
        }
    }
    let count = targets.iter().filter(|pid| !still_there(**pid, start(pid))).count();
    (count, failures)
}

#[cfg(not(target_os = "linux"))]
fn stop_processes(_session_id: &str, picked: Vec<Picked>) -> (usize, Vec<String>) {
    if picked.is_empty() {
        (0, Vec::new())
    } else {
        (0, vec!["stopping processes is not supported on this operating system".into()])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(pid: u32, parent: u32, group: u32) -> Seen {
        Seen {
            pid,
            parent: Some(parent),
            group: Some(group),
            name: format!("p{pid}"),
            command: String::new(),
            bytes: 0,
            start_time: 1,
        }
    }

    #[test]
    fn the_agent_is_named_and_its_group_closes_with_the_chat() {
        // 10 is the app; 20 the adapter, leading group 20; 21 the provider;
        // 22 a tool in the adapter's group; 30 a server that left for its own
        // group, now a child of systemd.
        let mut adapter = seen(20, 10, 20);
        adapter.name = "claude-acp".into();
        // 40 is a terminal the agent opened: the app's own child, in the
        // app's group, and not the agent.
        let placed = placed(
            vec![adapter, seen(21, 20, 20), seen(22, 21, 20), seen(30, 1, 30), seen(40, 10, 10)],
            10,
        );
        let by: HashMap<u32, &ChatProcess> = placed.iter().map(|process| (process.pid, process)).collect();
        assert_eq!(by[&20].role, "agent");
        assert_eq!(by[&21].role, "agent");
        assert_eq!(by[&22].role, "subprocess");
        assert_eq!(by[&30].role, "subprocess");
        assert!(by[&22].closes_with_chat);
        assert!(!by[&30].closes_with_chat);
        assert_eq!(by[&40].role, "subprocess");
        assert!(!by[&40].closes_with_chat);
    }

    #[test]
    fn a_closed_chat_has_no_agent_and_nothing_closes_with_it() {
        let placed = placed(vec![seen(30, 1, 30), seen(31, 30, 30)], 10);
        assert!(placed.iter().all(|process| process.role == "subprocess" && !process.closes_with_chat));
    }

    #[test]
    fn children_are_stopped_before_their_parents() {
        let parents = HashMap::from([(30, Some(1)), (31, Some(30)), (32, Some(31)), (40, Some(1))]);
        let mut pids = vec![30, 40, 32, 31];
        deepest_first(&mut pids, &parents);
        assert_eq!(pids[0], 32);
        assert!(pids.iter().position(|pid| *pid == 31) < pids.iter().position(|pid| *pid == 30));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_a_process_carrying_the_chat_id_is_stopped() {
        // Started through a shell that exits at once, so each sleep is left
        // to the init process, as a real leftover is, and is no child of this
        // test's own process, which the scan would take for the adapter.
        fn detached(id: Option<&str>) -> u32 {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "sleep 30 >/dev/null 2>&1 & echo $!"]);
            if let Some(id) = id {
                command.env(super::super::memory::CHAT_ENV, id);
            }
            let out = command.output().unwrap();
            String::from_utf8(out.stdout).unwrap().trim().parse().unwrap()
        }
        let id = format!("leftover-test-{}", std::process::id());
        let ours = detached(Some(&id));
        let other = detached(None);
        let listed = processes_of(&id);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pid, ours);
        assert_eq!(listed[0].role, "subprocess");
        let other_start = super::super::memory::read_stat(other).unwrap().started_at();
        let picked = vec![
            Picked { pid: ours, start_time: listed[0].start_time },
            Picked { pid: other, start_time: other_start },
        ];
        let (count, failures) = stop_processes(&id, picked);
        assert_eq!(count, 1, "{failures:?}");
        assert!(!still_there(ours, listed[0].start_time));
        assert!(still_there(other, other_start));
        unsafe { libc::kill(other as i32, libc::SIGKILL) };
    }
}
