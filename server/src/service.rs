//! Having the computer start it for you.
//!
//! The product came up only when somebody typed the command, so a machine that
//! rebooted came back with no board and no chat until a person noticed
//! (bw-8um.3.13). Every operating system already has something that starts a
//! program at login and restarts it when it dies; what was missing was a
//! command that writes the right thing in the right place, and one that takes
//! it back off without leaving anything behind.
//!
//! Three registrars, one shape. What each of them is asked to start is the
//! same line in every case — the one command, with the browser left alone,
//! because a service must not open a window on top of whatever the machine was
//! doing.
//!
//! The text each one is given is built by a plain function, not behind a
//! platform switch, so all three can be read and tested on any machine. Only
//! running them is platform-specific.

use crate::identity::{DISPLAY, NAME, ORGANISATION, QUALIFIER};
use std::path::PathBuf;
use std::process::Command;

/// What the reader asked of the service.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Action {
    Install,
    Uninstall,
    Status,
}

/// The one line every registrar is told to start.
///
/// `--no-browser` is not an option here: a thing started at login, before
/// anybody has looked at the screen, must not open a window.
pub const STARTED_AS: [&str; 2] = ["run", "--no-browser"];

/// What the registration is called wherever the machine keeps its list.
///
/// `ATELIER_SERVICE_NAME` overrides it. That exists so a check can register a
/// second, differently-named copy without touching the one the reader is
/// actually using — every registrar keys on this name, so two names are two
/// independent registrations.
pub fn label() -> String {
    match std::env::var("ATELIER_SERVICE_NAME") {
        Ok(said) if !said.trim().is_empty() => sanitised(said.trim()),
        _ => NAME.to_string(),
    }
}

/// A name the three registrars will all accept: letters, digits, dash, dot.
///
/// A name with a slash in it would be a path on Linux, and a name with a space
/// would split into two arguments on Windows.
fn sanitised(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' })
        .collect();
    if cleaned.is_empty() { NAME.to_string() } else { cleaned }
}

/// The name launchd files an agent under: a reverse domain, like everything else there.
pub fn agent_label() -> String {
    format!("{QUALIFIER}.{ORGANISATION}.{}", label())
}

