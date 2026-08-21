//! Where this program can be opened, in the words a person types.
//!
//! It has always listened on every address this computer has, so a phone on
//! the same network could reach it — but the only address it ever printed was
//! `localhost`, which on a phone is the phone. Whoever wanted the board in
//! their hand had to go and find this machine's address themselves, and had no
//! way of telling whether the app was even willing to answer them (bw-hkai.1).
//!
//! The rule that turns a bind address into the lines to print is pure, so it
//! is read and tested without a socket. The one thing that must ask the
//! operating system is kept beside it and does nothing else.

use std::net::{IpAddr, UdpSocket};

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

/// The lines telling a reader where to open it.
///
/// Two of them when anyone on the network may reach it, because the address a
/// phone needs is not the address this computer needs. One when it has been
/// told to answer only here — and that one says so, rather than leaving
/// somebody to type an address on their phone and wait for a page that will
/// never come.
pub fn openable_at(host: &str, port: u16, network: Option<IpAddr>) -> Vec<String> {
    let here = format!("On this computer   http://localhost:{port}");
    match Listening::from(host) {
        Listening::OnlyHere => vec![
            here,
            "Only this computer can reach it. Set ATELIER_HOST=0.0.0.0 to open it on your phone."
                .to_string(),
        ],
        Listening::Everywhere => match network {
            Some(address) => vec![
                here,
                format!("On your network    http://{}:{port}   — phone, tablet, another computer", shown(address)),
            ],
            None => vec![
                here,
                format!("On your network    this computer's own address, port {port} — it has no route out to work it out from"),
            ],
        },
        Listening::AtOneAddress => vec![
            here,
            format!("On your network    http://{host}:{port}   — phone, tablet, another computer"),
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
        openable_at(host, 3008, network).join("\n")
    }

    #[test]
    fn listening_to_everyone_names_the_address_a_phone_can_type() {
        let said = lines("0.0.0.0", Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 11))));
        assert!(said.contains("http://192.168.1.11:3008"), "{said}");
        assert!(said.contains("http://localhost:3008"), "{said}");
        assert!(said.contains("phone"), "{said}");
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
        assert!(said.contains("Only this computer"), "{said}");
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
        assert!(said.contains("no route out"), "{said}");
        assert!(!said.contains("http://:"), "half an address was printed: {said}");
    }

    #[test]
    fn a_v6_address_goes_into_a_browser_with_its_brackets() {
        let said = lines("::", Some(IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1))));
        assert!(said.contains("http://[fe80::1]:3008"), "{said}");
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
