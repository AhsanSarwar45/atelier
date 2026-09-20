//! Where this program can be opened, in the words a person types.
//!
//! It has always listened on every address this computer has, so a phone on
//! the same network could reach it — but the only address it ever printed was
//! `localhost`, which on a phone is the phone. Whoever wanted the board in
//! their hand had to go and find this machine's address themselves, and had no
//! way of telling whether the app was even willing to answer them (bw-hkai.1).
//!
//! The number that got printed is a lease, though: the router is free to hand
//! this computer a different one after it restarts, and a person who wrote the
//! old one on a note is then typing an address that reaches nothing — or worse,
//! reaches whichever machine took it over. So the name this computer answers to
//! goes first, because that one follows the computer (bw-sxdg.1).
//!
//! The rule that turns a bind address into the lines to print is pure, so it
//! is read and tested without a socket. The few things that must ask the
//! operating system are kept beside it and do nothing else.

use std::net::{IpAddr, ToSocketAddrs, UdpSocket};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// This computer's address on the network it is really connected to.
///
/// Connecting a UDP socket sends no packet at all: it only asks the operating
/// system which route it would take, and the near end of that route is the
/// address another device on that network reaches us at. That is why this
/// needs no dependency and no walk over the machine's interfaces, and why it
/// gives the right answer on a machine that has several.
///
/// `None` when the computer has no route out — an unusual state, and the
/// caller then says so rather than printing an address nothing would answer.
pub fn on_this_network() -> Option<IpAddr> {
    // Reserved for documentation and routed to by nobody. Nothing is sent to
    // it; it is a direction, not a destination.
    for direction in ["203.0.113.1:80", "8.8.8.8:80"] {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if socket.connect(direction).is_ok() {
            if let Ok(local) = socket.local_addr() {
                if !local.ip().is_loopback() && !local.ip().is_unspecified() {
                    return Some(local.ip());
                }
            }
        }
    }
    None
}

/// The name this computer answers to on its own network, when it really does.
///
/// Nothing is published here. macOS, Windows and any Linux running avahi
/// already answer to `<name>.local` on the local network, and this only asks
/// whether that is working on this machine. Where it is not, the answer is
/// `None` and the number gets printed exactly as it did before.
///
/// The name is kept only when it resolves to the address another device would
/// reach this computer at. A name that resolves somewhere else belongs to
/// somebody else's machine, and sending a phone there is worse than sending it
/// to a number that at least was right this morning.
pub fn name_on_this_network(network: Option<IpAddr>) -> Option<String> {
    let name = local_name(&this_computer_is_called()?)?;
    let found = resolved(&name)?;
    is_this_computer(&found, network).then_some(name)
}

/// What this computer calls itself, asked of the operating system.
fn this_computer_is_called() -> Option<String> {
    if let Ok(windows) = std::env::var("COMPUTERNAME") {
        if !windows.trim().is_empty() {
            return Some(windows);
        }
    }
    let said = std::process::Command::new("hostname").output().ok()?;
    let said = String::from_utf8(said.stdout).ok()?;
    let said = said.trim().to_string();
    (!said.is_empty()).then_some(said)
}

/// The `.local` name built from whatever the computer calls itself.
///
/// Only the first part of the name is used: a computer that already carries a
/// domain answers on the local network under its bare name, and gluing the two
/// together would make a name nothing has ever heard of.
fn local_name(called: &str) -> Option<String> {
    let first = called.trim().trim_end_matches('.');
    let first = first.split('.').next().unwrap_or(first);
    (!first.is_empty()).then(|| format!("{}.local", first.to_lowercase()))
}

/// The addresses a name resolves to here, or `None` if no answer came back
/// quickly.
///
/// The lookup runs on its own thread under a bounded wait. A machine with
/// nothing answering multicast can leave a `.local` lookup sitting on a
/// timeout for seconds, and starting the app must never wait on that. A slow
/// answer counts as no answer, and the number is printed instead.
fn resolved(name: &str) -> Option<Vec<IpAddr>> {
    let (answer, wait) = mpsc::channel();
    let asked = name.to_string();
    thread::spawn(move || {
        let found = (asked.as_str(), 0u16)
            .to_socket_addrs()
            .map(|found| found.map(|a| a.ip()).collect::<Vec<_>>())
            .unwrap_or_default();
        let _ = answer.send(found);
    });
    match wait.recv_timeout(Duration::from_millis(1200)) {
        Ok(found) if !found.is_empty() => Some(found),
        _ => None,
    }
}