/// The port the registered copy will serve on, fixed at the time it is
/// registered rather than read from whatever environment login happens to have.
///
/// A service has no shell and inherits nothing, so a port left to be picked up
/// from the environment would silently become the default on the next reboot.
pub fn port() -> u16 {
    std::env::var("ATELIER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(crate::command_line::PORT)
}

/// The settings that have to travel into the definition, because the thing
/// reading it has no shell.
///
/// Whatever the reader had set when they registered it is what the machine
/// will start for the rest of the computer's life. The port is always written
/// down — left out, a copy registered on one port would silently come back on
/// the default after a reboot. The rest go only when they were set.
pub fn carried_settings() -> Vec<(String, String)> {
    settings_from(|name| std::env::var(name).ok())
}

/// The names that travel, in the order they are written down.
///
/// `PATH` is one of them because this program is a front onto command-line
/// tools it does not carry: the chat helper is started with `node` and its kit
/// fetched once with `npm`, the boards are read with `bd`, the database is
/// `dolt`. Every one of those is a bare name looked up on a list of places.
/// A service is started by something that never read the reader's shell, so
/// with the list left behind the board comes up with a dead chat and no boards
/// on it (bw-w5zs). It is carried exactly as the reader had it when they
/// registered, because that is the list their own tools were found on.
const CARRIED: [&str; 4] =
    ["ATELIER_HOST", "ATELIER_DATA_DIR", "BEADS_WORKBENCH_PORT", "PATH"];

/// The rule behind it, kept apart from the environment so it can be tested
/// without one test's variable reaching another running beside it.
fn settings_from(look: impl Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let port = look("ATELIER_PORT")
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    let mut out = vec![("ATELIER_PORT".to_string(), port.to_string())];
    for name in CARRIED {
        if let Some(value) = look(name).filter(|v| !v.trim().is_empty()) {
            out.push((name.to_string(), value));
        }
    }
    out
}

/* ------------------------------------------------------------------ *
 * What each registrar is handed.
 * ------------------------------------------------------------------ */

/// One setting, written where a service manager splits its lines on spaces.
///
/// `Environment=` takes more than one setting on a line, separated by spaces,
/// so a folder or a list of places with a space in it would arrive as two
/// settings, the second of them nonsense. Quoting the whole assignment stops
/// that; a quote or a backslash inside is escaped so it cannot end the
/// quoting early, and a percent sign is doubled by `as_typed`.
fn written_down(name: &str, value: &str) -> String {
    let escaped = as_typed(value).replace('\\', "\\\\").replace('"', "\\\"");
    format!("Environment=\"{name}={escaped}\"\n")
}

/// Text put where systemd reads its own specifiers, written so it arrives as
/// the reader typed it.
///
/// `Environment=` values and `ExecStart=` both go through specifier expansion
/// (systemd.exec(5), systemd.unit(5) "Specifiers"), where `%` opens one. A
/// folder called `100%` under a list of places would arrive as something else
/// entirely if the next letter happens to name a specifier — `%h` is the home
/// directory — and if it names none, the machine refuses the whole definition
/// and nothing starts at all. `%%` is how that manual says to write one
/// (bw-bddz.7).
fn as_typed(value: &str) -> String {
    value.replace('%', "%%")
}

/// Text put inside a tag, with the characters that would end it turned back
/// into text.
///
/// A folder or a list of places is the reader's, not ours: an ampersand in one
/// writes a registration the machine refuses to read, and the reader is left
/// with nothing starting and no idea why.
fn as_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The systemd user unit.
///
/// A user unit rather than a system one: writing into `/etc` needs a password,
/// and a board with one person's projects in it belongs to that person's
/// session. The desktop owns the display settings file and folder launchers
/// need, so this is ordered with and installed into the graphical session —
/// not the earlier default user target.
///
/// It comes back however it stopped, not only when it died. A running copy
/// stands down of its own accord the moment a newer build is installed over
/// the program it was started from, and that is a clean exit — under
/// `on-failure` the computer would take it at its word and leave the reader
/// with nothing running at all (bw-8um.3.10.1).
pub fn systemd_unit(exe: &str, carried: &[(String, String)]) -> String {
    let args = STARTED_AS.join(" ");
    let environment: String = carried.iter().map(|(name, value)| written_down(name, value)).collect();
    // Where the program sits is the reader's choice too, and this line is read
    // the same way a setting is: split on spaces, and its percent signs
    // expanded. Quoted and doubled, a folder with either in it still names one
    // program.
    let exe = format!("\"{}\"", as_typed(exe).replace('\\', "\\\\").replace('"', "\\\""));
    format!(
        "[Unit]\n\
         Description={DISPLAY} — the board, the screens and the chat\n\
         After=network.target graphical-session.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         {environment}\
         ExecStart={exe} {args}\n\
         Restart=always\n\
         RestartSec=5\n\
         \n\
         [Install]\n\
         WantedBy=graphical-session.target\n"
    )
}

/// The launchd agent.
pub fn launch_agent(exe: &str, carried: &[(String, String)], agent: &str) -> String {
    let args: String = STARTED_AS
        .iter()
        .map(|a| format!("    <string>{a}</string>\n"))
        .collect();
    let environment: String = carried
        .iter()
        .map(|(name, value)| {
            format!("\x20   <key>{}</key>\n\x20   <string>{}</string>\n", as_text(name), as_text(value))
        })
        .collect();
    let exe = as_text(exe);
    let agent = as_text(agent);
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key>\n\
         \x20 <string>{agent}</string>\n\
         \x20 <key>ProgramArguments</key>\n\
         \x20 <array>\n\
         \x20   <string>{exe}</string>\n\
         {args}\
         \x20 </array>\n\
         \x20 <key>EnvironmentVariables</key>\n\
         \x20 <dict>\n\
         {environment}\
         \x20 </dict>\n\
         \x20 <key>RunAtLoad</key>\n\
         \x20 <true/>\n\
         \x20 <key>KeepAlive</key>\n\
         \x20 <true/>\n\
         </dict>\n\
         </plist>\n"
    )
}

