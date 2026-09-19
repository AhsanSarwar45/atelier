//! Reaching the board from somewhere that is not this network.
//!
//! The board answers this network already. Reaching it from a café is a
//! different thing, and the way that used to be written down was a page of
//! shell commands: install a package, enable a daemon, hand operation to a
//! user, run a proxy, then set two environment variables so the app would
//! admit what address it was now reachable at. Every one of those is a place
//! to get it wrong, and none of them are things a person using a board should
//! have to hold (bw-hdor).
//!
//! So the work is split by what it costs. Installing needs a password, and a
//! password needs a terminal, so that part is a command a person runs once.
//! Everything after it — turning reaching-from-away on and off, and knowing
//! whether it is on — needs no password at all, because the install hands
//! operation to this user, and so it can be a switch on a screen.
//!
//! What stands in front is Tailscale: a private network of the devices you
//! sign in, rather than a published address. The board is reachable because
//! the phone is on that network, not because the board is exposed — which
//! matters more here than in most apps, because this program has no password
//! of its own and its API writes files and starts agents. It also settles the
//! secure origin a phone needs before it will hold a notification at all.
//!
//! The parts that decide are pure and tested without a network: what the
//! daemon's own report means, and what would be run to install it here.

use serde::Deserialize;

/// The name of the program this stands on.
pub const TAILSCALE: &str = "tailscale";

/// How far along this computer is, and so what is left to do.
///
/// One case per thing that can be missing, because each has a different
/// answer and a reader who is told only "not working" has to go and find out
/// which of five things it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Standing {
    /// Nothing installed. `atelier remote install` is the whole of the fix.
    NotInstalled,
    /// Installed, but its daemon is not answering — not started, or this user
    /// may not talk to it because operation was never handed over.
    NotAnswering { said: String },
    /// Answering, but this computer has not joined a network yet.
    NeedsSignIn,
    /// Joined, but switched off. `tailscale up` is the fix.
    Stopped,
    /// On its way up. Nothing to do but ask again.
    Starting,
    /// Up and joined, but with no name on the network, so there is no address
    /// to give a phone. MagicDNS is off in the admin console.
    Unnamed,
    /// Everything is in place, and this is the address a phone opens.
    Ready { address: String },
}

impl Standing {
    /// Whether serving can be turned on from here with no further setup.
    pub fn is_ready(&self) -> bool {
        matches!(self, Standing::Ready { .. })
    }

    /// What is wrong, in the reader's terms, and `None` when nothing is.
    pub fn wrong(&self) -> Option<String> {
        Some(match self {
            Standing::NotInstalled => {
                "Tailscale is not installed. Run `atelier remote install` in a terminal."
                    .to_string()
            }
            Standing::NotAnswering { said } => format!(
                "Tailscale is not responding. Run `atelier remote install` in a terminal. \
                 Details: {said}"
            ),
            Standing::NeedsSignIn => {
                "This computer is not connected to Tailscale. Run `tailscale up` and sign in."
                    .to_string()
            }
            Standing::Stopped => {
                "Tailscale is off. Run `tailscale up`."
                    .to_string()
            }
            Standing::Starting => "Tailscale is still starting up.".to_string(),
            Standing::Unnamed => {
                "No Tailscale hostname is available. Enable MagicDNS in the Tailscale admin console."
                    .to_string()
            }
            Standing::Ready { .. } => return None,
        })
    }
}

/// What the daemon reports, of which this needs two fields.
#[derive(Deserialize)]
struct Reported {
    #[serde(rename = "BackendState")]
    backend_state: Option<String>,
    #[serde(rename = "Self")]
    this_computer: Option<Named>,
}

#[derive(Deserialize)]
struct Named {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(rename = "TailscaleIPs")]
    addresses: Option<Vec<String>>,
}

/// What this machine is called, and answers to, on the tailnet.
///
/// Read by the guard in `local_host.rs`: a phone that came in over Tailscale
/// states a name and an address this machine has no other way of knowing are
/// its own, and a guard built on an allowlist of what this machine is cannot
/// admit them until it is told (bw-ndlu.4).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct OnTheTailnet {
    /// The full MagicDNS name, lowercased, with the root dot off.
    pub name: Option<String>,
    /// Every address the daemon hands this machine, as text.
    pub addresses: Vec<String>,
}

