//! Who is allowed to open a shell on this machine.
//!
//! The terminal hands out a real login shell over a socket, and this server
//! binds every interface by default (`main.rs`, `ATELIER_HOST`) with no
//! password on anything. The manager wants that: he opens `nobara.local:3008`
//! from his phone and expects a shell. So the question is not "is this
//! loopback" but "is the caller talking to *this machine*, by one of the names
//! this machine actually answers to".
//!
//! ## Why the `Host` header and not `Origin`
//!
//! A WebSocket handshake is not governed by the same-origin policy. RFC 6455
//! leaves the decision entirely to the server — the browser sends `Origin` as
//! information and "the server MAY use this information as part of a
//! determination of whether to accept the incoming connection". If we answer
//! `101`, the socket opens, no matter which page opened it. The permissive CORS
//! layer this server already installs is not the control surface here; it never
//! sees the handshake.
//!
//! The obvious guard — check that `Origin` matches `Host` — is what ttyd
//! (`check_host_origin()`) and code-server (`authenticateOrigin()`) both do, and
//! DNS rebinding walks straight through it. The attacker serves the page from
//! the very name he is about to rebind, so when the rebind lands on this box the
//! browser sends `Origin: http://rebind.evil.com` *and*
//! `Host: rebind.evil.com:3008`. They agree perfectly. Neither header carries
//! any sign that the connection arrived here.
//!
//! What he cannot do is make the victim's browser claim to be visiting a name
//! *we* answer to. So the rule is an allowlist of what this machine is, which is
//! what Vite shipped as `server.allowedHosts` after its own rebinding advisory
//! (GHSA-vg6x-rcgg-rjx6) and what GitHub's security team recommends. `Origin` is
//! never consulted.
//!
//! ## Why the address is parsed and never string-matched
//!
//! `127.0.0.1` can be spelled `2130706433`, `0x7f000001`, `017700000001`, or
//! `::ffff:127.0.0.1`, and a guard that compares text misses all four. Two
//! behaviours in the standard library do the work instead: `parse::<IpAddr>()`
//! has rejected octal and hexadecimal forms outright since Rust 1.58, so an
//! obfuscated literal simply is not an address and falls through to the name
//! branch where it matches nothing; and `to_canonical()` folds a four-part
//! address written inside a six-part one back down before the predicates run.

use axum::{
    body::Body,
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::IpAddr;
use std::sync::OnceLock;

/// The names this machine answers to besides `localhost` and its addresses.
///
/// Read once. A hostname does not change under a running server, and asking the
/// operating system on every request would put a file read in front of every
/// keystroke typed into a shell.
fn own_names() -> &'static [String] {
    static NAMES: OnceLock<Vec<String>> = OnceLock::new();
    NAMES.get_or_init(|| {
        let raw = std::fs::read_to_string("/proc/sys/kernel/hostname")
            .or_else(|_| std::fs::read_to_string("/etc/hostname"))
            .ok()
            .or_else(|| {
                // macOS has neither file. The server already shells out for git
                // and for `bd`, so one more at startup is in keeping.
                std::process::Command::new("hostname")
                    .output()
                    .ok()
                    .filter(|out| out.status.success())
                    .and_then(|out| String::from_utf8(out.stdout).ok())
            })
            .unwrap_or_default();

        let mut names = Vec::new();
        for name in raw.split_whitespace() {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            if name.is_empty() {
                continue;
            }
            // `nobara.local` is already covered by the mDNS rule below, but a
            // machine whose hostname carries some other domain answers to both
            // the full name and the bare label, and people type the bare one.
            if let Some((label, _)) = name.split_once('.') {
                if !label.is_empty() {
                    names.push(label.to_string());
                }
            }
            names.push(name);
        }
        names.sort();
        names.dedup();
        names
    })
}

