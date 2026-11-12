//! The grid watcher (docs/grids.md, "Row search"): every 60 s, for each
//! project with approved grids, read HEAD in the project's folder, and when it
//! has moved since a grid's last discovery, rerun the row search of each grid
//! whose `watch` covers a changed path.
//!
//! What a tick does with the database and the live feed belongs to the route
//! (`routes/workbench/grids.rs`, `watch`); this holds the loop, the rule for
//! which grids are due, and the registry that keeps one run per grid or cell
//! at a time, which the route's own Discover and Re-check share.

use std::collections::HashSet;
use std::future::Future;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const EVERY: Duration = Duration::from_secs(60);

/// Run `tick` every [`EVERY`], forever, one tick at a time.
pub fn spawn<F, Fut>(tick: F)
where
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(EVERY);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            tick().await;
        }
    });
}

/// Whether a commit range that changed `changed` touches a grid watching
/// these path prefixes.
pub fn touches(watch: &[String], changed: &[String]) -> bool {
    changed.iter().any(|path| {
        watch.iter().any(|prefix| {
            let prefix = prefix.trim_end_matches('/');
            prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
        })
    })
}

/// What a grid's last discovery says about HEAD, and whether a run is due:
/// `None` when it never ran (due), `Some(old)` when it ran at `old`.
pub enum Due {
    /// Never discovered: run it.
    Never,
    /// HEAD has not moved.
    Current,
    /// HEAD moved from this commit: run it if `touches` the changed paths.
    Moved(String),
}

pub fn due(discovery: Option<&serde_json::Value>, head: &str) -> Due {
    match discovery.and_then(|d| d["head"].as_str()) {
        None => Due::Never,
        Some(old) if old == head => Due::Current,
        Some(old) => Due::Moved(old.to_string()),
    }
}

fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// A run in progress (a discovery of a grid, a re-check of a cell); it ends
/// when dropped.
pub struct Running(String);

impl Drop for Running {
    fn drop(&mut self) {
        running().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

/// Start the run named `key`, or None when one is already going.
pub fn start(key: String) -> Option<Running> {
    let mut set = running().lock().unwrap_or_else(|e| e.into_inner());
    // Lazily: a guard built for a refused start would drop here, under the lock.
    set.insert(key.clone()).then(|| Running(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grid_is_due_when_a_changed_path_is_under_what_it_watches() {
        let watch = vec!["renderer/camera/".to_string(), "shaders/camera".to_string()];
        assert!(touches(&watch, &["renderer/camera/glare.rs".into()]));
        assert!(touches(&watch, &["shaders/camera/x.wgsl".into()]));
        assert!(!touches(&watch, &["renderer/camera2/x.rs".into(), "README.md".into()]));
        assert!(matches!(due(None, "a"), Due::Never));
        assert!(matches!(due(Some(&serde_json::json!({"head": "a"})), "a"), Due::Current));
        assert!(matches!(due(Some(&serde_json::json!({"head": "a"})), "b"), Due::Moved(old) if old == "a"));
    }

    #[test]
    fn one_run_per_key_at_a_time() {
        let first = start("g:camera".into()).unwrap();
        assert!(start("g:camera".into()).is_none());
        drop(first);
        assert!(start("g:camera".into()).is_some());
    }
}