/// What the daemon's report says this machine is on the tailnet.
///
/// Pure, so the shape of a real report is tested without a daemon. An absent
/// or unreadable report is an empty answer rather than a guess: the guard's
/// other rules still stand, and admitting nothing is the safe failure.
pub fn on_the_tailnet_from(said: &str) -> OnTheTailnet {
    let Ok(reported) = serde_json::from_str::<Reported>(said) else {
        return OnTheTailnet::default();
    };
    // Only a running daemon's names mean anything. A stopped one still reports
    // the name it last held, and this machine does not answer to it now.
    if reported.backend_state.as_deref() != Some("Running") {
        return OnTheTailnet::default();
    }
    let Some(this_computer) = reported.this_computer else {
        return OnTheTailnet::default();
    };
    OnTheTailnet {
        name: this_computer
            .dns_name
            .map(|name| name.trim().trim_end_matches('.').to_ascii_lowercase())
            .filter(|name| !name.is_empty()),
        addresses: this_computer
            .addresses
            .unwrap_or_default()
            .into_iter()
            .map(|address| address.trim().to_string())
            .filter(|address| !address.is_empty())
            .collect(),
    }
}

/// The same, asked of the daemon now.
pub fn on_the_tailnet() -> OnTheTailnet {
    let Some(program) = looked_up() else {
        return OnTheTailnet::default();
    };
    let reading = standing_reading();
    let Ok(out) = std::process::Command::new(program).args(&reading[1..]).output() else {
        return OnTheTailnet::default();
    };
    on_the_tailnet_from(&String::from_utf8_lossy(&out.stdout))
}

/// What `tailscale status --json` said, read into the one question asked of
/// it: can a phone somewhere else open this board, and if not, why not.
///
/// Anything unreadable is `NotAnswering` rather than a panic or a guess. This
/// runs behind a screen that has to say something true, and "it said
/// something I could not read" is true.
pub fn standing_from(said: &str) -> Standing {
    let Ok(reported) = serde_json::from_str::<Reported>(said) else {
        return Standing::NotAnswering {
            said: first_line(said),
        };
    };
    match reported.backend_state.as_deref() {
        Some("Running") => match name_of(reported.this_computer) {
            Some(address) => Standing::Ready { address },
            None => Standing::Unnamed,
        },
        Some("Stopped") => Standing::Stopped,
        Some("Starting") => Standing::Starting,
        // `NoState` is a daemon that has come up and been told nothing yet,
        // which for a reader is the same errand as never having signed in.
        Some("NeedsLogin") | Some("NeedsMachineAuth") | Some("NoState") => Standing::NeedsSignIn,
        Some(other) => Standing::NotAnswering {
            said: other.to_string(),
        },
        None => Standing::NotAnswering {
            said: first_line(said),
        },
    }
}

/// The address a phone opens, from the name this computer answers to.
///
/// The name arrives as a fully qualified one, with the dot on the end that
/// makes it absolute. That dot is correct and belongs in a resolver; in a
/// browser bar it is noise, and in a printed line it reads like a typo.
fn name_of(this_computer: Option<Named>) -> Option<String> {
    let name = this_computer?.dns_name?;
    let name = name.trim().trim_end_matches('.');
    match name.is_empty() {
        true => None,
        false => Some(format!("https://{name}")),
    }
}

/// The first line of something that was not the answer expected, for showing
/// a reader without pasting a page of it onto their screen.
fn first_line(said: &str) -> String {
    said.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("nothing at all")
        .chars()
        .take(200)
        .collect()
}

/// A package manager this knows how to ask.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Manager {
    /// The program to run.
    pub program: &'static str,
    /// The words that install a named package without asking again.
    pub install: &'static [&'static str],
}

