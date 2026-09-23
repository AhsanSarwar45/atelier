//! Proportional memory owned by this Atelier process and its descendants.

use super::actor::ChatDb;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

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
    /// The part of `bytes` that is paged out rather than in RAM.
    pub swap_bytes: u64,
    pub session_id: Option<String>,
    pub chat_title: Option<String>,
    pub role: &'static str,
    pub killable: bool,
    pub start_time: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReport {
    pub total_bytes: u64,
    /// The part of `total_bytes` that is paged out rather than in RAM.
    pub swap_bytes: u64,
    pub metric: &'static str,
    pub process_count: usize,
    pub chats: Vec<ChatMemory>,
    pub process_details: Vec<ProcessMemory>,
    /// What the kernel charges the app's own control group, when it has one.
    pub service: Option<ServiceMemory>,
}

/// The kernel's own account of the app's control group. The proportional
/// total above leaves out the file cache the group has read in and the
/// kernel memory it holds, so a monitor reading the group saw three times the
/// badge's number and nothing on the badge said why. The kernel's
/// out-of-memory killer acts on the group's pressure, not on either total,
/// so that is shown as well (bw-ifjt.3).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceMemory {
    /// Everything charged to the group, in RAM and in swap.
    pub total_bytes: u64,
    /// The part of `total_bytes` that is file cache the kernel can drop.
    pub cache_bytes: u64,
    /// Share of the last ten seconds every process in the group spent
    /// stalled waiting for memory, in percent. `systemd-oomd` kills on this.
    pub pressure: f64,
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

/// One `smaps_rollup` field, in bytes. The name must carry its colon, so that
/// `Pss:` does not also answer for `Pss_Anon:` nor `Swap:` for `SwapPss:`.
#[cfg(target_os = "linux")]
fn parse_field(contents: &str, name: &str) -> Option<u64> {
    contents.lines().find_map(|line| {
        let value = line.strip_prefix(name)?.trim().strip_suffix(" kB")?.trim();
        value.parse::<u64>().ok()?.checked_mul(1024)
    })
}

#[cfg(target_os = "linux")]
fn process_leader(pid: Pid) -> Result<Option<bool>, String> {
    let status_path = format!("/proc/{}/status", pid.as_u32());
    let status = match std::fs::read_to_string(&status_path) {
        Ok(contents) => contents,
        Err(error) if process_vanished(&error) => return Ok(None),
        Err(error) => return Err(format!("could not read {status_path}: {error}")),
    };
    let thread_group = status
        .lines()
        .find_map(|line| line.strip_prefix("Tgid:")?.trim().parse::<u32>().ok())
        .ok_or_else(|| format!("missing Tgid in {status_path}"))?;
    Ok(Some(thread_group == pid.as_u32()))
}

#[cfg(target_os = "linux")]
fn process_vanished(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(target_os = "linux"))]
fn process_leader(_pid: Pid) -> Result<Option<bool>, String> {
    Ok(Some(true))
}

/// What one process costs the machine: its share of the pages held in RAM, and
/// its share of the pages the kernel has pushed out to swap. Counting only the
/// first halved the badge's own number on a machine under memory pressure —
/// every process had tens of megabytes paged out that nobody was charged for,
/// and the app looked half its real size (bw-c4i2.1).
#[derive(Debug, Clone, Copy, Default)]
struct ProcessCost {
    resident: u64,
    swapped: u64,
}

impl ProcessCost {
    fn total(self) -> u64 {
        self.resident.saturating_add(self.swapped)
    }
}

#[cfg(target_os = "linux")]
fn process_cost(pid: Pid) -> Result<Option<ProcessCost>, String> {
    if process_leader(pid)? != Some(true) {
        return Ok(None);
    }

    let path = format!("/proc/{}/smaps_rollup", pid.as_u32());
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(ProcessCost {
            resident: parse_field(&contents, "Pss:")
                .ok_or_else(|| format!("missing Pss in {path}"))?,
            // A kernel built without swap, or a process with nothing paged out,
            // leaves this line out. Absent means none, not unreadable.
            swapped: parse_field(&contents, "SwapPss:").unwrap_or(0),
        })),
        Err(error) if process_vanished(&error) => Ok(None),
        Err(error) => Err(format!("could not read {path}: {error}")),
    }
}

