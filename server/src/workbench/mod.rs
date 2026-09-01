//! Native workbench services.
//!
//! The browser-facing vocabulary and persisted chat records are the seam of
//! the Node-to-Rust migration. Keep those contracts here while individual
//! services move behind them.

pub mod acp;
pub mod actor;
pub mod agent_files;
pub mod beads_links;
pub mod browser;
pub mod claude;
pub mod cli;
pub mod codex;
pub mod external;
pub mod lifecycle;
pub mod local;
pub mod media;
pub mod metadata;
pub mod projection;
pub mod protocol;
pub mod provider;
pub mod provider_defaults;
pub mod provider_messages;
pub mod provider_reconciliation;
pub mod registry;
pub mod screen_check;
pub mod session_policy;
pub mod store;
pub mod summary;
pub mod usage;
pub mod wire;
