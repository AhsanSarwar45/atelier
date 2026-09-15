//! How much memory the server keeps once it has finished with it.
//!
//! glibc gives every thread that allocates its own arena, up to eight per
//! core, and hands freed memory back to the system only from the top of each
//! one. The server runs a thread per core and a pool of blocking threads, so
//! reading a large board or chat record once left its memory spread across
//! dozens of arenas that never shrank: on a sixteen-core machine the process
//! sat at 573 MiB after one board and one long chat were opened, where two
//! arenas held the same work in 192 MiB (bw-fbzd.6).

/// Caps the arenas before any other thread exists.
///
/// Must be called first thing in `main`, before the runtime starts its
/// workers: an arena a thread has already been given is not taken back.
pub fn settle() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: mallopt only changes allocator tuning; called while single-threaded.
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, 2);
    }
}

/// Gives freed memory back to the system every so often.
///
/// Arenas return only what sits at their very top on their own; a trim also
/// releases the free pages in the middle, which is where a large answer that
/// has been sent leaves its space.
pub fn trim_now_and_then() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    tokio::spawn(async {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(30));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            // SAFETY: malloc_trim is thread-safe and has no preconditions.
            let _ = tokio::task::spawn_blocking(|| unsafe { libc::malloc_trim(0) }).await;
        }
    });
}