#[cfg(not(target_os = "linux"))]
fn process_cost(_pid: Pid) -> Result<Option<ProcessCost>, String> {
    Err("proportional process memory is not available on this operating system".into())
}

/// The group this process runs in, from `/proc/self/cgroup` on a unified
/// hierarchy. The root group has no memory account of its own.
fn cgroup_path(contents: &str) -> Option<&str> {
    contents
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .map(str::trim)
        .filter(|path| !path.is_empty() && *path != "/")
}

/// One `memory.stat` counter, in bytes.
fn stat_field(stat: &str, name: &str) -> Option<u64> {
    stat.lines().find_map(|line| {
        let (key, value) = line.split_once(' ')?;
        (key == name).then(|| value.trim().parse().ok()).flatten()
    })
}

/// The `full avg10` figure of a pressure file: the share of time every
/// process in the group was stalled at once. `systemd-oomd` compares this
/// one against its limit, not the `some` line.
fn full_pressure(pressure: &str) -> Option<f64> {
    pressure
        .lines()
        .find_map(|line| line.strip_prefix("full "))?
        .split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse()
        .ok()
}

/// The group's own account, but only when the group is this app's alone: in a
/// terminal or a desktop session scope it would count unrelated programs.
#[cfg(target_os = "linux")]
fn service_memory(ours: &[Found]) -> Option<ServiceMemory> {
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let group = std::path::Path::new("/sys/fs/cgroup").join(cgroup_path(&own)?.trim_start_matches('/'));
    let read = |name: &str| std::fs::read_to_string(group.join(name)).ok();
    let pids: HashSet<u32> = ours.iter().map(|found| found.pid.as_u32()).collect();
    let members = read("cgroup.procs")?;
    let mut members = members.lines().filter_map(|line| line.trim().parse::<u32>().ok()).peekable();
    members.peek()?;
    if !members.all(|pid| pids.contains(&pid)) {
        return None;
    }
    let current: u64 = read("memory.current")?.trim().parse().ok()?;
    let swapped: u64 = read("memory.swap.current")
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0);
    let stat = read("memory.stat")?;
    let cache = stat_field(&stat, "file")?.saturating_sub(stat_field(&stat, "shmem").unwrap_or(0));
    Some(ServiceMemory {
        total_bytes: current.saturating_add(swapped),
        cache_bytes: cache,
        pressure: read("memory.pressure").as_deref().and_then(full_pressure).unwrap_or(0.0),
    })
}

#[cfg(not(target_os = "linux"))]
fn service_memory(_ours: &[Found]) -> Option<ServiceMemory> {
    None
}

/// Proportional set size, resident and swapped together. The name says both
/// halves because a reader who saw "pss" would reasonably expect a number that
/// ignores swap, which is the bug this replaced (bw-c4i2.2).
const MEMORY_METRIC: &str = "pssWithSwap";

/// One of this app's own processes, with what the report shows of it.
struct Found {
    pid: Pid,
    parent: Option<Pid>,
    name: String,
    chat: Option<String>,
    start_time: u64,
}

fn effective_chat(
    pid: Pid,
    processes: &HashMap<Pid, &Found>,
    ignored: Option<&String>,
) -> Option<String> {
    let mut at = Some(pid);
    let mut seen = HashSet::new();
    while let Some(pid) = at {
        if !seen.insert(pid) {
            return None;
        }
        let process = processes.get(&pid)?;
        if let Some(chat) = process.chat.as_ref().filter(|chat| Some(*chat) != ignored) {
            return Some(chat.clone());
        }
        at = process.parent;
    }
    None
}

fn role_of(
    found: &Found,
    root: Pid,
    processes: &HashMap<Pid, &Found>,
    chat: Option<&str>,
) -> &'static str {
    if found.pid == root {
        return "app";
    }
    if chat.is_none() {
        return if found.parent == Some(root) && matches!(found.name.as_str(), "claude" | "codex") {
            "accountReader"
        } else {
            "appService"
        };
    }
    if found.parent == Some(root) && found.name.ends_with("-acp") {
        return "chatAdapter";
    }
    if found
        .parent
        .and_then(|pid| processes.get(&pid))
        .is_some_and(|parent| parent.parent == Some(root) && parent.name.ends_with("-acp"))
        && matches!(found.name.as_str(), "claude" | "codex" | "goose")
    {
        return "provider";
    }
    "subprocess"
}

