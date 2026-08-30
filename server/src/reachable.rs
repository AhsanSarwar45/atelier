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

/// The lines telling a reader where to open it.
///
/// Two of them when anyone on the network may reach it, because the address a
/// phone needs is not the address this computer needs. One when it has been
/// told to answer only here — and that one says so, rather than leaving
/// somebody to type an address on their phone and wait for a page that will
/// never come.
pub fn openable_at(
    host: &str,
    port: u16,
    network: Option<IpAddr>,
    name: Option<&str>,
) -> Vec<String> {
    let here = format!("On this computer   http://localhost:{port}");
    match Listening::from(host) {
        Listening::OnlyHere => vec![
            here,
            "Local access only. Set ATELIER_HOST=0.0.0.0 for network access."
                .to_string(),
        ],
        Listening::Everywhere => {
            let mut lines = vec![here];
            match (name, network) {
                // The name first: it is the one that still works next week.
                // The number stays beside it, because a phone that cannot look
                // the name up needs something to type today.
                (Some(name), address) => {
                    lines.push(format!("Network            http://{name}:{port}"));
                    if let Some(address) = address {
                        lines.push(format!("Network fallback   http://{}:{port}", shown(address)));
                    }
                }
                (None, Some(address)) => lines.push(format!(
                    "Network            http://{}:{port}",
                    shown(address)
                )),
                (None, None) => lines.push(format!(
                    "Network            unavailable (port {port})"
                )),
            }
            lines
        }
        Listening::AtOneAddress => vec![
            here,
            format!("Network            http://{host}:{port}"),
        ],
    }
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
        openable_at(host, 3008, network, None).join("\n")
    }

    fn named(host: &str, network: Option<IpAddr>, name: &str) -> String {
        openable_at(host, 3008, network, Some(name)).join("\n")
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
        assert!(said.contains("ATELIER_HOST=0.0.0.0"), "it does not say how to change it: {said}");
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
        let said = openable_at("127.0.0.1", 3008, None, Some("nobara.local")).join("\n");
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