/// What Task Scheduler is told to run, as one quoted line.
///
/// The whole thing is one string on Windows, so the program's own path is
/// quoted; an install under `C:\\Program Files\\…` would otherwise split at the
/// space and try to start `C:\\Program`.
pub fn scheduled_command(exe: &str) -> String {
    format!("\"{exe}\" {}", STARTED_AS.join(" "))
}

/// Where the definition is written, on the platform this build is for.
///
/// Windows keeps its own list and hands out no file, which is why this can be
/// nothing.
pub fn definition_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        dirs_home().map(|h| h.join("Library/LaunchAgents").join(format!("{}.plist", agent_label())))
    } else if cfg!(target_os = "windows") {
        None
    } else {
        Some(systemd_dir()?.join(format!("{}.service", label())))
    }
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/* ------------------------------------------------------------------ *
 * Reading the registration back.
 * ------------------------------------------------------------------ */

/// The program this computer was told to start at login, read back out of the
/// registration `install` wrote.
///
/// A registration names one exact file, and nothing that installs a program
/// afterwards knows it exists. A reader who registered one copy and later
/// installed another somewhere else is left with the computer faithfully
/// starting the first one for the rest of its life — which is how a manager
/// upgraded, saw no change, and had nothing to ask (bw-8um.3.10.4).
pub fn registered_program() -> Option<String> {
    let path = definition_path()?;
    let text = std::fs::read_to_string(&path).ok()?;
    if cfg!(target_os = "macos") { program_in_plist(&text) } else { program_in_unit(&text) }
}

/// The program named by a systemd unit, undoing exactly what wrote it.
pub fn program_in_unit(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|l| l.starts_with("ExecStart="))?;
    let rest = line.strip_prefix("ExecStart=")?.trim_start();
    let quoted = rest.strip_prefix('"')?;

    // Read to the closing quote, honouring the escapes the writer put in — a
    // path with a quote in it would otherwise end here rather than where it
    // really ends.
    let mut out = String::new();
    let mut chars = quoted.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out.replace("%%", "%")),
            '\\' => out.push(chars.next()?),
            other => out.push(other),
        }
    }
    None
}

/// Whether the registration on this computer brings the program back however
/// it stopped — not only when it died.
///
/// A registration written by an older build says "restart it when it fails",
/// which is not the same thing. A copy that stands down on purpose to let a
/// newer build take over would be taken at its word under that rule and the
/// reader would be left with nothing running at all — a worse outcome than the
/// stale build they started with. So standing down is only ever done when this
/// says yes. Nothing when this computer keeps no such file to read
/// (bw-8um.3.10.1).
pub fn registration_comes_back_however_it_stops() -> Option<bool> {
    let path = definition_path()?;
    let text = std::fs::read_to_string(&path).ok()?;
    Some(if cfg!(target_os = "macos") {
        agent_comes_back_however_it_stops(&text)
    } else {
        unit_comes_back_however_it_stops(&text)
    })
}

/// The rule behind it for systemd, over the text rather than the machine.
pub fn unit_comes_back_however_it_stops(text: &str) -> bool {
    text.lines().map(str::trim).any(|line| line == "Restart=always")
}

/// The rule behind it for launchd.
pub fn agent_comes_back_however_it_stops(text: &str) -> bool {
    text.split("<key>KeepAlive</key>")
        .nth(1)
        .is_some_and(|rest| rest.trim_start().starts_with("<true/>"))
}

/// The program named by a launchd agent: the first of its arguments.
pub fn program_in_plist(text: &str) -> Option<String> {
    let after = text.split("<key>ProgramArguments</key>").nth(1)?;
    let opened = after.split("<string>").nth(1)?;
    let named = opened.split("</string>").next()?;
    Some(named.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
}

/// Where the user's own systemd units live.
fn systemd_dir() -> Option<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join("systemd/user")),
        _ => dirs_home().map(|h| h.join(".config/systemd/user")),
    }
}

/* ------------------------------------------------------------------ *
 * Doing it.
 * ------------------------------------------------------------------ */

