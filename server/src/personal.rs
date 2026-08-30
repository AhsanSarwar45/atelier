//! Personal provider setup, ported from `machinery/join --personal`.
//!
//! `join --personal` is pure filesystem work: it links Atelier's shared craft
//! (agents, skills, output-styles, commands) and the three personal skill
//! folders into the reader's Claude and Codex homes, links the external-review
//! runner into their personal bin, and merges the session-context hook into each
//! provider's settings. Doing it in Rust means `atelier init` and
//! `atelier service install` no longer need a Python interpreter to set a
//! machine up (bw-oesd.1.1).
//!
//! The word written for the session-context hook is `atelier hook
//! session-context.py` — the same word `join` is handed on its command line
//! when this program runs it — so neither provider learns that the gate stopped
//! being a Python script.

use std::path::{Path, PathBuf};

/// The craft kinds linked one item at a time from the rules' `.claude/` into the
/// Claude home, so a project's own same-named definition can still sit beside the
/// shared one. Mirrors `SHARED` in `machinery/join`.
const SHARED: [&str; 4] = ["agents", "skills", "output-styles", "commands"];

/// The skill folders exposed to both providers, by name and in this order.
/// Mirrors the tuple in `install_skills`.
const SKILLS: [&str; 3] = ["atelier", "beads", "external-review"];

/// Where the personal capabilities land: a reader's Claude home, their Codex
/// home, and their personal bin. `join` reads the same three under the same
/// overrides, so a differential test can point both at a sandbox.
pub struct Homes {
    pub claude: PathBuf,
    pub codex: PathBuf,
    pub personal_bin: PathBuf,
}

