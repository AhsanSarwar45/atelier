//! Proportional memory owned by this Atelier process and its descendants.

use super::actor::ChatDb;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use sysinfo::Pid;
#[cfg(any(test, not(target_os = "linux")))]
use sysinfo::{ProcessesToUpdate, System};
#[cfg(not(target_os = "linux"))]
use sysinfo::{ProcessRefreshKind, UpdateKind};

pub const CHAT_ENV: &str = "ATELIER_CHAT_SESSION_ID";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMemory {
    pub session_id: String,
    pub title: String,
    /// What the chat's own processes hold. The memory limit judges this and
    /// not the containers below: stopping a chat does not stop its containers,
    /// so counting them would stop it again every time it restarted.
    pub bytes: u64,
    pub processes: usize,
    /// What the containers charged to this chat hold, file cache left out.
    pub container_bytes: u64,
    pub containers: usize,
}

/// One running container and the chat it is charged to (bw-meh1.2).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMemory {
    pub id: String,
    pub name: String,
    pub image: String,
    /// Everything charged to the container's group in RAM and swap, less the
    /// file cache the kernel can drop. `docker stats` leaves swap out; this
    /// counts it, as the process figures do, because paged-out memory still
    /// costs the machine (bw-c4i2.1).
    pub bytes: u64,
    pub cache_bytes: u64,
    pub session_id: Option<String>,
    pub chat_title: Option<String>,
    /// How the chat was found: `label`, set when the chat created it, or
    /// `workingDir`, the folder Compose started it from being the one a
    /// running chat works in.
    pub owner: Option<&'static str>,
    pub project: Option<String>,
    pub working_dir: Option<String>,
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
    /// Started by the chat, but its parent has exited, so it is no longer
    /// under the app. It is still in the app's group and still the chat's.
    pub outlived: bool,
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
    /// Containers are started by the Docker daemon, not by this app, so they
    /// are counted apart from `total_bytes` and by a different measure.
    pub container_bytes: u64,
    pub containers: Vec<ContainerMemory>,
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
    /// Programs in the group this app did not start, such as a Dolt server
    /// `bd` left running: the kernel charges them to the app all the same.
    pub others: Vec<OtherProcess>,
}

/// A process in the app's group that is not one of its descendants.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OtherProcess {
    pub pid: u32,
    pub name: String,
    pub bytes: u64,
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

#[cfg(not(target_os = "linux"))]
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

/// The pages a process holds itself: its anonymous memory and its share of
/// shared memory. The program and library files it maps are left out. The
/// service is charged for those as disk cache, and only when it was the first
/// to read them. Counted per process, they made the entries add up to more
/// than the Total (bw-xeeqg.21). A kernel older than 5.14 has no `Pss_Anon`,
/// and all of `Pss` is the best it can say.
#[cfg(target_os = "linux")]
fn held(contents: &str) -> Option<u64> {
    match parse_field(contents, "Pss_Anon:") {
        Some(anon) => Some(anon.saturating_add(parse_field(contents, "Pss_Shmem:").unwrap_or(0))),
        None => parse_field(contents, "Pss:"),
    }
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
            resident: held(&contents).ok_or_else(|| format!("missing Pss in {path}"))?,
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

/// A group's charge in RAM and swap, and the part of it that is file cache.
fn group_memory(group: &std::path::Path) -> Option<(u64, u64)> {
    let read = |name: &str| std::fs::read_to_string(group.join(name)).ok();
    let current: u64 = read("memory.current")?.trim().parse().ok()?;
    let swapped: u64 = read("memory.swap.current")
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0);
    let stat = read("memory.stat")?;
    let cache = stat_field(&stat, "file")?.saturating_sub(stat_field(&stat, "shmem").unwrap_or(0));
    Some((current.saturating_add(swapped), cache))
}

/// Whether the group is the app's own to report: a systemd service is, and
/// so is any group holding nothing but the app's own processes. A terminal or
/// a desktop session scope is neither, and would count unrelated programs.
fn group_is_ours(path: &str, all_ours: bool) -> bool {
    all_ours || path.rsplit('/').next().is_some_and(|unit| unit.ends_with(".service"))
}

