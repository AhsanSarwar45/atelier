//! The terminal: a real shell, reachable from the app.
//!
//! `shell` is one shell on a pseudo-terminal and the order its pieces have to
//! be let go in. `pump` is the one thread that drains it, gathering what it
//! prints into a few large messages, keeping the last of it for someone who
//! comes back, and waiting rather than growing when a viewer falls behind. The
//! register of live shells and the route that streams them arrive with the
//! items that follow.

// A shell that nothing has yet asked for is a shell nothing calls, and the
// compiler is right to say so. The register of live shells (bw-8jzg.5), the
// kept output (bw-8jzg.6) and the routes (bw-8jzg.7) are what call these; this
// allowance comes off with the last of them.
#![allow(dead_code)]

pub mod pump;
pub mod shell;