/// The path worth writing into a registration, given the file this process is
/// running and where a bare name would be looked up.
///
/// A registration has to name a path that still means "the installed program"
/// a year later. This process's own path does not: a package manager installs
/// each version into a folder of its own and points one link at the newest, so
/// asking the running program where it sits gives the version-stamped folder —
/// which the next upgrade deletes, leaving the computer starting nothing at
/// all. The link is the stable name, so the link is what gets written down.
///
/// `named` is each place a bare name would be looked up, paired with the file
/// it really leads to.
pub fn worth_registering(exe: &str, named: &[(String, String)]) -> String {
    named
        .iter()
        .find(|(candidate, leads_to)| leads_to == exe && candidate != exe)
        .map(|(candidate, _)| candidate.clone())
        .unwrap_or_else(|| exe.to_string())
}

/// The same question, asked of this computer.
fn program_to_register() -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("this program cannot find its own path, so nothing can be registered to start it: {e}"))?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe).display().to_string();
    let named: Vec<(String, String)> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .map(|dir| dir.join(NAME))
        .filter_map(|candidate| {
            let leads_to = std::fs::canonicalize(&candidate).ok()?;
            Some((candidate.display().to_string(), leads_to.display().to_string()))
        })
        .collect();
    Ok(worth_registering(&exe, &named))
}

/// Carry out what the reader asked, printing what happened.
pub fn run(action: Action) -> Result<(), String> {
    let exe = program_to_register()?;
    match action {
        Action::Install => install(&exe),
        Action::Uninstall => uninstall(),
        Action::Status => status(),
    }
}

fn install(exe: &str) -> Result<(), String> {
    let port = port();
    let carried = carried_settings();
    if let Some(path) = definition_path() {
        let body = if cfg!(target_os = "macos") {
            launch_agent(exe, &carried, &agent_label())
        } else {
            systemd_unit(exe, &carried)
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("{} could not be made: {e}", parent.display()))?;
        }
        std::fs::write(&path, body)
            .map_err(|e| format!("{} could not be written: {e}", path.display()))?;
        println!("wrote {}", path.display());
    }

    for step in install_steps(exe) {
        say(&step)?;
    }

    // The address a phone would type, not only the one this computer uses:
    // the registration carries the bind address, so this is the same answer
    // the running copy gives (bw-hkai.1).
    let host = std::env::var("ATELIER_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    println!("{DISPLAY} will start with this computer.");
    let network = crate::reachable::on_this_network();
    let name = crate::reachable::name_on_this_network(network);
    for line in crate::reachable::openable_at(&host, port, network, name.as_deref()) {
        println!("  {line}");
    }
    Ok(())
}

fn uninstall() -> Result<(), String> {
    // Stopping comes before the file goes, or the manager is left holding a
    // running copy it can no longer name.
    for step in uninstall_steps() {
        let _ = say(&step);
    }
    if let Some(path) = definition_path() {
        match std::fs::remove_file(&path) {
            Ok(()) => println!("removed {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                println!("nothing registered at {}", path.display())
            }
            Err(e) => return Err(format!("{} could not be removed: {e}", path.display())),
        }
    }
    for step in after_uninstall_steps() {
        let _ = say(&step);
    }
    println!("{DISPLAY} no longer starts with this computer");
    Ok(())
}

fn status() -> Result<(), String> {
    if let Some(path) = definition_path() {
        println!(
            "{}: {}",
            path.display(),
            if path.exists() { "registered" } else { "not registered" }
        );
    }
    for step in status_steps() {
        let _ = say(&step);
    }
    Ok(())
}

/// One command, run and reported on. Its own output is the reader's.
fn say(step: &[String]) -> Result<(), String> {
    let (program, args) = step.split_first().ok_or("an empty command")?;
    let out = Command::new(program)
        .args(args)
        .output()
        .map_err(|e| format!("{program} could not be run: {e}"))?;
    let said = String::from_utf8_lossy(&out.stdout);
    let complained = String::from_utf8_lossy(&out.stderr);
    for line in said.lines().chain(complained.lines()) {
        if !line.trim().is_empty() {
            println!("  {line}");
        }
    }
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("`{} {}` failed", program, args.join(" ")))
    }
}