/// The host a caller claims to be visiting, with its port and its dressing off.
///
/// Returns `None` for anything a browser would never send, which is the whole
/// point of the function: a `Host` header carrying userinfo, whitespace, a
/// control character or a stray bracket is not a hostname this server should be
/// reasoning about, and the safe answer to a shape we do not understand is no.
fn bare_host(host: &str) -> Option<String> {
    if host.is_empty() || host.len() > 253 + 6 {
        return None;
    }
    // `evil.com` glued on after an at-sign is the oldest trick for making one
    // string look like two different places to two different readers.
    if host
        .bytes()
        .any(|b| b == b'@' || b == b'/' || b == b'\\' || b <= b' ' || b == 0x7f)
    {
        return None;
    }

    let name = if let Some(rest) = host.strip_prefix('[') {
        // `[::1]:3008` — the brackets exist precisely so the colons inside are
        // not read as a port separator.
        let (inside, after) = rest.split_once(']')?;
        if !(after.is_empty() || after.starts_with(':')) {
            return None;
        }
        if after.len() > 1 && after[1..].parse::<u16>().is_err() {
            return None;
        }
        inside
    } else {
        match host.rsplit_once(':') {
            // More than one colon and no brackets is a bare six-part address.
            // A browser always brackets, but the string still has to be judged,
            // and parsing it is safer than guessing where a port begins.
            Some(_) if host.matches(':').count() > 1 => host,
            Some((before, port)) if port.parse::<u16>().is_ok() && !before.is_empty() => before,
            Some(_) => return None,
            None => host,
        }
    };

    if name.is_empty() {
        return None;
    }
    // A trailing dot is a legitimate way to write a fully qualified name and
    // means the same place, so it must not be a way to slip past a suffix test.
    Some(name.trim_end_matches('.').to_ascii_lowercase())
}

/// Whether a caller claiming this host is talking to this machine.
pub fn host_is_local(host: &str) -> bool {
    let Some(name) = bare_host(host) else {
        return false;
    };

    if let Ok(address) = name.parse::<IpAddr>() {
        return address_is_local(address);
    }

    if name == "localhost" || name.ends_with(".localhost") {
        return true;
    }
    // `.local` is reserved to multicast DNS by RFC 6762 and answered by the
    // machine itself through Avahi, so no one can hold authoritative DNS for a
    // name under it the way an attacker holds it for his own domain. That is
    // what makes a whole-suffix allowance safe here and nowhere else.
    if name.ends_with(".local") {
        return true;
    }

    own_names().contains(&name)
}

/// Whether an address belongs to this machine or to the network it sits on.
fn address_is_local(address: IpAddr) -> bool {
    // A four-part address written inside a six-part one is the same address,
    // and only the folded form answers the four-part questions correctly.
    let address = match address {
        IpAddr::V6(six) => six.to_canonical(),
        other => other,
    };
    match address {
        IpAddr::V4(four) => four.is_loopback() || four.is_private() || four.is_link_local(),
        IpAddr::V6(six) => {
            six.is_loopback() || six.is_unique_local() || six.is_unicast_link_local()
        }
    }
}