/// The managers looked for, in the order they are tried.
pub const MANAGERS: &[Manager] = &[
    Manager { program: "dnf", install: &["install", "-y"] },
    Manager { program: "apt-get", install: &["install", "-y"] },
    Manager { program: "pacman", install: &["-S", "--noconfirm"] },
    Manager { program: "zypper", install: &["install", "-y"] },
];

/// Where a reader gets it when this cannot install it for them.
pub const DOWNLOAD: &str = "https://tailscale.com/download";

/// Everything that would be run to install it here, in order.
///
/// Handing operation to this user is the step that makes the switch on the
/// settings screen possible at all: without it every later `tailscale serve`
/// would need a password, and a screen has nowhere to type one. It is done
/// with `up --operator` rather than `set --operator`, which Tailscale's own
/// error message suggests and which does not work
/// (github.com/tailscale/tailscale/issues/18294).
///
/// `None` when there is no manager here it knows, because half-installing
/// something and then saying so is worse than naming the download page.
pub fn install_plan(manager: Option<Manager>, user: &str) -> Option<Vec<Vec<String>>> {
    let manager = manager?;
    let mut install = vec!["sudo".to_string(), manager.program.to_string()];
    install.extend(manager.install.iter().map(|word| word.to_string()));
    install.push(TAILSCALE.to_string());
    Some(vec![
        install,
        words(&["sudo", "systemctl", "enable", "--now", "tailscaled"]),
        vec![
            "sudo".to_string(),
            TAILSCALE.to_string(),
            "up".to_string(),
            format!("--operator={user}"),
        ],
    ])
}

/// The door Tailscale is told to forward to, written once so the command
/// that starts serving and the reading that checks whether it is being served
/// cannot disagree about the spelling.
fn target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// The command that starts serving the board at the address in front.
///
/// `--bg` because it has to outlive the command that asked for it, and
/// `127.0.0.1` because what is being handed to the network is this proxy's
/// door and not the program's own.
pub fn serve_on(port: u16) -> Vec<String> {
    vec![
        TAILSCALE.to_string(),
        "serve".to_string(),
        "--bg".to_string(),
        "--https=443".to_string(),
        target(port),
    ]
}

/// The command that stops it.
pub fn serve_off() -> Vec<String> {
    words(&[TAILSCALE, "serve", "--https=443", "off"])
}

/// The command that says what is being served, as something readable.
pub fn serve_reading() -> Vec<String> {
    words(&[TAILSCALE, "serve", "status", "--json"])
}

/// The command that reports how far along this computer is.
pub fn standing_reading() -> Vec<String> {
    words(&[TAILSCALE, "status", "--json"])
}

