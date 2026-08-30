//! Native workbench services.
//!
//! The browser-facing vocabulary and persisted chat records are the seam of
//! the Node-to-Rust migration. Keep those contracts here while individual
//! services move behind them.

pub mod actor;
pub mod claude;
pub mod codex;
pub mod external;
pub mod projection;
pub mod protocol;
pub mod store;
