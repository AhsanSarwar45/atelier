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
pub mod extensions;
pub mod external;
pub mod kit_words;
pub mod lifecycle;
pub mod liveness;
pub mod local;
pub mod mcp_servers;
pub mod media;
pub mod memory;
pub mod metadata;
pub mod profiles;
pub mod projection;
pub mod protocol;
pub mod provider;
pub mod provider_defaults;
pub mod provider_messages;
pub mod provider_reconciliation;
pub mod provider_settings;
pub mod registry;
pub mod screen_check;
pub mod search_index;
pub mod search_query;
pub mod session_policy;
pub mod signin;
pub mod store;
pub mod summary;
pub mod usage;
pub mod wire;

pub mod status;