fn words(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|p| p.to_string()).collect()
}

fn install_steps(exe: &str) -> Vec<Vec<String>> {
    let label = label();
    if cfg!(target_os = "macos") {
        let path = definition_path().map(|p| p.display().to_string()).unwrap_or_default();
        vec![words(&["launchctl", "unload", &path]), words(&["launchctl", "load", "-w", &path])]
    } else if cfg!(target_os = "windows") {
        // The same path the other two registrars are given, not this process's
        // own a second time: Windows keeps no file to read back, so a path
        // that drifts here drifts silently.
        vec![words(&[
            "schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", &label, "/TR",
            &scheduled_command(exe),
        ])]
    } else {
        let unit = format!("{label}.service");
        let user = std::env::var("USER").unwrap_or_default();
        vec![
            words(&["systemctl", "--user", "daemon-reload"]),
            words(&["systemctl", "--user", "enable", "--now", &unit]),
            // Without this a user's services stop when they log out and do not
            // come back until they log in again — so a rebooted machine would
            // sit there with no board on it until somebody sat down at it.
            words(&["loginctl", "enable-linger", &user]),
        ]
    }
}

fn uninstall_steps() -> Vec<Vec<String>> {
    let label = label();
    if cfg!(target_os = "macos") {
        let path = definition_path().map(|p| p.display().to_string()).unwrap_or_default();
        vec![words(&["launchctl", "unload", "-w", &path])]
    } else if cfg!(target_os = "windows") {
        vec![words(&["schtasks", "/Delete", "/F", "/TN", &label])]
    } else {
        let unit = format!("{label}.service");
        vec![words(&["systemctl", "--user", "disable", "--now", &unit])]
    }
}

/// What has to be told the registration is gone, after the file has gone.
fn after_uninstall_steps() -> Vec<Vec<String>> {
    if cfg!(target_os = "linux") {
        vec![words(&["systemctl", "--user", "daemon-reload"])]
    } else {
        vec![]
    }
}