/// Whether the addresses a name resolved to are this computer's own.
fn is_this_computer(found: &[IpAddr], mine: Option<IpAddr>) -> bool {
    let reachable: Vec<IpAddr> = found
        .iter()
        .copied()
        .filter(|a| !a.is_loopback() && !a.is_unspecified())
        .collect();
    match mine {
        // The address another device reaches us at has to be among them, or
        // the name is somebody else's.
        Some(mine) => reachable.contains(&mine),
        // Nothing to compare against; any address a device could reach will do.
        None => !reachable.is_empty(),
    }
}

/// The address a reader opens when something in front of this program is
/// carrying the traffic, as the environment was left.
///
/// This program has no certificate and terminates no TLS. The way a phone
/// reaches a secure origin is a proxy, a tunnel or a mesh in front of it —
/// and the name on that certificate belongs to whatever is in front, not to
/// this computer, so it cannot be found here the way a `.local` name can. It
/// is told, or it is not known (bw-tttn.1).
///
/// A bare name is read as `https://`, because the scheme is the whole reason
/// to put something in front, and a reader who writes the name alone means
/// the secure one.
fn published(public: Option<&str>) -> Option<String> {
    let said = public?.trim().trim_end_matches('/');
    if said.is_empty() {
        return None;
    }
    Some(match said.contains("://") {
        true => said.to_string(),
        false => format!("https://{said}"),
    })
}

/// Where the screen keeps who may reach this program.
pub const BIND_HOST_SETTING: &str = "server.bind-host";

/// Where the screen keeps the port this program answers on.
pub const PORT_SETTING: &str = "server.port";

/// Where a stored address in front of this program used to be kept.
///
/// Nothing reads it any more. It had a box on the settings screen, and that
/// box was the most confusing thing there: it sat under the Tailscale address
/// and looked like it set it, when all it changed was a line the app prints
/// at startup. A reader who typed their own address into it watched the real
/// one stay exactly as it was (bw-t2m2).
///
/// The name is kept so a value stored by an older copy can be recognised as
/// dead rather than rediscovered as a setting. The address in front of this
/// program now comes from the environment alone, which is where the one
/// reader who needs it — somebody running this behind their own domain or a
/// proxy — was always going to put it.
pub const PUBLIC_URL_SETTING: &str = "server.public-url";

/// Which of the two answers wins.
///
/// A value in the environment belongs to one run — a script, a test, an
/// agent's own disposable copy of the app — so it outranks the stored one for
/// that run and changes nothing afterwards. The stored answer is the durable
/// choice, and it is the only one a reader who never opens a terminal has
/// (bw-hdor.1).
///
/// Blank is not an answer in either place. A variable exported empty by a
/// shell that meant to unset it reads as nothing chosen, which is what the
/// person meant.
fn chosen(for_this_run: Option<String>, stored: Option<String>) -> Option<String> {
    [for_this_run, stored]
        .into_iter()
        .flatten()
        .map(|said| said.trim().to_string())
        .find(|said| !said.is_empty())
}

/// The first of these names the environment has an answer for.
fn for_this_run(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok().filter(|said| !said.trim().is_empty()))
}

/// Who may reach this program: this run's answer, else the screen's, else
/// everyone on the network.
///
/// Answering every address is the default because the board on a phone is the
/// ordinary reason to run this at all, and a reader who wants the door shut
/// says so on the screen.
pub fn bind_host() -> String {
    bind_host_from(
        for_this_run(&["ATELIER_HOST", "BEADS_WEB_HOST", "HOST"]),
        crate::db::setting_at_rest(BIND_HOST_SETTING),
    )
}

/// The rule behind [`bind_host`], with both answers handed to it.
pub fn bind_host_from(for_this_run: Option<String>, stored: Option<String>) -> String {
    chosen(for_this_run, stored).unwrap_or_else(|| "0.0.0.0".to_string())
}