/// The group's own account, which is what the kernel and `systemd-oomd` hold
/// the app to. It used to be dropped whenever the group held one process the
/// app had not started — a Dolt server `bd` left behind is one — so the badge
/// showed the app's own 2.6 GB while the service was killed at 16 GB with no
/// sign of it (bw-xeeqg.16).
#[cfg(target_os = "linux")]
fn service_memory(ours: &[Found]) -> Option<ServiceMemory> {
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = cgroup_path(&own)?;
    let group = own_group()?;
    let read = |name: &str| std::fs::read_to_string(group.join(name)).ok();
    let pids: HashSet<u32> = ours.iter().map(|found| found.pid.as_u32()).collect();
    let members: Vec<u32> = read("cgroup.procs")?
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();
    if members.is_empty() {
        return None;
    }
    let outside: Vec<u32> = members.into_iter().filter(|pid| !pids.contains(pid)).collect();
    if !group_is_ours(path, outside.is_empty()) {
        return None;
    }
    let (total, cache) = group_memory(&group)?;
    let others = outside
        .into_iter()
        .filter_map(|pid| {
            let cost = process_cost(Pid::from_u32(pid)).ok().flatten()?;
            Some(OtherProcess { pid, name: read_stat(pid)?.name, bytes: cost.total() })
        })
        .collect();
    Some(ServiceMemory {
        total_bytes: total,
        cache_bytes: cache,
        pressure: read("memory.pressure").as_deref().and_then(full_pressure).unwrap_or(0.0),
        others,
    })
}

#[cfg(not(target_os = "linux"))]
fn service_memory(_ours: &[Found]) -> Option<ServiceMemory> {
    None
}

/// The proportional share of the pages a process holds itself, resident and
/// swapped together. The name says both halves because a reader who saw "pss"
/// would reasonably expect a number that ignores swap, which is the bug this
/// replaced (bw-c4i2.2). "Held" leaves out mapped files (bw-xeeqg.21).
const MEMORY_METRIC: &str = "heldPssWithSwap";