/// Turns away anything that is not talking to this machine, before it is served.
///
/// Laid over the terminal routes and nothing else. The rest of this server hands
/// out board cards and chat transcripts; the terminal hands out a shell, and it
/// is the only thing here worth this refusal.
///
/// A missing `Host` is a refusal too. Every browser sends one and HTTP/1.1
/// requires it, so its absence means the caller is not the kind of client this
/// route is for.
pub async fn require_local_host(request: Request<Body>, next: Next) -> Response {
    let claimed = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();

    if !host_is_local(claimed) {
        tracing::warn!(
            host = %claimed,
            "refused a terminal request naming a host this machine does not answer to"
        );
        return (
            StatusCode::FORBIDDEN,
            "The terminal answers only to this machine's own names and addresses.",
        )
            .into_response();
    }

    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_names_and_addresses_this_machine_answers_to() {
        for host in [
            "localhost",
            "localhost:3008",
            "[::1]:3008",
            "[::1]",
            "127.0.0.1:3008",
            "nobara.local",
            "nobara.local.",
            "nobara.local:3008",
            "NOBARA.LOCAL:3008",
            "192.168.1.5:3008",
            "10.0.0.7",
            "172.16.4.2:3008",
            "169.254.1.1",
            "::ffff:192.168.1.5",
            "[::ffff:192.168.1.5]:3008",
            "[fe80::1]:3008",
            "[fd00::1]:3008",
        ] {
            assert!(host_is_local(host), "should have accepted {host}");
        }
    }

    #[test]
    fn refuses_a_name_someone_else_controls() {
        for host in [
            // The rebinding case the whole module exists for: the attacker owns
            // this name and can point it at this machine, but he can never make
            // the browser claim a name we answer to.
            "rebind.evil.com",
            "rebind.evil.com:3008",
            "evil.com",
            "localhost.evil.com",
            "nobara.local.evil.com",
            // A public address is not this network.
            "8.8.8.8",
            "93.184.216.34:3008",
            "[2606:4700:4700::1111]:3008",
            // What this server binds is not a way to reach it.
            "0.0.0.0:3008",
        ] {
            assert!(!host_is_local(host), "should have refused {host}");
        }
    }

    #[test]
    fn refuses_an_address_dressed_up_to_look_like_a_name() {
        // Every one of these is 127.0.0.1 to some resolver somewhere. None of
        // them is an address to `parse`, so each falls through to the name
        // branch and matches nothing there.
        for host in [
            "2130706433",
            "2130706433:3008",
            "0x7f000001",
            "0x7f.0x0.0x0.0x1",
            "017700000001",
            "0177.0.0.01",
            "127.0.0.01",
        ] {
            assert!(!host_is_local(host), "should have refused {host}");
        }
    }

    #[test]
    fn refuses_a_host_wearing_two_names_at_once() {
        for host in [
            "nobara.local:3008@evil.com",
            "localhost@evil.com",
            "evil.com@nobara.local",
            "nobara.local/../evil.com",
            "nobara.local\nHost: evil.com",
            "nobara.local evil.com",
            "",
            ":3008",
            "nobara.local:notaport",
            "[::1",
            "[::1]x",
            "[::1]:notaport",
        ] {
            assert!(!host_is_local(host), "should have refused {host:?}");
        }
    }

    #[test]
    fn a_trailing_dot_does_not_change_where_a_name_points() {
        assert_eq!(host_is_local("nobara.local"), host_is_local("nobara.local."));
        assert_eq!(host_is_local("evil.com"), host_is_local("evil.com."));
        // And it cannot be used to dodge the suffix test the other way.
        assert!(!host_is_local("evil.com.local.evil.com"));
    }

    #[tokio::test]
    async fn the_guard_turns_a_foreign_caller_away_before_the_route_runs() {
        use axum::{routing::get, Router};
        use tower::ServiceExt;

        // Stands in for a terminal route. If the guard lets this run, a page on
        // someone else's site just reached a shell.
        let app = Router::new()
            .route("/probe", get(|| async { "a shell would be here" }))
            .layer(axum::middleware::from_fn(require_local_host));

        let ask = |host: Option<&str>| {
            let mut request = Request::builder().uri("/probe");
            if let Some(host) = host {
                request = request.header(header::HOST, host);
            }
            app.clone().oneshot(request.body(Body::empty()).unwrap())
        };

        assert_eq!(
            ask(Some("rebind.evil.com:3008")).await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "the rebinding case has to be refused before the route runs"
        );
        assert_eq!(
            ask(None).await.unwrap().status(),
            StatusCode::FORBIDDEN,
            "no stated host is not a caller this route is for"
        );
        assert_eq!(
            ask(Some("localhost:3008")).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            ask(Some("nobara.local:3008")).await.unwrap().status(),
            StatusCode::OK,
            "the phone on the network is the case this whole feature is for"
        );
    }

    #[test]
    fn this_machine_answers_to_its_own_hostname() {
        // Read from the operating system rather than written down, so the test
        // proves the lookup works on whatever box it runs on.
        let Some(own) = own_names().first().cloned() else {
            return;
        };
        assert!(host_is_local(&own), "should have accepted its own {own}");
        assert!(host_is_local(&format!("{own}:3008")));
    }
}
