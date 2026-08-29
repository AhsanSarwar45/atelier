//! The terminal: a real shell, reachable from the app.
//!
//! `shell` is one shell on a pseudo-terminal and the order its pieces have to
//! be let go in. `pump` is the one thread that drains it, gathering what it
//! prints into a few large messages, keeping the last of it for someone who
//! comes back, and waiting rather than growing when a viewer falls behind.
//! `register` is every shell this server has open, held by the process so a
//! shell outlives the page that opened it, and `routes` is how the app opens,
//! lists and closes one. `stream` is the socket that carries the bytes both
//! ways: what the shell printed while nobody was looking, then what it prints
//! now, and the keystrokes going back the other way.

pub mod pump;
pub mod register;
pub mod routes;
pub mod shell;
pub mod stream;