fn scan() -> Vec<Found> {
    static KEPT: std::sync::OnceLock<std::sync::Mutex<System>> = std::sync::OnceLock::new();
    let kept = KEPT.get_or_init(|| std::sync::Mutex::new(System::new()));
    let mut system = kept.lock().unwrap_or_else(|e| e.into_inner());
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let root = Pid::from_u32(std::process::id());
    let parents: HashMap<Pid, Option<Pid>> = system
        .processes()
        .iter()
        .map(|(pid, process)| (*pid, process.parent()))
        .collect();
    let pids: Vec<Pid> = parents
        .keys()
        .copied()
        .filter(|pid| belongs_to(*pid, root, &parents))
        .collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&pids),
        false,
        ProcessRefreshKind::nothing().with_environ(UpdateKind::OnlyIfNotSet),
    );
    pids.into_iter()
        .filter(|pid| process_leader(*pid).ok().flatten() == Some(true))
        .filter_map(|pid| {
            let process = system.process(pid)?;
            Some(Found {
                pid,
                parent: process.parent(),
                name: process.name().to_string_lossy().into_owned(),
                chat: chat_id(process),
                start_time: process.start_time(),
            })
        })
        .collect()
}

pub async fn report(database: &ChatDb) -> Result<MemoryReport, String> {
    // Only what the report reads, and only from whom it reads it. Every process
    // on the machine is asked for its parent, which is one short file each;
    // only this app's own descendants are asked for their environment, which
    // is long and was the costliest read of a badge asked every few seconds.
    // The table is kept between reports, so a process already known is not
    // built again, and it is file reading, so it runs off the request threads
    // (bw-fbzd.5).
    let (ours, service) = tokio::task::spawn_blocking(|| {
        let ours = scan();
        let service = service_memory(&ours);
        (ours, service)
    })
    .await
        .map_err(|e| format!("process scan failed: {e}"))?;
    let root = Pid::from_u32(std::process::id());
    let inherited_chat_id = ours
        .iter()
        .find(|found| found.pid == root)
        .and_then(|found| found.chat.clone());
    let process_map: HashMap<Pid, &Found> = ours.iter().map(|found| (found.pid, found)).collect();
    let mut total = 0u64;
    let mut swapped_total = 0u64;
    let mut grouped: HashMap<String, (u64, usize)> = HashMap::new();
    let mut details = Vec::new();
    // Titles are wanted only for the chats found running, and most reports find
    // none; reading every chat ever held to name them was the costliest part.
    let running_chats: HashSet<String> = ours
        .iter()
        .filter_map(|found| effective_chat(found.pid, &process_map, inherited_chat_id.as_ref()))
        .collect();
    let titles: HashMap<String, String> = if running_chats.is_empty() {
        HashMap::new()
    } else {
        database
            .list_sessions(None)
            .await?
            .into_iter()
            .filter(|session| running_chats.contains(&session.id))
            .map(|session| {
                // The one naming rule, so a chat is called the same thing here
                // as on the rail and in the tray (chat_name, bw-altj.7).
                let name = crate::workbench::chat_name::name_session(&session);
                (session.id, name)
            })
            .collect()
    };
    for found in &ours {
        let Some(cost) = process_cost(found.pid)? else {
            continue;
        };
        let bytes = cost.total();
        total = total.saturating_add(bytes);
        swapped_total = swapped_total.saturating_add(cost.swapped);
        let session_id = effective_chat(found.pid, &process_map, inherited_chat_id.as_ref());
        let role = role_of(&found, root, &process_map, session_id.as_deref());
        if let Some(id) = session_id.as_ref() {
            let entry = grouped.entry(id.clone()).or_default();
            entry.0 = entry.0.saturating_add(bytes);
            entry.1 += 1;
        }
        details.push(ProcessMemory {
            pid: found.pid.as_u32(),
            parent_pid: found.parent.map(Pid::as_u32),
            name: found.name.clone(),
            bytes,
            swap_bytes: cost.swapped,
            chat_title: session_id.as_ref().and_then(|id| titles.get(id)).cloned(),
            session_id,
            role,
            killable: role == "subprocess",
            start_time: found.start_time,
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
        swap_bytes: swapped_total,
        metric: MEMORY_METRIC,
        process_count: details.len(),
        chats,
        process_details: details,
        service,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateRequest {
    pub pid: u32,
    pub start_time: u64,
    pub session_id: String,
}

/// Stop one chat-owned subprocess tree without stopping its provider or adapter.
pub fn terminate(request: TerminateRequest) -> Result<usize, String> {
    #[cfg(not(unix))]
    return Err("subprocess termination is not supported on this operating system".into());
    #[cfg(unix)]
    {
        let ours = scan();
        let root = Pid::from_u32(std::process::id());
        let process_map: HashMap<Pid, &Found> =
            ours.iter().map(|found| (found.pid, found)).collect();
        let inherited = process_map.get(&root).and_then(|found| found.chat.as_ref());
        let target_pid = Pid::from_u32(request.pid);
        let target = process_map
            .get(&target_pid)
            .ok_or_else(|| "process is no longer running".to_string())?;
        let chat = effective_chat(target_pid, &process_map, inherited);
        if chat.as_deref() != Some(request.session_id.as_str()) {
            return Err("process no longer belongs to that chat".into());
        }
        if target.start_time != request.start_time {
            return Err("process identity changed; refresh and try again".into());
        }
        if role_of(target, root, &process_map, chat.as_deref()) != "subprocess" {
            return Err(
                "Atelier can stop only a chat subprocess, not its provider or app services".into(),
            );
        }
        let parents: HashMap<Pid, Option<Pid>> =
            ours.iter().map(|found| (found.pid, found.parent)).collect();
        let mut victims: Vec<&Found> = ours
            .iter()
            .filter(|found| belongs_to(found.pid, target_pid, &parents))
            .collect();
        victims.sort_by_key(|found| std::cmp::Reverse(depth(found.pid, &parents)));
        let mut stopped = 0;
        for victim in victims {
            // The fresh snapshot and start-time match above make a recycled target
            // fail closed. Descendants are signalled before their parent so they
            // cannot be left running merely because the parent exits first.
            if unsafe { libc::kill(victim.pid.as_u32() as i32, libc::SIGTERM) } == 0 {
                stopped += 1;
            }
        }
        Ok(stopped)
    }
}

fn depth(mut pid: Pid, parents: &HashMap<Pid, Option<Pid>>) -> usize {
    let mut depth = 0;
    let mut seen = HashSet::new();
    while seen.insert(pid) {
        let Some(parent) = parents.get(&pid).copied().flatten() else {
            break;
        };
        depth += 1;
        pid = parent;
    }
    depth
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

    #[test]
    fn finds_its_own_group_and_refuses_the_root() {
        let own = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/atelier.service\n";
        assert_eq!(
            cgroup_path(own),
            Some("/user.slice/user-1000.slice/user@1000.service/app.slice/atelier.service")
        );
        assert_eq!(cgroup_path("0::/\n"), None);
        assert_eq!(cgroup_path("12:memory:/legacy\n"), None);
    }

    /// `file` is the cache; `file_mapped` and `file_dirty` are parts of it and
    /// must not answer for it.
    #[test]
    fn reads_the_cache_counter_by_its_whole_name() {
        let stat = "anon 2344000000\nfile 5932000000\nfile_mapped 241000000\nshmem 1000\n";
        assert_eq!(stat_field(stat, "file"), Some(5_932_000_000));
        assert_eq!(stat_field(stat, "shmem"), Some(1000));
        assert_eq!(stat_field(stat, "kernel"), None);
    }

    /// The killer reads the `full` line; the `some` line runs higher and
    /// would cry wolf.
    #[test]
    fn pressure_is_the_full_ten_second_average() {
        let pressure = "some avg10=91.50 avg60=40.00 avg300=9.00 total=1\nfull avg10=77.23 avg60=54.69 avg300=17.55 total=2\n";
        assert_eq!(full_pressure(pressure), Some(77.23));
        assert_eq!(full_pressure("some avg10=1.00 avg60=0 avg300=0 total=0\n"), None);
    }

    #[cfg(target_os = "linux")]
    const ROLLUP: &str = "Rss:               12000 kB\nPss:                4321 kB\nPss_Anon:           4000 kB\nSwap:               9000 kB\nSwapPss:            1234 kB\n";

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_pss_without_confusing_it_with_pss_anon() {
        assert_eq!(parse_field(ROLLUP, "Pss:"), Some(4_424_704));
    }

    /// `Swap:` counts pages the process shares with others; `SwapPss:` counts
    /// its own share. A prefix match that answered `Swap:` for `SwapPss:` would
    /// charge this process for all nine megabytes instead of its own 1234 kB.
    #[cfg(target_os = "linux")]
    #[test]
    fn reads_swap_pss_without_confusing_it_with_plain_swap() {
        assert_eq!(parse_field(ROLLUP, "SwapPss:"), Some(1_263_616));
        assert_eq!(parse_field(ROLLUP, "Swap:"), Some(9_216_000));
    }

    /// The whole point of the fix: a process pays for what it has paged out.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_process_costs_what_it_holds_plus_what_it_has_paged_out() {
        let cost = ProcessCost {
            resident: parse_field(ROLLUP, "Pss:").unwrap(),
            swapped: parse_field(ROLLUP, "SwapPss:").unwrap(),
        };
        assert_eq!(cost.total(), 4_424_704 + 1_263_616);
    }

    /// A rollup with no swap line is a machine that has never paged this
    /// process out, not a rollup that could not be read.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_rollup_without_a_swap_line_costs_only_what_is_resident() {
        let sample = "Rss:               12000 kB\nPss:                4321 kB\n";
        assert_eq!(parse_field(sample, "SwapPss:"), None);
        let cost = ProcessCost {
            resident: parse_field(sample, "Pss:").unwrap(),
            swapped: parse_field(sample, "SwapPss:").unwrap_or(0),
        };
        assert_eq!(cost.total(), 4_424_704);
    }

    #[test]
    fn a_descendant_inherits_the_nearest_chat_and_only_tools_are_killable() {
        let root = Pid::from_u32(10);
        let adapter = Pid::from_u32(11);
        let provider = Pid::from_u32(12);
        let tool = Pid::from_u32(13);
        let found = vec![
            Found {
                pid: root,
                parent: None,
                name: "atelier".into(),
                chat: None,
                start_time: 1,
            },
            Found {
                pid: adapter,
                parent: Some(root),
                name: "claude-acp".into(),
                chat: Some("chat-1".into()),
                start_time: 2,
            },
            Found {
                pid: provider,
                parent: Some(adapter),
                name: "claude".into(),
                chat: Some("chat-1".into()),
                start_time: 3,
            },
            Found {
                pid: tool,
                parent: Some(provider),
                name: "cargo".into(),
                chat: None,
                start_time: 4,
            },
        ];
        let processes: HashMap<Pid, &Found> = found.iter().map(|row| (row.pid, row)).collect();
        assert_eq!(
            effective_chat(tool, &processes, None).as_deref(),
            Some("chat-1")
        );
        assert_eq!(
            role_of(processes[&adapter], root, &processes, Some("chat-1")),
            "chatAdapter"
        );
        assert_eq!(
            role_of(processes[&provider], root, &processes, Some("chat-1")),
            "provider"
        );
        assert_eq!(
            role_of(processes[&tool], root, &processes, Some("chat-1")),
            "subprocess"
        );
    }

    #[cfg(unix)]
    #[test]
    fn termination_stops_a_marked_tool_without_stopping_this_process() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .env(CHAT_ENV, "termination-test-chat")
            .spawn()
            .unwrap();
        let pid = Pid::from_u32(child.id());
        let mut system = System::new_all();
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        let start_time = system.process(pid).unwrap().start_time();
        assert_eq!(
            terminate(TerminateRequest {
                pid: pid.as_u32(),
                start_time,
                session_id: "termination-test-chat".into(),
            })
            .unwrap(),
            1
        );
        assert!(!child.wait().unwrap().success());
    }
}