fn status_steps() -> Vec<Vec<String>> {
    let label = label();
    if cfg!(target_os = "macos") {
        vec![words(&["launchctl", "list", &agent_label()])]
    } else if cfg!(target_os = "windows") {
        vec![words(&["schtasks", "/Query", "/TN", &label])]
    } else {
        vec![words(&["systemctl", "--user", "status", "--no-pager", &format!("{label}.service")])]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(port: u16) -> Vec<(String, String)> {
        vec![("ATELIER_PORT".to_string(), port.to_string())]
    }

    #[test]
    fn what_the_shell_had_travels_into_a_thing_that_has_no_shell() {
        // A service inherits nothing at boot. Whatever was set when it was
        // registered has to be written into the definition or it is gone.
        let carried = settings_from(|name| match name {
            "ATELIER_DATA_DIR" => Some("/somewhere/else".to_string()),
            "BEADS_WORKBENCH_PORT" => Some("4009".to_string()),
            _ => None,
        });

        let unit = systemd_unit("/usr/bin/atelier", &carried);
        assert!(unit.contains("Environment=\"ATELIER_DATA_DIR=/somewhere/else\""), "{unit}");
        assert!(unit.contains("Environment=\"BEADS_WORKBENCH_PORT=4009\""), "{unit}");
        assert!(unit.contains("Environment=\"ATELIER_PORT="), "{unit}");
    }

    #[test]
    fn the_places_the_reader_s_own_tools_were_found_travel_too() {
        // The chat helper is started with `node`, its kit fetched with `npm`,
        // the boards read with `bd`. Every one is a bare name looked up on a
        // list, and a service is started by something that never read the
        // reader's shell — so with the list left behind the board comes up
        // with a dead chat and no boards on it (bw-w5zs).
        let carried = settings_from(|name| match name {
            "PATH" => Some("/home/me/.nvm/versions/node/v22/bin:/usr/bin".to_string()),
            _ => None,
        });
        assert!(
            carried.contains(&(
                "PATH".to_string(),
                "/home/me/.nvm/versions/node/v22/bin:/usr/bin".to_string()
            )),
            "{carried:?}"
        );

        let unit = systemd_unit("/usr/bin/atelier", &carried);
        assert!(unit.contains("/home/me/.nvm/versions/node/v22/bin"), "{unit}");
        let plist = launch_agent("/usr/bin/atelier", &carried, "com.weselow.atelier");
        assert!(plist.contains("<key>PATH</key>"), "{plist}");
    }

    #[test]
    fn a_place_with_a_space_in_its_name_stays_one_place() {
        // `Environment=` takes several settings on a line, split on spaces, so
        // an unquoted folder under "My Tools" would arrive as two — the second
        // of them a setting nobody wrote.
        let carried = settings_from(|name| match name {
            "PATH" => Some("/Users/me/My Tools/bin:/usr/bin".to_string()),
            _ => None,
        });
        let unit = systemd_unit("/usr/bin/atelier", &carried);
        assert!(unit.contains("Environment=\"PATH=/Users/me/My Tools/bin:/usr/bin\""), "{unit}");
    }

    #[test]
    fn a_folder_the_reader_named_cannot_write_a_registration_the_machine_refuses() {
        // An ampersand or an angle bracket in a path is text, not a tag. Left
        // as it stands, the machine reads a broken registration, starts
        // nothing, and says nothing the reader can act on.
        let carried = settings_from(|name| match name {
            "ATELIER_DATA_DIR" => Some("/Users/me/R&D/<work>".to_string()),
            _ => None,
        });
        let plist = launch_agent("/usr/bin/atelier", &carried, "com.weselow.atelier");
        assert!(plist.contains("<string>/Users/me/R&amp;D/&lt;work&gt;</string>"), "{plist}");
        assert!(!plist.contains("R&D"), "{plist}");
    }

    #[test]
    fn nothing_that_was_never_set_is_written_down_as_if_it_had_been() {
        let carried = settings_from(|_| None);
        assert_eq!(carried, vec![("ATELIER_PORT".to_string(), crate::command_line::PORT.to_string())]);
    }

    #[test]
    fn a_setting_left_empty_is_not_carried_as_an_empty_one() {
        // An empty data folder written into a unit would resolve against
        // whatever directory the service manager happened to start in.
        let carried = settings_from(|name| if name == "ATELIER_DATA_DIR" { Some("  ".into()) } else { None });
        assert!(!carried.iter().any(|(n, _)| n == "ATELIER_DATA_DIR"), "{carried:?}");
    }

    #[test]
    fn every_registrar_starts_the_one_command_and_opens_no_window() {
        // A thing started at login must not put a browser window over whatever
        // the machine was doing, and it must be the same command a person
        // types — not a second way in that can drift from it.
        let unit = systemd_unit("/usr/bin/atelier", &at(3008));
        assert!(unit.contains("ExecStart=\"/usr/bin/atelier\" run --no-browser"), "{unit}");

        let plist = launch_agent("/usr/bin/atelier", &at(3008), "com.weselow.atelier");
        assert!(plist.contains("<string>run</string>"), "{plist}");
        assert!(plist.contains("<string>--no-browser</string>"), "{plist}");

        assert_eq!(
            scheduled_command(r"C:\Program Files\atelier.exe"),
            "\"C:\\Program Files\\atelier.exe\" run --no-browser"
        );
    }

    #[test]
    fn the_port_is_written_down_at_the_time_it_is_registered() {
        // A service has no shell and inherits nothing, so a port left to be
        // read from the environment would quietly become the default at the
        // next reboot.
        assert!(systemd_unit("/usr/bin/atelier", &at(3456)).contains("Environment=\"ATELIER_PORT=3456\""));
        let plist = launch_agent("/usr/bin/atelier", &at(3456), "com.weselow.atelier");
        assert!(plist.contains("<string>3456</string>"), "{plist}");
    }

    #[test]
    fn a_percent_sign_in_a_folder_name_is_not_read_as_one_of_the_machine_s_own_words() {
        // systemd reads `%h` as the reader's home directory and refuses the
        // whole definition when the letter after a `%` names nothing it knows.
        // Either way the reader gets no board back, over a folder they were
        // free to call whatever they liked.
        let carried = vec![("ATELIER_DATA_DIR".to_string(), "/home/sam/100% mine/data".to_string())];
        let unit = systemd_unit("/usr/bin/atelier", &carried);
        assert!(
            unit.contains("Environment=\"ATELIER_DATA_DIR=/home/sam/100%% mine/data\""),
            "a percent sign reached the definition as one of systemd's own: {unit}"
        );
    }

    #[test]
    fn the_place_the_program_itself_sits_is_read_as_the_reader_typed_it() {
        // The line that starts it is read the same way a setting is: split on
        // spaces, and its percent signs expanded.
        let unit = systemd_unit("/home/sam/my apps/100%/atelier", &at(3008));
        assert!(
            unit.contains("ExecStart=\"/home/sam/my apps/100%%/atelier\" run --no-browser"),
            "the program's own place did not survive being written down: {unit}"
        );
    }

    #[test]
    fn a_program_installed_under_a_path_with_a_space_still_starts() {
        // The whole line is one string on Windows, so an unquoted path under
        // Program Files would try to start `C:\Program`.
        let quoted = scheduled_command(r"C:\Program Files\atelier.exe");
        assert!(quoted.starts_with('"'), "{quoted}");
        assert!(quoted.contains("atelier.exe\" run"), "{quoted}");
    }

    #[test]
    fn the_unit_comes_back_by_itself_however_it_stopped() {
        // Not only when it died. A copy stands down on purpose the moment a
        // newer build is installed over it, and under `on-failure` the
        // computer would take that clean exit at its word and leave the reader
        // with nothing running (bw-8um.3.10.1).
        let unit = systemd_unit("/usr/bin/atelier", &at(3008));
        assert!(unit.contains("Restart=always"), "{unit}");
        let plist = launch_agent("/usr/bin/atelier", &at(3008), "com.weselow.atelier");
        assert!(plist.contains("<key>KeepAlive</key>"), "{plist}");
    }

    #[test]
    fn a_registration_can_be_read_back_to_find_it_is_registered_elsewhere() {
        // The whole point of writing it down is being able to ask later which
        // copy this computer actually starts.
        let unit = systemd_unit("/home/me/.local/bin/atelier", &at(3008));
        assert_eq!(program_in_unit(&unit).as_deref(), Some("/home/me/.local/bin/atelier"));

        let plist = launch_agent("/opt/atelier/atelier", &at(3008), "com.weselow.atelier");
        assert_eq!(program_in_plist(&plist).as_deref(), Some("/opt/atelier/atelier"));
    }

    #[test]
    fn a_registration_written_for_an_awkward_path_reads_back_as_that_path() {
        // Percent signs are doubled and quotes escaped on the way in; reading
        // it back has to undo exactly that, or a reader whose program sits in
        // `100%` is told it is registered somewhere it is not.
        let unit = systemd_unit("/home/sam/my apps/100%/atelier", &at(3008));
        assert_eq!(program_in_unit(&unit).as_deref(), Some("/home/sam/my apps/100%/atelier"));

        let plist = launch_agent("/Users/me/R&D/atelier", &at(3008), "com.weselow.atelier");
        assert_eq!(program_in_plist(&plist).as_deref(), Some("/Users/me/R&D/atelier"));
    }

    #[test]
    fn a_registration_names_the_installed_program_and_not_the_version_it_is_today() {
        // A package manager puts each version in a folder of its own and
        // points one link at the newest. Written down, that link keeps meaning
        // the installed program; the folder behind it is deleted by the very
        // next upgrade, and the computer is left starting nothing at all.
        let on_path = vec![
            ("/usr/local/bin/atelier".to_string(), "/usr/local/bin/atelier".to_string()),
            (
                "/opt/brew/bin/atelier".to_string(),
                "/opt/brew/Cellar/atelier/0.13.1/bin/atelier".to_string(),
            ),
        ];
        assert_eq!(
            worth_registering("/opt/brew/Cellar/atelier/0.13.1/bin/atelier", &on_path),
            "/opt/brew/bin/atelier"
        );
    }

    #[test]
    fn a_registration_names_the_program_itself_when_no_name_leads_to_it() {
        // Run out of a folder that is on nobody's list, its own path is the
        // only name it has — and a copy of some other build sitting on the
        // list is not it.
        let on_path = vec![("/usr/bin/atelier".to_string(), "/usr/bin/atelier".to_string())];
        assert_eq!(worth_registering("/home/me/build/atelier", &on_path), "/home/me/build/atelier");
        assert_eq!(worth_registering("/usr/bin/atelier", &on_path), "/usr/bin/atelier");
        assert_eq!(worth_registering("/usr/bin/atelier", &[]), "/usr/bin/atelier");
    }

    #[test]
    fn handover_is_only_offered_by_a_registration_that_comes_back_however_it_stops() {
        // What this build writes says yes; what an older build wrote says no,
        // and a copy that stood down under it would never come back.
        assert!(unit_comes_back_however_it_stops(&systemd_unit("/usr/bin/atelier", &at(3008))));
        assert!(!unit_comes_back_however_it_stops(
            "[Service]\nExecStart=\"/usr/bin/atelier\" run\nRestart=on-failure\n"
        ));
        assert!(!unit_comes_back_however_it_stops("[Service]\nExecStart=\"/usr/bin/atelier\" run\n"));

        assert!(agent_comes_back_however_it_stops(&launch_agent(
            "/usr/bin/atelier",
            &at(3008),
            "com.weselow.atelier"
        )));
        assert!(!agent_comes_back_however_it_stops(
            "<dict><key>KeepAlive</key><false/></dict>"
        ));
        assert!(!agent_comes_back_however_it_stops("<dict></dict>"));
    }

    #[test]
    fn nothing_is_read_back_out_of_a_registration_that_names_no_program() {
        assert!(program_in_unit("[Service]\nType=simple\n").is_none());
        assert!(program_in_plist("<plist><dict></dict></plist>").is_none());
    }

    #[test]
    fn systemd_unit_starts_with_the_desktop_rather_than_before_it() {
        let unit = systemd_unit("/usr/bin/atelier", &at(3008));
        assert!(unit.contains("After=network.target graphical-session.target"));
        assert!(unit.contains("WantedBy=graphical-session.target"));
        assert!(!unit.contains("WantedBy=default.target"));
    }

    #[test]
    fn launch_agent_starts_at_login_rather_than_waiting_to_be_asked() {
        assert!(launch_agent("/usr/bin/atelier", &at(3008), "x").contains("<key>RunAtLoad</key>"));
    }

    #[test]
    fn a_name_that_would_not_survive_the_platform_is_cleaned_up() {
        // A slash is a path on Linux and a space is two arguments on Windows.
        assert_eq!(sanitised("atelier/two"), "atelier-two");
        assert_eq!(sanitised("my atelier"), "my-atelier");
        assert_eq!(sanitised("atelier-check.2"), "atelier-check.2");
        assert_eq!(sanitised(""), NAME);
    }

    #[test]
    fn the_agent_is_filed_under_the_same_reverse_domain_as_the_data() {
        // One name, from one place — the folder the data goes in and the
        // registration cannot drift apart.
        assert!(agent_label().starts_with(&format!("{QUALIFIER}.{ORGANISATION}.")));
    }

    #[test]
    fn installing_and_taking_it_off_name_the_same_registration() {
        // A mismatch here leaves a running copy nobody can name any more.
        let named = |steps: Vec<Vec<String>>| {
            steps.iter().flatten().any(|w| w.contains(&label()))
        };
        assert!(named(install_steps("/usr/bin/atelier")), "the install names no registration");
        assert!(named(uninstall_steps()), "taking it off names no registration");
        assert!(named(status_steps()), "asking after it names no registration");
    }

    #[test]
    fn the_linux_definition_follows_the_home_it_is_given() {
        // The check registers a second copy under a home of its own, and a
        // path worked out from anything but that home would write into the
        // reader's real one.
        let unit = systemd_dir().expect("a machine running tests has a home");
        assert!(unit.ends_with("systemd/user"), "{unit:?}");
    }
}