fn words(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

/// What a person asked of `atelier remote`.
#[derive(Debug, PartialEq, Eq)]
pub enum Ask {
    /// Say how far along this computer is and change nothing.
    Standing,
    /// Do the part that needs a password.
    Install { without_asking: bool },
}

/// Where this computer holds Tailscale, if it holds it.
///
/// A "no" is never taken from memory. Every lookup in the app remembers its
/// answer for the life of the process, which is right for a tool that was
/// there at startup and wrong for this one: the whole point of `atelier
/// remote install` is that Tailscale arrives while something is already
/// running. Without this, the command reporting on itself the moment after it
/// installed Tailscale said it was not installed — it was repeating the
/// answer it took before it ran — and the settings screen of an app started
/// before the install said the same until a restart (bw-l70z).
///
/// Only the "no" is looked at again. A "yes" cannot go stale in a way that
/// matters: a Tailscale deleted out from under us fails where it is run, with
/// a sentence saying so, rather than being quietly reported as absent.
pub fn looked_up() -> Option<std::path::PathBuf> {
    asked_twice(
        || crate::routes::find_tool(TAILSCALE, &[]),
        || crate::routes::forget_tool(TAILSCALE),
    )
}

/// Look; and if the answer is no, drop what was remembered and look once more.
///
/// Split out from its one caller so the sequence can be put to a test without
/// a Tailscale to install halfway through it.
fn asked_twice(
    find: impl Fn() -> Option<std::path::PathBuf>,
    forget: impl FnOnce(),
) -> Option<std::path::PathBuf> {
    if let Some(path) = find() {
        return Some(path);
    }
    forget();
    find()
}

/// How far along this computer is, asked of the daemon now.
pub fn standing() -> Standing {
    let Some(program) = looked_up() else {
        return Standing::NotInstalled;
    };
    let reading = standing_reading();
    let out = match std::process::Command::new(program).args(&reading[1..]).output() {
        Ok(out) => out,
        Err(e) => return Standing::NotAnswering { said: e.to_string() },
    };
    // A daemon that is not running, and a user who was never handed
    // operation, both complain on the error stream and print nothing on the
    // other one. Reading only stdout would turn both into "unreadable".
    let said = String::from_utf8_lossy(&out.stdout);
    match said.trim().is_empty() {
        false => standing_from(&said),
        true => Standing::NotAnswering {
            said: first_line(&String::from_utf8_lossy(&out.stderr)),
        },
    }
}

/// The first package manager on this computer that this knows how to ask.
pub fn manager_here() -> Option<Manager> {
    MANAGERS
        .iter()
        .find(|manager| crate::routes::find_tool(manager.program, &[]).is_some())
        .copied()
}

/// Answer `atelier remote`.
pub fn run(ask: Ask) -> Result<(), String> {
    match ask {
        Ask::Standing => {
            say_standing();
            Ok(())
        }
        Ask::Install { without_asking } => install(without_asking),
    }
}

/// Print how far along this computer is, and what is left to do about it.
fn say_standing() {
    let standing = standing();
    match standing.wrong() {
        None => {
            if let Standing::Ready { address } = &standing {
                println!("Remote address: {address}");
                println!("Enable it in Settings > Remote access.");
            }
        }
        Some(wrong) => println!("{wrong}"),
    }
}

/// Install Tailscale, start its daemon, and hand operation to this user.
///
/// This is the one part that needs a password, which is the only reason it is
/// a command rather than a switch: a screen has nowhere to type one. Every
/// step is printed before any of them is run, because a reader about to type
/// their password is owed the list of what it is for.
fn install(without_asking: bool) -> Result<(), String> {
    if let Some(path) = looked_up() {
        println!("Tailscale is already installed at {}.", path.display());
        say_standing();
        return Ok(());
    }
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .map_err(|_| "Could not determine the current user")?;
    let Some(plan) = install_plan(manager_here(), &user) else {
        return Err(format!(
            "No supported package manager found. Install Tailscale from {DOWNLOAD}"
        ));
    };

    println!("Commands to run (password required):");
    for step in &plan {
        println!("  {}", step.join(" "));
    }
    println!();
    println!("Tailscale access will be assigned to {user}.");
    if !without_asking && !agreed()? {
        println!("Cancelled.");
        return Ok(());
    }
    for step in &plan {
        println!();
        println!("$ {}", step.join(" "));
        run_letting_it_ask(step)?;
    }
    println!();
    say_standing();
    Ok(())
}

/// Whether the reader said yes.
fn agreed() -> Result<bool, String> {
    use std::io::Write;
    print!("Go ahead? [y/N] ");
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    let mut said = String::new();
    std::io::stdin()
        .read_line(&mut said)
        .map_err(|e| format!("Could not read from the terminal: {e}"))?;
    Ok(matches!(said.trim().to_lowercase().as_str(), "y" | "yes"))
}

/// One step, run with this program's own terminal.
///
/// Its output is not captured. `sudo` asks for a password on the terminal it
/// was started from, and a captured one is a terminal the reader cannot see
/// or type into — the command would sit there looking hung until it timed
/// out.
fn run_letting_it_ask(step: &[String]) -> Result<(), String> {
    let (program, args) = step.split_first().ok_or("an empty command")?;
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("{program} could not be run: {e}"))?;
    match status.success() {
        true => Ok(()),
        false => Err(format!("`{}` did not finish", step.join(" "))),
    }
}

/// Whether Tailscale is already putting this app's port on the tailnet.
///
/// Read out of `tailscale serve status --json` by looking for the address it
/// was told to forward to. The shape of that reading has changed between
/// Tailscale versions and the proxy target is the one part of it that has
/// not, so this looks for that rather than walking a tree of keys that a
/// later version may rename underneath us.
pub fn serving_from(said: &str, port: u16) -> bool {
    said.contains(&target(port))
}