/// One of this app's own processes, with what the report shows of it.
struct Found {
    pid: Pid,
    parent: Option<Pid>,
    name: String,
    chat: Option<String>,
    start_time: u64,
    /// Not under the app: a chat's program whose parent exited, found in the
    /// app's group by the chat id it inherited.
    outlived: bool,
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

/// This app and every process under it, found by walking down from this
/// process through the kernel's list of each thread's children. The badge
/// asks every three seconds. Asking sysinfo for every process on the machine
/// meant opening every thread's `stat`, thousands on a busy machine, and
/// sysinfo kept each of those files open, so the app held thousands of files
/// and read megabytes a minute to find a dozen of its own processes.
#[cfg(target_os = "linux")]
fn scan() -> Vec<Found> {
    let mut found = walk();
    let own_chat = found.first().and_then(|app| app.chat.clone());
    adopt_group(&mut found, own_chat.as_deref());
    found
}

#[cfg(target_os = "linux")]
fn walk() -> Vec<Found> {
    let root = std::process::id();
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = vec![(root, None)];
    while let Some((pid, parent)) = queue.pop() {
        if !seen.insert(pid) {
            continue;
        }
        let Some(stat) = read_stat(pid) else { continue };
        for child in children(pid) {
            queue.push((child, Some(pid)));
        }
        let start_time = stat.started_at();
        found.push(Found {
            pid: Pid::from_u32(pid),
            parent: parent.or(stat.parent).map(Pid::from_u32),
            chat: environ_chat(pid, stat.started),
            name: stat.name,
            start_time,
            outlived: false,
        });
    }
    found
}

#[cfg(target_os = "linux")]
fn adopt_group(found: &mut Vec<Found>, own_chat: Option<&str>) {
    let members = own_group()
        .and_then(|group| std::fs::read_to_string(group.join("cgroup.procs")).ok())
        .unwrap_or_default();
    adopt_outlived(found, own_chat, &members, |pid| {
        let stat = read_stat(pid)?;
        let chat = environ_chat(pid, stat.started)?;
        Some(Found {
            pid: Pid::from_u32(pid),
            parent: stat.parent.map(Pid::from_u32),
            chat: Some(chat),
            start_time: stat.started_at(),
            name: stat.name,
            outlived: true,
        })
    });
}

/// A program a chat starts can outlive the process that started it: a server
/// whose launcher was killed, or a pool of workers whose parent exited. The
/// kernel then hands it to systemd, so a walk down from the app no longer
/// finds it, but it stays in the app's group and keeps the chat id it was
/// started with. 136 such Python workers, 13.7 GB, were shown as "Other
/// programs" while the chat that started them was the one to blame
/// (bw-xeeqg.20). An app itself started from a chat adopts nothing: every
/// program in its group carries that other chat's id.
#[cfg(any(test, target_os = "linux"))]
fn adopt_outlived(
    found: &mut Vec<Found>,
    own_chat: Option<&str>,
    members: &str,
    read: impl Fn(u32) -> Option<Found>,
) {
    if own_chat.is_some() {
        return;
    }
    let seen: HashSet<u32> = found.iter().map(|found| found.pid.as_u32()).collect();
    for pid in members.lines().filter_map(|line| line.trim().parse::<u32>().ok()) {
        if seen.contains(&pid) {
            continue;
        }
        if let Some(outlived) = read(pid).filter(|outlived| outlived.chat.is_some()) {
            found.push(outlived);
        }
    }
}

/// The app's own control group folder, when it runs in one of its own.
#[cfg(target_os = "linux")]
fn own_group() -> Option<std::path::PathBuf> {
    let own = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = cgroup_path(&own)?;
    Some(std::path::Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/')))
}

#[cfg(target_os = "linux")]
struct Stat {
    name: String,
    parent: Option<u32>,
    /// Clock ticks after boot, as the kernel writes it.
    started: u64,
}

#[cfg(target_os = "linux")]
impl Stat {
    /// Seconds since the epoch, the same figure sysinfo gave, so a stop
    /// request carrying a start time from an older report still matches.
    fn started_at(&self) -> u64 {
        static BOOT: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
        let (boot, ticks) = *BOOT.get_or_init(|| {
            let boot = std::fs::read_to_string("/proc/stat")
                .ok()
                .and_then(|stat| {
                    stat.lines()
                        .find_map(|line| line.strip_prefix("btime")?.trim().parse::<u64>().ok())
                })
                .unwrap_or(0);
            // SAFETY: sysconf reads a constant and has no preconditions.
            let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
            (boot, if ticks > 0 { ticks as u64 } else { 100 })
        });
        boot.saturating_add(self.started / ticks)
    }
}

#[cfg(target_os = "linux")]
fn read_stat(pid: u32) -> Option<Stat> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The name sits in parentheses and may itself hold spaces or parentheses,
    // so the fields after it are counted from the last closing one.
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let name = stat.get(open + 1..close)?.to_owned();
    let fields: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    // After the name: state, ppid, ... starttime is field 22 overall, the
    // 20th after the name.
    let parent = fields.get(1)?.parse::<u32>().ok().filter(|pid| *pid != 0);
    let started = fields.get(19)?.parse::<u64>().ok()?;
    Some(Stat {
        name,
        parent,
        started,
    })
}

/// Every thread's children, since a child belongs to the thread that started
/// it and not only to the main one.
#[cfg(target_os = "linux")]
fn children(pid: u32) -> Vec<u32> {
    let Ok(threads) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    let mut children = Vec::new();
    for thread in threads.flatten() {
        let Ok(list) = std::fs::read_to_string(thread.path().join("children")) else {
            continue;
        };
        children.extend(list.split_whitespace().filter_map(|pid| pid.parse::<u32>().ok()));
    }
    children
}

/// A process's environment is fixed once it runs, so it is read once for each
/// process and kept by its start, which a reused number does not share.
#[cfg(target_os = "linux")]
fn environ_chat(pid: u32, started: u64) -> Option<String> {
    static KEPT: std::sync::LazyLock<std::sync::Mutex<HashMap<u32, (u64, Option<String>)>>> =
        std::sync::LazyLock::new(Default::default);
    let mut kept = KEPT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, chat)) = kept.get(&pid) {
        if *at == started {
            return chat.clone();
        }
    }
    let chat = std::fs::read(format!("/proc/{pid}/environ")).ok().and_then(|environ| {
        let prefix = format!("{CHAT_ENV}=");
        environ.split(|byte| *byte == 0).find_map(|entry| {
            let entry = std::str::from_utf8(entry).ok()?;
            entry
                .strip_prefix(&prefix)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
    });
    if kept.len() > 4096 {
        kept.clear();
    }
    kept.insert(pid, (started, chat.clone()));
    chat
}

#[cfg(not(target_os = "linux"))]
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
                outlived: false,
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
    let running = super::docker::running().await;
    let (ours, mut service, measured) = tokio::task::spawn_blocking(move || {
        let ours = scan();
        let service = service_memory(&ours);
        let measured: Vec<(super::docker::Running, (u64, u64))> = running
            .into_iter()
            .filter_map(|container| {
                let memory = group_memory(container.group.as_deref()?)?;
                Some((container, memory))
            })
            .collect();
        (ours, service, measured)
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
    let sessions = if running_chats.is_empty() && measured.is_empty() {
        Vec::new()
    } else {
        database.list_sessions(None).await?
    };
    let live: Vec<(&str, &str)> = sessions
        .iter()
        .filter(|session| running_chats.contains(&session.id))
        .map(|session| (session.id.as_str(), session.cwd.as_str()))
        .collect();
    let known: HashSet<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
    // A program found only by the chat id it carries is this app's when the
    // chat is: another copy of the app, started from a chat here, puts its
    // own chats' ids on programs in this same group.
    let strays: HashSet<Pid> = ours
        .iter()
        .filter(|found| found.outlived)
        .filter(|found| !found.chat.as_deref().is_some_and(|chat| known.contains(chat)))
        .map(|found| found.pid)
        .collect();
    let containers: Vec<ContainerMemory> = measured
        .into_iter()
        .map(|(container, (total, cache))| {
            let working_dir = container.labels.get(super::docker::WORKING_DIR_LABEL).cloned();
            let (session_id, owner) = container_owner(&container.labels, &known, &live);
            ContainerMemory {
                id: container.id.chars().take(12).collect(),
                name: container.name,
                image: container.image,
                bytes: total.saturating_sub(cache),
                cache_bytes: cache,
                session_id,
                chat_title: None,
                owner,
                project: container.labels.get("com.docker.compose.project").cloned(),
                working_dir,
            }
        })
        .collect();
    let owning: HashSet<&str> = containers
        .iter()
        .filter_map(|container| container.session_id.as_deref())
        .collect();
    let titles: HashMap<String, String> = sessions
        .iter()
        .filter(|session| running_chats.contains(&session.id) || owning.contains(session.id.as_str()))
        .map(|session| {
            // The one naming rule, so a chat is called the same thing here
            // as on the rail and in the tray (chat_name, bw-altj.7).
            let name = crate::workbench::chat_name::name_session(session);
            (session.id.clone(), name)
        })
        .collect();
    for found in &ours {
        let Some(cost) = process_cost(found.pid)? else {
            continue;
        };
        if strays.contains(&found.pid) {
            if let Some(service) = service.as_mut() {
                service.others.push(OtherProcess {
                    pid: found.pid.as_u32(),
                    name: found.name.clone(),
                    bytes: cost.total(),
                });
            }
            continue;
        }
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
            outlived: found.outlived,
        });
    }
    let mut containers = containers;
    let mut by_chat: HashMap<String, (u64, usize)> = HashMap::new();
    for container in &mut containers {
        if let Some(id) = container.session_id.as_ref() {
            container.chat_title = titles.get(id).cloned();
            let entry = by_chat.entry(id.clone()).or_default();
            entry.0 = entry.0.saturating_add(container.bytes);
            entry.1 += 1;
        }
    }
    for id in by_chat.keys() {
        grouped.entry(id.clone()).or_default();
    }
    let mut chats = grouped
        .into_iter()
        .map(|(session_id, (bytes, processes))| {
            let (container_bytes, container_count) = by_chat.get(&session_id).copied().unwrap_or_default();
            ChatMemory {
                title: titles
                    .get(&session_id)
                    .cloned()
                    .unwrap_or_else(|| "Active chat".into()),
                session_id,
                bytes,
                processes,
                container_bytes,
                containers: container_count,
            }
        })
        .collect::<Vec<_>>();
    chats.sort_by(|a, b| {
        (b.bytes + b.container_bytes)
            .cmp(&(a.bytes + a.container_bytes))
            .then_with(|| a.title.cmp(&b.title))
    });
    containers.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    details.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.pid.cmp(&b.pid)));
    Ok(MemoryReport {
        total_bytes: total,
        swap_bytes: swapped_total,
        metric: MEMORY_METRIC,
        process_count: details.len(),
        chats,
        process_details: details,
        service,
        container_bytes: containers.iter().map(|container| container.bytes).sum(),
        containers,
    })
}

