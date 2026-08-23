//! How long a browser may keep what this program served it.
//!
//! Every response used to come back saying nothing about that, so browsers
//! applied their own guess and kept pages for as long as they liked. A rebuilt
//! binary then went on drawing the old screens: a report link opened the board
//! tab, because the tab did not exist in the code the browser still held, and
//! only a hard reload — which nobody should have to know about — fixed it
//! (bw-8um.3.11).
//!
//! The rules below are the whole of the answer, and they are pure so they can
//! be read and tested without a server running.

/// How long the browser may keep this file without asking again.
///
/// A file under `_next/static/` is named after the build that made it, so its
/// name changes whenever its contents do: keeping it for a year costs nothing
/// and can never be wrong. Everything else — every page, every icon, every
/// file served under a name that stays the same from one build to the next —
/// must be checked with us on each visit. `no-cache` does not mean "do not
/// keep it": the browser keeps its copy and asks whether it is still good,
/// which the tag below answers in a few bytes.
pub fn kept_for(path: &str) -> &'static str {
    if path.starts_with("_next/static/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache, must-revalidate"
    }
}

/// What a browser may keep of an answer about the work itself: none of it.
///
/// A board, a card, the counts on the project list, the health line — each is a
/// picture of something that changes while the reader is looking at it, and
/// none of them has a name a stale copy could answer to. The address of a board
/// is the same after a card moves as it was before, so `no-cache` and a tag
/// would only invite a browser to keep a copy it can never be told is wrong.
/// `no-store` says there is nothing here worth keeping (bw-8um.3.18).
pub const NOT_KEPT: &str = "no-store";

/// Whether this address hands out an answer about the work rather than a file.
///
/// Asked of the whole address the browser used, so `/api` and everything under
/// it is one rule in one place — the same reason `served` above exists rather
/// than four copies of a header.
pub fn about_the_work(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// The name this exact content answers to.
///
/// It is the hash of the bytes themselves, which rust-embed already computed
/// when it built the file into the binary, so a rebuild that changes a file
/// changes its tag and a rebuild that does not, does not.
pub fn tag_for(hash: &[u8; 32]) -> String {
    let mut tag = String::with_capacity(2 + 32);
    tag.push('"');
    for byte in &hash[..15] {
        tag.push_str(&format!("{byte:02x}"));
    }
    tag.push('"');
    tag
}

/// Whether the browser already holds this exact content.
///
/// A browser may send several tags at once, and may weaken one with `W/`. Both
/// are answered here rather than at four separate call sites.
pub fn already_held(offered: Option<&str>, tag: &str) -> bool {
    let Some(offered) = offered else {
        return false;
    };
    if offered.trim() == "*" {
        return true;
    }
    offered
        .split(',')
        .map(|one| one.trim().trim_start_matches("W/"))
        .any(|one| one == tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_is_checked_with_us_on_every_visit() {
        // The fault this file exists for: a rebuilt app drawing the old one.
        for page in ["index.html", "project.html", "settings.html", "404.html"] {
            assert_eq!(
                kept_for(page),
                "no-cache, must-revalidate",
                "{page} would be kept without asking, so a rebuild would not be seen"
            );
        }
    }

    #[test]
    fn a_file_named_after_its_own_build_is_kept_for_a_year() {
        assert_eq!(
            kept_for("_next/static/chunks/main-9f3c1a.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            kept_for("_next/static/css/6ab2.css"),
            "public, max-age=31536000, immutable"
        );
    }

    #[test]
    fn a_file_whose_name_survives_a_rebuild_is_not() {
        // These live under `public/` and are served at the root under the same
        // name for ever, so a year-long copy would outlive several changes.
        for same_name in ["favicon.svg", "logo.png", "_next/image", "static/x.js"] {
            assert_eq!(
                kept_for(same_name),
                "no-cache, must-revalidate",
                "{same_name} keeps its name across builds and cannot be kept blind"
            );
        }
    }

    #[test]
    fn every_answer_about_the_work_is_one() {
        for asked in [
            "/api/health",
            "/api/beads",
            "/api/projects",
            "/api/reports/spec",
            "/api/workbench/chats",
            "/api",
        ] {
            assert!(
                about_the_work(asked),
                "{asked} would be kept by a browser and drawn after the work moved"
            );
        }
    }

    #[test]
    fn a_screen_or_a_file_is_not() {
        // These are files with tags: they ARE kept, and asked about by tag.
        for asked in ["/", "/index.html", "/project", "/_next/static/main.js", "/apiary"] {
            assert!(
                !about_the_work(asked),
                "{asked} would lose its tag and be fetched whole on every visit"
            );
        }
    }

    #[test]
    fn nothing_about_the_work_may_be_kept_at_all() {
        // no-cache would let a browser keep a board and ask whether it is still
        // good — and nothing about a board's address could ever answer that.
        assert_eq!(NOT_KEPT, "no-store");
    }

    #[test]
    fn the_tag_follows_the_contents_and_nothing_else() {
        let one = [7u8; 32];
        let mut other = one;
        other[31] = 8;
        assert_eq!(tag_for(&one), tag_for(&one), "the same bytes changed name");
        assert_ne!(
            tag_for(&one),
            tag_for(&[9u8; 32]),
            "two different files answer to one name"
        );
        assert!(tag_for(&one).starts_with('"') && tag_for(&one).ends_with('"'));
    }

    #[test]
    fn the_tag_is_read_back_however_the_browser_offers_it() {
        let tag = tag_for(&[3u8; 32]);
        assert!(already_held(Some(&tag), &tag), "its own tag was not recognised");
        assert!(
            already_held(Some(&format!("W/{tag}")), &tag),
            "a weakened tag was not recognised"
        );
        assert!(
            already_held(Some(&format!("\"deadbeef\", {tag}")), &tag),
            "a tag offered alongside another was not recognised"
        );
        assert!(already_held(Some("*"), &tag), "any-content was not recognised");
    }

    #[test]
    fn a_browser_holding_something_else_is_sent_the_file() {
        let tag = tag_for(&[3u8; 32]);
        assert!(!already_held(None, &tag), "a first visit was answered with nothing");
        assert!(
            !already_held(Some(&tag_for(&[4u8; 32])), &tag),
            "a browser holding the previous build was told it was current"
        );
        assert!(!already_held(Some(""), &tag));
    }
}
