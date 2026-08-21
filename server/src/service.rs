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
const CARRIED: [&str; 3] = ["ATELIER_HOST", "ATELIER_DATA_DIR", "BEADS_WORKBENCH_PORT"];

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

/// The systemd user unit.
///
/// A user unit rather than a system one: writing into `/etc` needs a password,
/// and a board with one person's projects in it belongs to that person's
/// session. Starting before anybody logs in is what lingering is for, which
/// `install` turns on.
pub fn systemd_unit(exe: &str, carried: &[(String, String)]) -> String {
    let args = STARTED_AS.join(" ");
    let environment: String = carried
        .iter()
        .map(|(name, value)| format!("Environment={name}={value}\n"))
        .collect();
    format!(
        "[Unit]\n\
         Description={DISPLAY} — the board, the screens and the chat\n\
         After=network.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         {environment}\
         ExecStart={exe} {args}\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
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
        .map(|(name, value)| format!("\x20   <key>{name}</key>\n\x20   <string>{value}</string>\n"))
        .collect();
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

/// Carry out what the reader asked, printing what happened.
pub fn run(action: Action) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("this program cannot find its own path, so nothing can be registered to start it: {e}"))?;
    let exe = exe.display().to_string();
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

    for step in install_steps() {
        say(&step)?;
    }

    println!(
        "{DISPLAY} will start with this computer and serve http://localhost:{port}"
    );
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

fn install_steps() -> Vec<Vec<String>> {
    let label = label();
    if cfg!(target_os = "macos") {
        let path = definition_path().map(|p| p.display().to_string()).unwrap_or_default();
        vec![words(&["launchctl", "unload", &path]), words(&["launchctl", "load", "-w", &path])]
    } else if cfg!(target_os = "windows") {
        let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
        vec![words(&[
            "schtasks", "/Create", "/F", "/SC", "ONLOGON", "/TN", &label, "/TR",
            &scheduled_command(&exe),
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
        assert!(unit.contains("Environment=ATELIER_DATA_DIR=/somewhere/else"), "{unit}");
        assert!(unit.contains("Environment=BEADS_WORKBENCH_PORT=4009"), "{unit}");
        assert!(unit.contains("Environment=ATELIER_PORT="), "{unit}");
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
        assert!(unit.contains("ExecStart=/usr/bin/atelier run --no-browser"), "{unit}");

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
        assert!(systemd_unit("/usr/bin/atelier", &at(3456)).contains("Environment=ATELIER_PORT=3456"));
        let plist = launch_agent("/usr/bin/atelier", &at(3456), "com.weselow.atelier");
        assert!(plist.contains("<string>3456</string>"), "{plist}");
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
    fn the_unit_comes_back_by_itself_when_it_dies() {
        let unit = systemd_unit("/usr/bin/atelier", &at(3008));
        assert!(unit.contains("Restart=on-failure"), "{unit}");
        let plist = launch_agent("/usr/bin/atelier", &at(3008), "com.weselow.atelier");
        assert!(plist.contains("<key>KeepAlive</key>"), "{plist}");
    }

    #[test]
    fn it_starts_at_login_rather_than_waiting_to_be_asked() {
        assert!(systemd_unit("/usr/bin/atelier", &at(3008)).contains("WantedBy=default.target"));
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
        assert!(named(install_steps()), "the install names no registration");
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