impl Homes {
    /// The homes as `machinery/join` resolves them: the `ATELIER_CLAUDE_HOME`,
    /// `ATELIER_CODEX_HOME` and `ATELIER_PERSONAL_BIN` overrides, else the
    /// reader's own `~/.claude`, `~/.codex`, `~/.local/bin`.
    pub fn resolve() -> Result<Homes, String> {
        let home = home_dir().ok_or_else(|| {
            "this computer names no home folder to install personal skills into".to_string()
        })?;
        Ok(Homes {
            claude: env_dir("ATELIER_CLAUDE_HOME").unwrap_or_else(|| home.join(".claude")),
            codex: env_dir("ATELIER_CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            personal_bin: env_dir("ATELIER_PERSONAL_BIN")
                .unwrap_or_else(|| home.join(".local").join("bin")),
        })
    }
}

/// Install the personal capabilities from an unpacked rules bundle.
///
/// `<rules_dir>/machinery` holds the skills, the external-review runner and the
/// session-context hook; `<rules_dir>/.claude` holds the shared craft. On the
/// first filesystem error this stops and reports it, the way `install_tolerantly`
/// abandons `install` on the first `OSError`; the callers treat that as a warning
/// rather than a failure so a copy whose skills could not be linked still
/// finishes setting a project up.
pub fn install(rules_dir: &Path, homes: &Homes) -> Result<(), String> {
    let machinery = rules_dir.join("machinery");
    let craft = rules_dir.join(".claude");
    let command = format!("{} hook session-context.py", crate::identity::NAME);
    link_shared(&craft, &homes.claude)?;
    link_skills(&machinery, homes)?;
    link_external_review(&machinery, homes)?;
    merge_session_hooks(homes, &command)?;
    Ok(())
}

/// One link per craft item under each shared kind, so a project's own copy can
/// override the shared one by name. Mirrors the `for kind in SHARED` loop.
fn link_shared(craft: &Path, claude_home: &Path) -> Result<(), String> {
    for kind in SHARED {
        let mine = craft.join(kind);
        if !mine.is_dir() {
            continue;
        }
        let where_ = claude_home.join(kind);
        std::fs::create_dir_all(&where_).map_err(io("create", &where_))?;
        for name in sorted_entries(&mine)? {
            let link = where_.join(&name);
            let target = mine.join(&name);
            place_shared_link(&link, &target)?;
        }
    }
    Ok(())
}

/// Expose the three personal skill folders to both providers. Mirrors
/// `install_skills`: a fixed order, and a `realpath`/`lexists` decision that
/// keeps a reader's own same-named skill untouched.
fn link_skills(machinery: &Path, homes: &Homes) -> Result<(), String> {
    let source = machinery.join("skills");
    for provider in [&homes.claude, &homes.codex] {
        let target_dir = provider.join("skills");
        std::fs::create_dir_all(&target_dir).map_err(io("create", &target_dir))?;
        for name in SKILLS {
            let link = target_dir.join(name);
            let want = source.join(name);
            place_named_link(&link, &want, &format!("{} — it is not Atelier's skill", link.display()))?;
        }
    }
    Ok(())
}

/// Expose the provider-neutral bounded runner as a personal command. Mirrors
/// `install_external_review`.
fn link_external_review(machinery: &Path, homes: &Homes) -> Result<(), String> {
    let want = machinery
        .join("external-review")
        .join("scripts")
        .join("external_review.py");
    std::fs::create_dir_all(&homes.personal_bin).map_err(io("create", &homes.personal_bin))?;
    let link = homes.personal_bin.join("external-review");
    let kept = format!("{} — it is not Atelier's external-review runner", link.display());
    place_named_link(&link, &want, &kept)
}

/// The SHARED-loop link decision: keep an already-correct link, replace one that
/// points elsewhere, keep a stranger's file, replace an identical taken-in copy,
/// then link.
fn place_shared_link(link: &Path, target: &Path) -> Result<(), String> {
    if let Ok(meta) = std::fs::symlink_metadata(link) {
        if meta.file_type().is_symlink() {
            if points_at(link, target) {
                return Ok(());
            }
            std::fs::remove_file(link).map_err(io("remove", link))?;
        } else if !same(link, target) {
            eprintln!(
                "kept   {} — it is not what this home keeps; compare them",
                link.display()
            );
            return Ok(());
        } else {
            remove_any(link)?;
        }
    }
    symlink(target, link)
}

/// The `install_skills`/`install_external_review` link decision, which treats a
/// broken link (`lexists`) as present and never replaces a stranger's copy.
fn place_named_link(link: &Path, want: &Path, kept: &str) -> Result<(), String> {
    if let Ok(meta) = std::fs::symlink_metadata(link) {
        let is_symlink = meta.file_type().is_symlink();
        if is_symlink && points_at(link, want) {
            return Ok(());
        }
        if !same(link, want) {
            eprintln!("kept   {kept}");
            return Ok(());
        }
        if link.is_dir() && !is_symlink {
            std::fs::remove_dir_all(link).map_err(io("remove", link))?;
        } else {
            std::fs::remove_file(link).map_err(io("remove", link))?;
        }
    }
    symlink(want, link)
}

/// Whether the link already resolves to exactly this target — the `os.path.islink
/// and os.path.realpath(link) == target` idempotency check, read off the link's
/// own contents so a re-run relinks nothing.
fn points_at(link: &Path, target: &Path) -> bool {
    if std::fs::read_link(link).map(|t| t == target).unwrap_or(false) {
        return true;
    }
    std::fs::canonicalize(link)
        .ok()
        .zip(std::fs::canonicalize(target).ok())
        .map(|(a, b)| a == b)
        .unwrap_or(false)
}

/// Whether two definitions are the same thing, file or folder — a conservative
/// port of `same`. Only ever consulted when a non-link already sits at a link
/// path, which the differential test does not exercise; it errs toward keeping a
/// reader's own copy. Unlike `filecmp.dircmp`'s shallow stat compare it compares
/// bytes, and like it, any common subdirectory makes two folders unequal.
fn same(here: &Path, there: &Path) -> bool {
    let here_dir = here.is_dir();
    if here_dir != there.is_dir() {
        return false;
    }
    if !here_dir {
        return match (std::fs::read(here), std::fs::read(there)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
    }
    let (Ok(a), Ok(b)) = (sorted_entries(here), sorted_entries(there)) else {
        return false;
    };
    if a != b {
        return false;
    }
    for name in a {
        let hp = here.join(&name);
        let tp = there.join(&name);
        if hp.is_dir() || tp.is_dir() {
            return false;
        }
        match (std::fs::read(&hp), std::fs::read(&tp)) {
            (Ok(x), Ok(y)) if x == y => {}
            _ => return false,
        }
    }
    true
}

/// Merge the conditional context hook into personal provider settings. Mirrors
/// `install_session_hooks`: drop any existing session-context hook so a re-join
/// does not run it twice, then append the word this program answers to.
fn merge_session_hooks(homes: &Homes, command: &str) -> Result<(), String> {
    merge_one(&homes.claude.join("settings.json"), false, command)?;
    merge_one(&homes.codex.join("hooks.json"), true, command)?;
    Ok(())
}

fn merge_one(where_: &Path, is_codex: bool, command: &str) -> Result<(), String> {
    use serde_json::{json, Value};

    let mut held: Value = if where_.exists() {
        match std::fs::read_to_string(where_)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            Some(v) => v,
            None => {
                eprintln!("kept   {} — it cannot be merged", where_.display());
                return Ok(());
            }
        }
    } else {
        json!({})
    };
    let Some(obj) = held.as_object_mut() else {
        eprintln!("kept   {} — it is not a settings object", where_.display());
        return Ok(());
    };
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    let Some(hooks) = hooks.as_object_mut() else {
        eprintln!("kept   {} — its hooks are not an object", where_.display());
        return Ok(());
    };
    let blocks = hooks.entry("SessionStart").or_insert_with(|| json!([]));
    let Some(blocks) = blocks.as_array_mut() else {
        eprintln!(
            "kept   {} — its SessionStart hooks are not a list",
            where_.display()
        );
        return Ok(());
    };
    for block in blocks.iter_mut() {
        if let Some(bobj) = block.as_object_mut() {
            if let Some(inner) = bobj.get("hooks").and_then(|h| h.as_array()) {
                let kept: Vec<Value> = inner
                    .iter()
                    .filter(|h| !runs_gate(h.get("command"), "session-context.py"))
                    .cloned()
                    .collect();
                bobj.insert("hooks".to_string(), Value::Array(kept));
            }
        }
    }
    blocks.retain(|block| {
        block
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    });
    let mut entry = serde_json::Map::new();
    entry.insert(
        "hooks".to_string(),
        json!([{ "type": "command", "command": command }]),
    );
    if is_codex {
        entry.insert("matcher".to_string(), json!("startup|resume|clear"));
    }
    blocks.push(Value::Object(entry));

    let mut text = serde_json::to_string_pretty(&held)
        .map_err(|e| format!("could not serialise {}: {e}", where_.display()))?;
    text.push('\n');
    if let Some(parent) = where_.parent() {
        std::fs::create_dir_all(parent).map_err(io("create", parent))?;
    }
    let mut tmp = where_.as_os_str().to_owned();
    tmp.push(".atelier-new");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text.as_bytes()).map_err(io("write", &tmp))?;
    std::fs::rename(&tmp, where_).map_err(io("replace", where_))?;
    Ok(())
}