/// Whether this app's port is being served right now.
pub fn serving_now(port: u16) -> bool {
    let Some(program) = looked_up() else {
        return false;
    };
    let reading = serve_reading();
    std::process::Command::new(program)
        .args(&reading[1..])
        .output()
        .map(|out| serving_from(&String::from_utf8_lossy(&out.stdout), port))
        .unwrap_or(false)
}

/// Start or stop serving this app's port, and say what went wrong if it did.
///
/// This needs no password: `remote install` handed operation to this user, so
/// the switch on the settings screen can call it directly.
pub fn set_serving(on: bool, port: u16) -> Result<(), String> {
    let program = looked_up().ok_or_else(|| {
        format!("Tailscale is not installed. Run `atelier remote install`, or install it from {DOWNLOAD}.")
    })?;
    // Turning it on with the daemon down would leave the switch saying on
    // and nothing reachable, which is the one answer worse than a refusal.
    if on {
        if let Some(wrong) = standing().wrong() {
            return Err(wrong);
        }
    }
    let step = match on {
        true => serve_on(port),
        false => serve_off(),
    };
    let out = std::process::Command::new(program)
        .args(&step[1..])
        .output()
        .map_err(|e| format!("Tailscale could not be run: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let said = first_line(&String::from_utf8_lossy(&out.stderr));
    Err(match said.is_empty() {
        true => format!("`{}` did not finish.", step.join(" ")),
        false => format!("Tailscale refused: {said}"),
    })
}

/// Whether the switch on the settings screen was left on.
///
/// What is actually being served is read from Tailscale and never from here.
/// This is only what the app puts back the next time it starts, and the record
/// of whose serving it is to take down when it stops.
pub const SERVING_SETTING: &str = "remote.serving";

/// Whether the reader left reaching-from-away switched on.
///
/// Read straight out of the settings file rather than through the open
/// database, because the shutdown path runs after the app has begun taking
/// itself apart and there is nothing left there to ask.
pub fn asked_for() -> bool {
    crate::db::setting_at_rest(SERVING_SETTING).is_some()
}

/// Put serving back the way it was left, when the app starts.
///
/// Doing nothing loudly rather than failing: the app coming up is not
/// conditional on a mesh network being reachable, and a person who cannot
/// reach it from away can open the settings screen to find out why. What is
/// drawn there is read from Tailscale, so it will say so.
pub fn follow_the_app_up(port: u16) {
    if !asked_for() {
        return;
    }
    if serving_now(port) {
        return;
    }
    match set_serving(true, port) {
        Ok(()) => tracing::info!("reachable from away: serving port {port} on the tailnet"),
        Err(why) => tracing::warn!("reaching this from away is switched on but did not start: {why}"),
    }
}

/// Stop serving as the app goes down.
///
/// Leaving it up is the failure this exists to stop: the address would go on
/// answering, from anywhere, with whatever a connection to a dead port looks
/// like — and a reader who saw it answer yesterday has no way to tell that
/// apart from the app being broken.
///
/// Only when the setting says the serving is ours. Somebody who ran
/// `tailscale serve` themselves is owed having it left alone.
pub fn follow_the_app_down(port: u16) {
    if !asked_for() {
        return;
    }
    match set_serving(false, port) {
        Ok(()) => tracing::info!("reachable from away: stopped serving port {port}"),
        Err(why) => tracing::warn!("serving port {port} could not be stopped: {why}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A "no" from before the install is not the answer given after it.
    ///
    /// This is the sequence `atelier remote install` runs: it asks whether
    /// Tailscale is here, is told no, installs it, and asks again. The second
    /// answer has to come from the computer and not from the first one, which
    /// is what it did — the command finished a successful install by saying
    /// Tailscale was not installed (bw-l70z).
    #[test]
    fn a_tailscale_that_arrived_since_the_last_look_is_not_reported_missing() {
        use std::cell::Cell;
        use std::path::PathBuf;

        let dropped = Cell::new(false);
        let here = PathBuf::from("/usr/bin/tailscale");
        // Stands in for the memo: nothing until it is dropped, and the real
        // answer once it has been.
        let find = || dropped.get().then(|| here.clone());

        assert_eq!(
            asked_twice(find, || dropped.set(true)),
            Some(here.clone()),
            "the answer from before the install was handed back after it"
        );
    }

    /// A yes is taken as it is, and nothing is dropped to get it.
    #[test]
    fn a_tailscale_that_is_already_there_is_not_looked_for_twice() {
        use std::cell::Cell;
        use std::path::PathBuf;

        let here = PathBuf::from("/usr/bin/tailscale");
        let dropped = Cell::new(false);

        assert_eq!(asked_twice(|| Some(here.clone()), || dropped.set(true)), Some(here));
        assert!(!dropped.get(), "a working answer was thrown away for no reason");
    }

    /// What is being served is read by the address it forwards to.
    ///
    /// A reading for somebody else's port is not this app's; the switch would
    /// otherwise draw itself on because a neighbour is served (bw-hdor.3).
    #[test]
    fn a_reading_for_another_port_is_not_read_as_this_one_being_served() {
        let said = r#"{"Web":{"desk.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3008"}}}}}"#;
        assert!(serving_from(said, 3008));
        assert!(!serving_from(said, 3009));
        assert!(!serving_from("{}", 3008));
    }

    #[test]
    fn what_this_machine_is_on_the_tailnet_is_read_from_the_report() {
        // The guard in local_host.rs admits exactly these, so a phone that came
        // in over Tailscale is answered rather than refused (bw-ndlu.4).
        let said = r#"{"BackendState":"Running","Self":{"DNSName":"Nobara.tail1a2b.ts.net.","TailscaleIPs":["100.70.11.94","fd7a:115c:a1e0::1701:b5e"]}}"#;
        let it = on_the_tailnet_from(said);
        assert_eq!(it.name.as_deref(), Some("nobara.tail1a2b.ts.net"), "the root dot and the case belong to DNS, not to the allowlist");
        assert_eq!(it.addresses, vec!["100.70.11.94", "fd7a:115c:a1e0::1701:b5e"]);
    }

    #[test]
    fn a_daemon_that_is_not_running_says_this_machine_is_nowhere() {
        // It still reports the name it last held, and this machine does not
        // answer to it now, so admitting it would outlive the tailnet.
        let stopped = r#"{"BackendState":"Stopped","Self":{"DNSName":"nobara.tail1a2b.ts.net.","TailscaleIPs":["100.70.11.94"]}}"#;
        assert_eq!(on_the_tailnet_from(stopped), OnTheTailnet::default());
        assert_eq!(on_the_tailnet_from("tailscale: command not found"), OnTheTailnet::default());
        assert_eq!(on_the_tailnet_from(""), OnTheTailnet::default());
    }

    #[test]
    fn a_computer_that_is_up_and_named_gives_the_address_a_phone_opens() {
        let said = r#"{"BackendState":"Running","Self":{"DNSName":"nobara.tail1a2b.ts.net."}}"#;
        assert_eq!(
            standing_from(said),
            Standing::Ready { address: "https://nobara.tail1a2b.ts.net".to_string() }
        );
        assert!(standing_from(said).is_ready());
        assert_eq!(standing_from(said).wrong(), None);
    }

    #[test]
    fn the_dot_that_makes_the_name_absolute_is_not_shown_to_a_reader() {
        // It is correct in a resolver and reads as a typo in a browser bar.
        let said = r#"{"BackendState":"Running","Self":{"DNSName":"nobara.tail1a2b.ts.net."}}"#;
        let Standing::Ready { address } = standing_from(said) else {
            panic!("a named, running computer was not read as ready");
        };
        assert!(!address.ends_with('.'), "{address} ends with the absolute dot");
        assert!(address.starts_with("https://"), "{address} is not a secure origin");
    }

    #[test]
    fn each_thing_that_can_be_missing_is_told_apart_from_the_others() {
        // The whole point of the enum: a reader gets the one errand they
        // actually have, not "remote access is not working".
        let cases = [
            (r#"{"BackendState":"NeedsLogin"}"#, Standing::NeedsSignIn),
            (r#"{"BackendState":"NeedsMachineAuth"}"#, Standing::NeedsSignIn),
            (r#"{"BackendState":"NoState"}"#, Standing::NeedsSignIn),
            (r#"{"BackendState":"Stopped"}"#, Standing::Stopped),
            (r#"{"BackendState":"Starting"}"#, Standing::Starting),
            (r#"{"BackendState":"Running"}"#, Standing::Unnamed),
        ];
        for (said, expected) in cases {
            assert_eq!(standing_from(said), expected, "{said}");
            assert!(
                standing_from(said).wrong().is_some(),
                "{said} was read as nothing being wrong"
            );
            assert!(!standing_from(said).is_ready(), "{said}");
        }
    }

    #[test]
    fn a_running_computer_with_an_empty_name_has_no_address_to_offer() {
        let said = r#"{"BackendState":"Running","Self":{"DNSName":"  "}}"#;
        assert_eq!(standing_from(said), Standing::Unnamed);
    }

    #[test]
    fn something_unreadable_is_reported_as_unreadable_rather_than_guessed_at() {
        // What a daemon that is not running actually prints, and what a
        // permission refusal prints, are both prose rather than JSON.
        for said in [
            "failed to connect to local tailscaled; it doesn't appear to be running",
            "Access denied: this operation requires operator access",
            "",
            "{",
        ] {
            let standing = standing_from(said);
            assert!(
                matches!(standing, Standing::NotAnswering { .. }),
                "{said:?} was read as {standing:?}"
            );
            assert!(standing.wrong().is_some());
        }
    }

    #[test]
    fn a_long_complaint_is_cut_before_it_fills_the_screen() {
        let said = "x".repeat(5000);
        let Standing::NotAnswering { said } = standing_from(&said) else {
            panic!("a wall of text was not read as unreadable");
        };
        assert!(said.chars().count() <= 200, "{} characters", said.chars().count());
    }

    #[test]
    fn the_plan_installs_starts_and_hands_over_in_that_order() {
        let plan = install_plan(Some(MANAGERS[0]), "ahsan").expect("dnf is a manager it knows");
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0], vec!["sudo", "dnf", "install", "-y", "tailscale"]);
        assert_eq!(plan[1], vec!["sudo", "systemctl", "enable", "--now", "tailscaled"]);
        // The step the switch on the settings screen depends on. `set
        // --operator` is what Tailscale's own error suggests and it does not
        // work, so this must stay `up --operator`.
        assert_eq!(plan[2], vec!["sudo", "tailscale", "up", "--operator=ahsan"]);
    }

    #[test]
    fn every_manager_it_knows_produces_a_plan_that_names_the_package() {
        for manager in MANAGERS {
            let plan = install_plan(Some(*manager), "ahsan").expect("a plan");
            assert!(
                plan[0].last().map(String::as_str) == Some(TAILSCALE),
                "{} installs something else: {:?}",
                manager.program,
                plan[0]
            );
            assert_eq!(plan[0][0], "sudo", "{} is not asked for with a password", manager.program);
        }
    }

    #[test]
    fn a_computer_with_no_manager_it_knows_gets_no_half_install() {
        assert!(install_plan(None, "ahsan").is_none());
    }

    #[test]
    fn what_is_served_is_the_proxys_door_and_not_the_programs_own() {
        // The program keeps answering only itself; what the network is given
        // is Tailscale's side. Serving 0.0.0.0 here would defeat closing the
        // door in settings.
        let on = serve_on(3008);
        assert!(on.contains(&"http://127.0.0.1:3008".to_string()), "{on:?}");
        assert!(on.contains(&"--bg".to_string()), "it would die with the command: {on:?}");
        assert!(serve_off().contains(&"off".to_string()));
        // On and off must name the same door, or turning it off leaves it on.
        assert!(on.contains(&"--https=443".to_string()));
        assert!(serve_off().contains(&"--https=443".to_string()));
    }
}