/// The port this program answers on: this run's answer, else the screen's,
/// else the one it has always used.
///
/// Same rule as [`bind_host`], and for the same reason: the copy that serves,
/// the copy answering `atelier where` and the service that registers one have
/// to reach the same number or two of them send a reader to a dead address.
pub fn port() -> u16 {
    port_from(
        for_this_run(&["ATELIER_PORT", "BEADS_WEB_PORT", "PORT"]),
        crate::db::setting_at_rest(PORT_SETTING),
    )
}

/// The rule behind [`port`], with both answers handed to it.
///
/// Anything that is not a port this program could be reached on falls through
/// to the default rather than stopping the start. A stored number nobody can
/// connect to is a mistake to ignore, not one to refuse to boot over.
pub fn port_from(for_this_run: Option<String>, stored: Option<String>) -> u16 {
    chosen(for_this_run, stored)
        .and_then(|said| said.parse().ok())
        .filter(|&number| usable_port(number))
        .unwrap_or(crate::command_line::PORT)
}

/// Whether a number is a port this program can be asked to take.
///
/// Zero is "pick one for me", which would leave the reader with an address
/// nobody wrote down. Below 1024 needs privileges this program does not ask
/// for, and asking for them to serve a board is the wrong trade.
pub fn usable_port(number: u16) -> bool {
    number >= 1024
}

/// The address to type on this computer's own network, when there is one.
///
/// The name before the number, because the name still works next week and a
/// leased address does not. Nothing when this program answers only here:
/// there is no home network address then, and printing one would be a lie the
/// reader finds out about from their phone.
pub fn home_address(host: &str, port: u16, network: Option<IpAddr>, name: Option<&str>) -> Option<String> {
    match Listening::from(host) {
        Listening::OnlyHere => None,
        Listening::AtOneAddress => Some(format!("http://{host}:{port}")),
        Listening::Everywhere => match (name, network) {
            (Some(name), _) => Some(format!("http://{name}:{port}")),
            (None, Some(address)) => Some(format!("http://{}:{port}", shown(address))),
            (None, None) => None,
        },
    }
}

/// The address in front of this program, when this run was given one.
///
/// Read here rather than at each caller, because the running copy, the copy
/// answering `atelier where`, and the installed service all have to name the
/// same address or two of them are lying to somebody.
///
/// Only the environment is asked. What used to be stored beside it is dead —
/// see {@link PUBLIC_URL_SETTING} — so a value somebody typed into the old
/// box stops changing what is printed the moment they take this version.
pub fn published_url() -> Option<String> {
    published(for_this_run(&["ATELIER_PUBLIC_URL", "BEADS_WEB_PUBLIC_URL"]).as_deref())
}

/// The lines telling a reader where to open it.
///
/// Two of them when anyone on the network may reach it, because the address a
/// phone needs is not the address this computer needs. One when it has been
/// told to answer only here — and that one says so, rather than leaving
/// somebody to type an address on their phone and wait for a page that will
/// never come.
///
/// When an address in front of it has been named, that one is the network
/// address: it is the only one of them a phone will hold a service worker or
/// a notification on, and every plain one behind it drops to a fallback
/// rather than being offered as the address to use (bw-tttn.1).
pub fn openable_at(
    host: &str,
    port: u16,
    network: Option<IpAddr>,
    name: Option<&str>,
    public: Option<&str>,
) -> Vec<String> {
    let here = format!("On this computer   http://localhost:{port}");
    let published = published(public);
    match Listening::from(host) {
        // Answering only here is the settled way to run behind something in
        // front: the door faces the proxy and nothing else. Telling that
        // reader to open it to the network instead would be advice that undoes
        // the arrangement they have already made.
        Listening::OnlyHere => match published {
            Some(url) => vec![here, format!("Network            {url}")],
            None => vec![
                here,
                "Local access only. Settings > Remote access changes what it answers on."
                    .to_string(),
            ],
        },
        Listening::Everywhere => {
            let mut plain = Vec::new();
            match (name, network) {
                // The name first: it is the one that still works next week.
                // The number stays beside it, because a phone that cannot look
                // the name up needs something to type today.
                (Some(name), address) => {
                    plain.push(format!("http://{name}:{port}"));
                    if let Some(address) = address {
                        plain.push(format!("http://{}:{port}", shown(address)));
                    }
                }
                (None, Some(address)) => plain.push(format!("http://{}:{port}", shown(address))),
                (None, None) => {}
            }
            let mut lines = vec![here];
            lines.extend(ranked(published, plain, port));
            lines
        }
        Listening::AtOneAddress => {
            let mut lines = vec![here];
            lines.extend(ranked(published, vec![format!("http://{host}:{port}")], port));
            lines
        }
    }
}