/// Whether a hook command runs the gate of this name, under either spelling.
/// Mirrors `runs`.
fn runs_gate(command: Option<&serde_json::Value>, name: &str) -> bool {
    let text = command.and_then(|c| c.as_str()).unwrap_or("");
    text.split_whitespace()
        .any(|word| Path::new(word).file_name().map(|f| f == name).unwrap_or(false))
}

fn sorted_entries(dir: &Path) -> Result<Vec<std::ffi::OsString>, String> {
    let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(dir)
        .map_err(io("read", dir))?
        .filter_map(|entry| entry.ok().map(|entry| entry.file_name()))
        .collect();
    names.sort();
    Ok(names)
}

fn remove_any(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(io("remove", path))
    } else {
        std::fs::remove_file(path).map_err(io("remove", path))
    }
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(io("link", link))
}

#[cfg(not(unix))]
fn symlink(target: &Path, link: &Path) -> Result<(), String> {
    let made = if target.is_dir() {
        std::os::windows::fs::symlink_dir(target, link)
    } else {
        std::os::windows::fs::symlink_file(target, link)
    };
    made.map_err(io("link", link))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    match std::env::var(name) {
        Ok(value) if !value.is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

fn io(action: &'static str, path: &Path) -> impl Fn(std::io::Error) -> String {
    let shown = path.display().to_string();
    move |e| format!("could not {action} {shown}: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Debug, PartialEq)]
    enum Node {
        Dir,
        Link(PathBuf),
        File(Vec<u8>),
    }

    /// Every path under a home, as a symlink (its target), a file (its bytes) or
    /// a directory — walked without following links, so a linked folder is
    /// recorded by where it points and never traversed.
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Node> {
        let mut out = BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let rel = path.strip_prefix(root).unwrap().to_path_buf();
                let meta = std::fs::symlink_metadata(&path).unwrap();
                if meta.file_type().is_symlink() {
                    out.insert(rel, Node::Link(std::fs::read_link(&path).unwrap()));
                } else if meta.is_dir() {
                    out.insert(rel, Node::Dir);
                    stack.push(path);
                } else {
                    out.insert(rel, Node::File(std::fs::read(&path).unwrap()));
                }
            }
        }
        out
    }

    fn rules_dir() -> PathBuf {
        std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap()
    }

    /// Run `machinery/join --personal` into a sandbox, or None when this computer
    /// has no Python to run it with — the case this port exists to serve.
    fn what_join_personal_writes(sandbox: &Path) -> Option<()> {
        let rules = rules_dir();
        let join = rules.join("machinery").join("join");
        if !join.is_file() {
            return None;
        }
        let python = crate::routes::find_python()?;
        let done = std::process::Command::new(python)
            .arg(&join)
            .arg("--personal")
            .env("ATELIER_CLAUDE_HOME", sandbox.join("claude"))
            .env("ATELIER_CODEX_HOME", sandbox.join("codex"))
            .env("ATELIER_PERSONAL_BIN", sandbox.join("bin"))
            .env("ATELIER_GATE_WORD", crate::identity::NAME)
            .env("HOME", sandbox.join("home"))
            .env("ATELIER_DATA_DIR", sandbox.join("data"))
            .output()
            .ok()?;
        assert!(
            done.status.success(),
            "join --personal failed: {}",
            String::from_utf8_lossy(&done.stderr)
        );
        Some(())
    }

    /// The differential case: the Rust port must leave the very same tree the
    /// Python it replaces leaves — the same links to the same folders, and the
    /// same provider settings byte for byte.
    #[test]
    fn personal_setup_links_exactly_what_join_personal_links() {
        let theirs_home = tempfile::tempdir().expect("a folder");
        if what_join_personal_writes(theirs_home.path()).is_none() {
            eprintln!("no python on this computer, so the two were not compared");
            return;
        }
        let ours_home = tempfile::tempdir().expect("a folder");
        let homes = Homes {
            claude: ours_home.path().join("claude"),
            codex: ours_home.path().join("codex"),
            personal_bin: ours_home.path().join("bin"),
        };
        install(&rules_dir(), &homes).expect("the native personal setup to run");

        let trim = |m: BTreeMap<PathBuf, Node>| -> BTreeMap<PathBuf, Node> {
            m.into_iter()
                .filter(|(p, _)| {
                    let first = p.iter().next().and_then(|s| s.to_str()).unwrap_or("");
                    matches!(first, "claude" | "codex" | "bin")
                })
                .collect()
        };
        let theirs = trim(snapshot(theirs_home.path()));
        let ours = trim(snapshot(ours_home.path()));

        // The three skill folders are the heart of the check: prove each is a
        // symlink and points where Python's does, before the whole-tree compare.
        for provider in ["claude", "codex"] {
            for skill in SKILLS {
                let rel = PathBuf::from(provider).join("skills").join(skill);
                assert!(
                    matches!(ours.get(&rel), Some(Node::Link(_))),
                    "{} is not a symlink",
                    rel.display()
                );
                assert_eq!(
                    ours.get(&rel),
                    theirs.get(&rel),
                    "{} differs from what join --personal linked",
                    rel.display()
                );
            }
        }
        assert_eq!(
            ours, theirs,
            "the native personal setup and join --personal left different trees"
        );
    }
}