/// The chat a container is charged to. Its label wins, when it names a chat
/// this app holds; a label from another copy of the app names nobody here.
/// Without one, a Compose container belongs to the running chat whose folder
/// it was started from: the same folder, or one inside the other, the closest
/// match winning. Two chats matching equally closely are both plausible, so
/// neither is charged.
fn container_owner(
    labels: &HashMap<String, String>,
    known: &HashSet<&str>,
    live: &[(&str, &str)],
) -> (Option<String>, Option<&'static str>) {
    if let Some(chat) = labels.get(super::docker::CHAT_LABEL) {
        return if known.contains(chat.as_str()) {
            (Some(chat.clone()), Some("label"))
        } else {
            (None, None)
        };
    }
    let Some(folder) = labels.get(super::docker::WORKING_DIR_LABEL) else {
        return (None, None);
    };
    let folder = std::path::Path::new(folder);
    let mut best: Option<(usize, &str)> = None;
    let mut tied = false;
    for (id, cwd) in live {
        let cwd = std::path::Path::new(cwd);
        if !(cwd.starts_with(folder) || folder.starts_with(cwd)) {
            continue;
        }
        let closeness = cwd.components().count().min(folder.components().count());
        match best {
            Some((score, chat)) if score == closeness && chat != *id => tied = true,
            Some((score, _)) if score >= closeness => {}
            _ => {
                best = Some((closeness, id));
                tied = false;
            }
        }
    }
    match best {
        Some((_, chat)) if !tied => (Some(chat.to_owned()), Some("workingDir")),
        _ => (None, None),
    }
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

/// Stop every program a chat left running after its parent exited. Closing a
/// chat stops what is still under its provider; these are not, and a chat
/// stopped for its memory limit would otherwise be over it again at once.
pub fn stop_outlived(session_id: &str) -> usize {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = session_id;
        0
    }
    #[cfg(target_os = "linux")]
    {
        // The id is named, so what carries it is the chat's even when this
        // app was itself started from a chat.
        let mut ours = walk();
        adopt_group(&mut ours, None);
        let parents: HashMap<Pid, Option<Pid>> =
            ours.iter().map(|found| (found.pid, found.parent)).collect();
        let mut victims: Vec<&Found> = ours
            .iter()
            .filter(|found| found.outlived && found.chat.as_deref() == Some(session_id))
            .collect();
        victims.sort_by_key(|found| std::cmp::Reverse(depth(found.pid, &parents)));
        victims
            .into_iter()
            .filter(|victim| unsafe { libc::kill(victim.pid.as_u32() as i32, libc::SIGTERM) } == 0)
            .count()
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

    /// The app's service is reported even with a Dolt server `bd` left in it;
    /// a terminal's scope only when nothing else runs there (bw-xeeqg.16).
    #[test]
    fn a_service_is_reported_with_programs_it_did_not_start() {
        let service = "/user.slice/user-1000.slice/user@1000.service/app.slice/atelier.service";
        let terminal = "/user.slice/user-1000.slice/user@1000.service/app.slice/app-ptyxis-1.scope";
        assert!(group_is_ours(service, false));
        assert!(!group_is_ours(terminal, false));
        assert!(group_is_ours(terminal, true));
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

    fn labels(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn a_container_is_charged_to_the_chat_its_label_names_when_this_app_holds_it() {
        let known = HashSet::from(["chat-1", "chat-2"]);
        let live = [("chat-2", "/work/shop")];
        let labelled = labels(&[
            (super::super::docker::CHAT_LABEL, "chat-1"),
            (super::super::docker::WORKING_DIR_LABEL, "/work/shop"),
        ]);
        assert_eq!(container_owner(&labelled, &known, &live), (Some("chat-1".into()), Some("label")));
        let elsewhere = labels(&[
            (super::super::docker::CHAT_LABEL, "another-app"),
            (super::super::docker::WORKING_DIR_LABEL, "/work/shop"),
        ]);
        assert_eq!(container_owner(&elsewhere, &known, &live), (None, None));
    }

    #[test]
    fn an_unlabelled_compose_container_goes_to_the_closest_running_chat_or_nobody() {
        let known = HashSet::from(["root", "server", "other", "twin"]);
        let stack = labels(&[(super::super::docker::WORKING_DIR_LABEL, "/work/shop")]);
        let live = [("root", "/work"), ("server", "/work/shop/server"), ("other", "/elsewhere")];
        assert_eq!(container_owner(&stack, &known, &live), (Some("server".into()), Some("workingDir")));
        let live = [("other", "/elsewhere")];
        assert_eq!(container_owner(&stack, &known, &live), (None, None));
        let live = [("server", "/work/shop"), ("twin", "/work/shop")];
        assert_eq!(container_owner(&stack, &known, &live), (None, None));
        // A folder that only shares a prefix of its name is not the same folder.
        let live = [("other", "/work/shopfront")];
        assert_eq!(container_owner(&stack, &known, &live), (None, None));
        assert_eq!(container_owner(&labels(&[]), &known, &live), (None, None));
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
            resident: held(ROLLUP).unwrap(),
            swapped: parse_field(ROLLUP, "SwapPss:").unwrap(),
        };
        assert_eq!(cost.total(), 4_096_000 + 1_263_616);
    }

    /// The files a process maps are the service's disk cache, not the
    /// process's own memory, so the entries and the cache do not count them
    /// twice (bw-xeeqg.21).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_process_holds_its_own_and_shared_memory_but_not_the_files_it_maps() {
        let rollup = "Pss:                9000 kB\nPss_Anon:           4000 kB\nPss_File:           4500 kB\nPss_Shmem:           500 kB\n";
        assert_eq!(held(rollup), Some(4_500 * 1024));
        // An older kernel without the split says only Pss.
        assert_eq!(held("Pss:                9000 kB\n"), Some(9_000 * 1024));
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
                outlived: false,
            },
            Found {
                pid: adapter,
                parent: Some(root),
                name: "claude-acp".into(),
                chat: Some("chat-1".into()),
                start_time: 2,
                outlived: false,
            },
            Found {
                pid: provider,
                parent: Some(adapter),
                name: "claude".into(),
                chat: Some("chat-1".into()),
                start_time: 3,
                outlived: false,
            },
            Found {
                pid: tool,
                parent: Some(provider),
                name: "cargo".into(),
                chat: None,
                start_time: 4,
                outlived: false,
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

    /// Against the machine's real daemon: `cargo test real_container -- --ignored
    /// --nocapture`, with at least one container running.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_containers_are_found_and_measured_by_their_group() {
        let running = super::super::docker::running().await;
        assert!(!running.is_empty(), "no running container to measure");
        for container in &running {
            let group = container.group.as_deref().expect("every running container has a group");
            let (total, cache) = group_memory(group).expect("its group has a memory account");
            println!("{} {} total={total} cache={cache} in {}", container.name, container.image, group.display());
            assert!(total > 0);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_scan_walks_only_this_tree_and_keeps_no_file_open() {
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .env(CHAT_ENV, "scan-test-chat")
            .spawn()
            .unwrap();
        let pid = Pid::from_u32(child.id());
        // Other tests run in this process at the same time, so only files
        // under the child's own entry are looked for.
        let mut found = Vec::new();
        for _ in 0..5 {
            found = scan();
        }
        let inside = format!("/proc/{}/", pid.as_u32());
        let held: Vec<_> = std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .flatten()
            .filter_map(|fd| std::fs::read_link(fd.path()).ok())
            .filter(|target| target.to_string_lossy().starts_with(&inside))
            .collect();
        sysinfo::set_open_files_limit(0);
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        let expected = system.process(pid).unwrap().start_time();
        child.kill().unwrap();
        child.wait().unwrap();

        let row = found.iter().find(|row| row.pid == pid).expect("the child is found");
        assert_eq!(row.parent, Some(Pid::from_u32(std::process::id())));
        assert_eq!(row.name, "sleep");
        assert_eq!(row.chat.as_deref(), Some("scan-test-chat"));
        assert_eq!(row.start_time, expected, "the start time sysinfo gave, so old stop requests match");
        assert!(found.iter().any(|row| row.pid.as_u32() == std::process::id()));
        assert!(
            found.iter().all(|row| row.pid.as_u32() == std::process::id() || row.parent.is_some()),
            "only this process and what descends from it"
        );
        assert!(held.is_empty(), "scans left the child's files open: {held:?}");
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
        sysinfo::set_open_files_limit(0);
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

    #[test]
    fn a_program_in_the_group_is_the_chat_it_carries_unless_the_app_is_a_chat_s_own() {
        let found_at = |pid: u32, chat: Option<&str>| Found {
            pid: Pid::from_u32(pid),
            parent: Some(Pid::from_u32(1)),
            name: "python3.14".into(),
            chat: chat.map(str::to_owned),
            start_time: 1,
            outlived: true,
        };
        let read = |pid: u32| match pid {
            20 => Some(found_at(20, Some("chat-1"))),
            21 => Some(found_at(21, None)),
            _ => None,
        };
        let app = || Found { outlived: false, parent: None, name: "atelier".into(), ..found_at(10, None) };
        let mut found = vec![app()];
        adopt_outlived(&mut found, None, "10\n20\n21\n22\n", read);
        assert_eq!(
            found.iter().map(|found| (found.pid.as_u32(), found.outlived)).collect::<Vec<_>>(),
            [(10, false), (20, true)],
            "the app is not found twice, and a program no chat started stays out"
        );
        let mut found = vec![app()];
        adopt_outlived(&mut found, Some("parent-chat"), "10\n20\n", read);
        assert_eq!(found.len(), 1, "an app started from a chat adopts nothing");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_program_whose_parent_exited_is_found_by_its_chat_and_stopped_with_it() {
        let launcher = std::process::Command::new("sh")
            .args(["-c", "sleep 30 >/dev/null 2>&1 & echo $!"])
            .env(CHAT_ENV, "outlived-test-chat")
            .output()
            .unwrap();
        let pid: u32 = String::from_utf8(launcher.stdout).unwrap().trim().parse().unwrap();
        let orphan = Pid::from_u32(pid);
        assert!(!walk().iter().any(|found| found.pid == orphan), "no longer under this process");
        let mut found = walk();
        adopt_group(&mut found, None);
        let adopted = found.iter().find(|found| found.pid == orphan);
        let stopped = stop_outlived("outlived-test-chat");
        // Reaped by whoever adopted it; only its absence is looked for.
        let gone = (0..50).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            read_stat(pid).is_none_or(|stat| stat.name != "sleep")
        });
        let adopted = adopted.expect("found in this group by its chat id");
        assert!(adopted.outlived);
        assert_eq!(adopted.chat.as_deref(), Some("outlived-test-chat"));
        assert_eq!(stopped, 1);
        assert!(gone, "the program was stopped");
    }
}