/// The network addresses in the order a reader should try them.
///
/// The first is the one to use and the rest are what is left to type when it
/// cannot be reached. A named address in front always takes the first place,
/// because a plain one cannot do what it does.
fn ranked(published: Option<String>, plain: Vec<String>, port: u16) -> Vec<String> {
    let mut all = Vec::new();
    all.extend(published);
    all.extend(plain);
    let mut lines: Vec<String> = all
        .into_iter()
        .enumerate()
        .map(|(rank, address)| match rank {
            0 => format!("Network            {address}"),
            _ => format!("Network fallback   {address}"),
        })
        .collect();
    if lines.is_empty() {
        lines.push(format!("Network            unavailable (port {port})"));
    }
    lines
}

/// What the address it was told to listen on means for who can reach it.
enum Listening {
    Everywhere,
    OnlyHere,
    AtOneAddress,
}

impl Listening {
    fn from(host: &str) -> Self {
        match host.trim().trim_matches(|c| c == '[' || c == ']') {
            "" | "0.0.0.0" | "::" => Listening::Everywhere,
            "localhost" | "127.0.0.1" | "::1" => Listening::OnlyHere,
            _ => Listening::AtOneAddress,
        }
    }
}

/// An address as it goes into a browser: a v6 one needs its brackets back.
fn shown(address: IpAddr) -> String {
    match address {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn lines(host: &str, network: Option<IpAddr>) -> String {
        openable_at(host, 3008, network, None, None).join("\n")
    }

    fn named(host: &str, network: Option<IpAddr>, name: &str) -> String {
        openable_at(host, 3008, network, Some(name), None).join("\n")
    }

    fn fronted(host: &str, network: Option<IpAddr>, name: Option<&str>, public: &str) -> String {
        openable_at(host, 3008, network, name, Some(public)).join("\n")
    }

    #[test]
    fn listening_to_everyone_names_the_address_a_phone_can_type() {
        let said = lines("0.0.0.0", Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))));
        assert!(said.contains("http://192.168.1.11:3008"), "{said}");
        assert!(said.contains("http://localhost:3008"), "{said}");
        assert!(said.contains("Network"), "{said}");
    }

    #[test]
    fn the_same_is_true_of_every_way_of_writing_everyone() {
        for everyone in ["", "  ", "::", "[::]"] {
            let said = lines(everyone, Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 4))));
            assert!(
                said.contains("http://10.0.0.4:3008"),
                "{everyone:?} was not read as listening to everyone: {said}"
            );
        }
    }

    #[test]
    fn listening_only_here_says_so_instead_of_offering_an_address() {
        let said = lines("127.0.0.1", Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))));
        assert!(
            !said.contains("192.168.1.11"),
            "an address was offered that would not answer: {said}"
        );
        assert!(said.contains("Local access only"), "{said}");
        // Where to change it, and not what to change: the variable it used
        // to name is no longer carried into the installed service, so a
        // reader who set it would see nothing happen (bw-hdor.1).
        assert!(
            said.contains("Settings > Remote access"),
            "it does not say where to change it: {said}"
        );
    }

    #[test]
    fn a_single_address_it_was_told_to_answer_on_is_the_one_printed() {
        let said = lines("192.168.1.11", None);
        assert!(said.contains("http://192.168.1.11:3008"), "{said}");
    }

    #[test]
    fn a_computer_with_no_route_out_is_told_that_rather_than_a_wrong_address() {
        let said = lines("0.0.0.0", None);
        assert!(said.contains("http://localhost:3008"), "{said}");
        assert!(said.contains("unavailable"), "{said}");
        assert!(!said.contains("http://:"), "half an address was printed: {said}");
    }

    #[test]
    fn a_v6_address_goes_into_a_browser_with_its_brackets() {
        let said = lines("::", Some(IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1))));
        assert!(said.contains("http://[fe80::1]:3008"), "{said}");
    }

    #[test]
    fn a_name_that_does_not_move_is_printed_ahead_of_the_number() {
        let said = named(
            "0.0.0.0",
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))),
            "nobara.local",
        );
        let name_at = said.find("nobara.local").expect("the name was not printed: {said}");
        let number_at = said.find("192.168.1.11").expect("the number was not printed: {said}");
        assert!(
            name_at < number_at,
            "the number a router can change was offered first:\n{said}"
        );
    }

    #[test]
    fn the_number_stays_beside_the_name_for_a_phone_that_cannot_find_it() {
        // Some Android browsers never look a `.local` name up. Dropping the
        // number would leave those readers with nothing to type at all.
        let said = named(
            "0.0.0.0",
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))),
            "nobara.local",
        );
        assert!(said.contains("http://192.168.1.11:3008"), "{said}");
        assert!(said.contains("http://nobara.local:3008"), "{said}");
    }

    #[test]
    fn a_computer_whose_name_is_not_found_still_gets_the_number_and_no_dead_name() {
        let said = lines("0.0.0.0", Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))));
        assert!(said.contains("http://192.168.1.11:3008"), "{said}");
        assert!(!said.contains(".local"), "a name nothing resolves was offered:\n{said}");
    }

    #[test]
    fn a_name_and_no_route_out_still_prints_the_name() {
        // The name is what a phone types, and it works whether or not this
        // computer can work out its own number.
        let said = named("0.0.0.0", None, "nobara.local");
        assert!(said.contains("http://nobara.local:3008"), "{said}");
        assert!(!said.contains("no route out"), "it apologised while holding the answer:\n{said}");
    }

    #[test]
    fn keeping_to_itself_offers_no_name_either() {
        let said = openable_at("127.0.0.1", 3008, None, Some("nobara.local"), None).join("\n");
        assert!(
            !said.contains("nobara.local"),
            "a name was offered that would not answer: {said}"
        );
    }

    #[test]
    fn the_local_name_is_built_from_the_bare_name_of_the_computer() {
        assert_eq!(local_name("nobara").as_deref(), Some("nobara.local"));
        assert_eq!(local_name("  NOBARA \n").as_deref(), Some("nobara.local"));
        // Already carrying a domain, or already a `.local` name: one label.
        assert_eq!(local_name("nobara.lan").as_deref(), Some("nobara.local"));
        assert_eq!(local_name("nobara.local.").as_deref(), Some("nobara.local"));
        assert_eq!(local_name(""), None);
        assert_eq!(local_name("   "), None);
    }

    #[test]
    fn a_name_belonging_to_another_machine_is_refused() {
        let mine = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11));
        let elsewhere = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 47));
        assert!(is_this_computer(&[mine], Some(mine)));
        assert!(is_this_computer(&[elsewhere, mine], Some(mine)));
        assert!(!is_this_computer(&[elsewhere], Some(mine)));
    }

    #[test]
    fn a_name_that_only_answers_to_this_machine_itself_is_refused() {
        // `127.0.1.1` in a hosts file resolves and reaches nothing from a
        // phone, which is the whole failure this is here to avoid.
        let here = IpAddr::V4(Ipv4Addr::new(127, 0, 1, 1));
        assert!(!is_this_computer(&[here], None));
        assert!(!is_this_computer(&[], None));
        assert!(is_this_computer(&[IpAddr::V4(Ipv4Addr::new(10, 0, 0, 4))], None));
    }

    #[test]
    fn an_address_in_front_is_the_one_offered_and_the_plain_ones_fall_behind_it() {
        // The point of the whole arrangement: a phone opening the first line
        // gets a secure origin, and no plain address is put where a reader
        // would read it as the one to use.
        let said = fronted(
            "0.0.0.0",
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))),
            Some("nobara.local"),
            "https://nobara.tail1a2b.ts.net",
        );
        let offered = said
            .lines()
            .find(|line| line.starts_with("Network  ") && !line.contains("fallback"))
            .unwrap_or_else(|| panic!("nothing was offered as the address to use:\n{said}"));
        assert!(
            offered.contains("https://nobara.tail1a2b.ts.net"),
            "the address in front was not the one offered: {offered}"
        );
        assert!(!offered.contains("http://"), "a plain address was offered: {offered}");
        // Still printed, because the mesh can be down and the LAN is then all
        // the reader has left to type.
        assert!(said.contains("Network fallback   http://nobara.local:3008"), "{said}");
        assert!(said.contains("Network fallback   http://192.168.1.11:3008"), "{said}");
    }

    #[test]
    fn answering_only_here_behind_something_in_front_is_reachable_not_local_only() {
        // The settled shape: the door faces the proxy alone. Telling this
        // reader to open it to the network would undo what they just set up.
        let said = fronted("127.0.0.1", None, None, "https://nobara.tail1a2b.ts.net");
        assert!(said.contains("Network            https://nobara.tail1a2b.ts.net"), "{said}");
        assert!(!said.contains("Local access only"), "it called a reachable board local: {said}");
        assert!(!said.contains("ATELIER_HOST=0.0.0.0"), "it advised undoing the arrangement: {said}");
    }

    #[test]
    fn a_computer_with_no_route_out_behind_something_in_front_has_an_address_after_all() {
        let said = fronted("0.0.0.0", None, None, "https://nobara.tail1a2b.ts.net");
        assert!(said.contains("https://nobara.tail1a2b.ts.net"), "{said}");
        assert!(!said.contains("unavailable"), "it reported nothing while holding an address: {said}");
    }

    #[test]
    fn nothing_in_front_leaves_every_line_as_it_was() {
        let network = Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11)));
        for nothing in ["", "   "] {
            assert_eq!(
                fronted("0.0.0.0", network, Some("nobara.local"), nothing),
                named("0.0.0.0", network, "nobara.local"),
                "{nothing:?} was read as an address in front"
            );
        }
    }

    #[test]
    fn a_name_written_alone_is_read_as_the_secure_one() {
        assert_eq!(
            published(Some("nobara.tail1a2b.ts.net")).as_deref(),
            Some("https://nobara.tail1a2b.ts.net")
        );
        // A scheme already written is kept, including a plain one: a reader
        // who wrote `http://` meant it, and a silent upgrade would print an
        // address that answers nothing.
        assert_eq!(
            published(Some("http://board.lan")).as_deref(),
            Some("http://board.lan")
        );
        // A trailing slash would double against the paths a reader types.
        assert_eq!(
            published(Some("  https://board.ts.net/  ")).as_deref(),
            Some("https://board.ts.net")
        );
        assert_eq!(published(Some("")), None);
        assert_eq!(published(None), None);
    }

    #[test]
    fn nothing_chosen_anywhere_answers_everyone() {
        // The board on a phone is the ordinary reason to run this, so the
        // default has to be the one that lets a phone in.
        assert_eq!(bind_host_from(None, None), "0.0.0.0");
        assert_eq!(published(None), None);
    }

    #[test]
    fn the_screens_answer_is_used_when_this_run_has_none() {
        assert_eq!(
            bind_host_from(None, Some("127.0.0.1".into())),
            "127.0.0.1"
        );
    }

    #[test]
    fn this_runs_answer_outranks_the_screens() {
        // A worktree, a test or an agent's own copy sets one of these for a
        // single run. It must not be able to lose the reader's stored choice,
        // and it must not be ignored either.
        assert_eq!(
            bind_host_from(Some("127.0.0.1".into()), Some("0.0.0.0".into())),
            "127.0.0.1"
        );
    }

    #[test]
    fn a_variable_exported_blank_is_not_an_answer_and_the_stored_one_still_counts() {
        // `export ATELIER_HOST=` from a script that meant to unset it. Reading
        // that as a bind address of nothing would bind nothing.
        for blank in ["", "   ", "\n"] {
            assert_eq!(
                bind_host_from(Some(blank.into()), Some("127.0.0.1".into())),
                "127.0.0.1",
                "{blank:?} was taken as an answer"
            );
            assert_eq!(bind_host_from(Some(blank.into()), None), "0.0.0.0");
        }
    }

    #[test]
    fn a_stored_answer_is_trimmed_before_it_is_believed() {
        // It arrives from a text box.
        assert_eq!(bind_host_from(None, Some("  127.0.0.1  ".into())), "127.0.0.1");
    }

    #[test]
    fn the_stored_answer_is_read_before_anything_is_started() {
        // Read straight off the file, with no migration run and nothing held
        // open, because this happens before the door is taken.
        let dir = std::env::temp_dir().join(format!("atelier-bw-hdor-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder to write a database into");
        let file = dir.join("settings.db");
        let _ = std::fs::remove_file(&file);

        // No file at all: a first run, and not a reason to refuse to start.
        assert_eq!(crate::db::setting_in(&file, BIND_HOST_SETTING), None);

        let conn = rusqlite::Connection::open(&file).expect("a database to write");
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO settings (key, value) VALUES ('server.bind-host', ' 127.0.0.1 ');",
        )
        .expect("the one table this reads");
        drop(conn);

        assert_eq!(
            crate::db::setting_in(&file, BIND_HOST_SETTING).as_deref(),
            Some("127.0.0.1"),
            "the stored answer was not read, or was read untrimmed"
        );
        // A key nobody has chosen reads the same as no file.
        assert_eq!(crate::db::setting_in(&file, PUBLIC_URL_SETTING), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_port_nobody_chose_is_the_one_the_program_was_built_with() {
        assert_eq!(port_from(None, None), crate::command_line::PORT);
    }

    #[test]
    fn the_screens_port_is_used_when_this_run_has_none() {
        assert_eq!(port_from(None, Some("4100".into())), 4100);
    }

    #[test]
    fn this_runs_port_outranks_the_screens() {
        assert_eq!(port_from(Some("5000".into()), Some("4100".into())), 5000);
    }

    #[test]
    fn a_port_this_program_may_not_take_is_not_taken() {
        // Below 1024 needs privileges the app does not have, so a stored 80
        // would make every later start fail to bind with nothing on screen
        // explaining why. Fall back rather than refuse to run.
        assert_eq!(port_from(None, Some("80".into())), crate::command_line::PORT);
        assert!(!usable_port(1023));
        assert!(usable_port(1024));
    }

    #[test]
    fn a_port_that_is_not_a_number_is_not_a_port() {
        assert_eq!(port_from(None, Some("soon".into())), crate::command_line::PORT);
    }

    #[test]
    fn the_home_address_is_the_name_a_phone_on_the_wifi_can_type() {
        assert_eq!(
            home_address("0.0.0.0", 3008, None, Some("desk.local")),
            Some("http://desk.local:3008".into())
        );
    }

    #[test]
    fn the_home_address_falls_back_to_the_number_when_there_is_no_name() {
        let network = Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 40)));
        assert_eq!(
            home_address("0.0.0.0", 3008, network, None),
            Some("http://192.168.1.40:3008".into())
        );
    }

    #[test]
    fn keeping_to_itself_has_no_home_address_to_offer() {
        assert_eq!(home_address("127.0.0.1", 3008, None, Some("desk.local")), None);
    }

    #[test]
    fn one_address_it_was_told_to_answer_on_is_the_home_address() {
        assert_eq!(
            home_address("192.168.1.40", 3008, None, None),
            Some("http://192.168.1.40:3008".into())
        );
    }

    #[test]
    fn the_name_this_computer_answers_to_is_its_own() {
        // The parts that ask the operating system. A machine with no
        // multicast answerer has no name, and then there is nothing to check.
        let network = on_this_network();
        if let Some(name) = name_on_this_network(network) {
            assert!(name.ends_with(".local"), "{name} is not a local network name");
            assert!(!name.starts_with('.'), "{name} has no name in front of it");
        }
    }

    #[test]
    fn the_address_found_is_one_another_device_could_reach() {
        // The one part that asks the operating system. A machine running tests
        // may have no route out, and then there is nothing to check.
        if let Some(address) = on_this_network() {
            assert!(!address.is_loopback(), "{address} is this computer talking to itself");
            assert!(!address.is_unspecified(), "{address} is not an address anyone can reach");
        }
    }
}
