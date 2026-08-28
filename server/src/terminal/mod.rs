//! The terminal: a real shell, reachable from the app.
//!
//! `shell` is one shell on a pseudo-terminal and the order its pieces have to
//! be let go in. What sits above it — the register of live shells, the output
//! kept for someone who comes back, and the route that streams it — arrives
//! with the items that follow.

// A shell that nothing has yet asked for is a shell nothing calls, and the
// compiler is right to say so. The register of live shells (bw-8jzg.5), the
// kept output (bw-8jzg.6) and the routes (bw-8jzg.7) are what call these; this
// allowance comes off with the last of them.
#![allow(dead_code)]

pub mod shell;
