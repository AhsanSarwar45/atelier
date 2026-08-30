//! Personal provider cleanup, ported from `machinery/join --personal`.
//!
//! A sibling change (bw-6z1f) retired Atelier's personal provider skills: the
//! machinery no longer links its craft, its three skill folders, the
//! external-review runner or a session-context hook into a reader's homes. So
//! `join --personal` is now purely a *removal* — it takes back only the
//! artifacts a past release demonstrably owned and leaves everything else, the
//! reader's own work, untouched. This is that same removal in native Rust, so
//! `atelier init` and `atelier service install` no longer need a Python
//! interpreter to tidy a machine up (bw-oesd.1.5).
//!
//! It links NOTHING. Every path here is either removed because Atelier owns it
//! or kept because it does not.

use std::path::{Path, PathBuf};

/// The craft a past release linked one item at a time from the rules' `.claude/`
/// into the Claude home, and the SHA-256 of each source when it was retired.
/// A broken symlink to one of these is Atelier's; a byte-identical copy of one
/// is Atelier's; anything else at the same name is the reader's own. Mirrors
/// `LEGACY_SHARED`/`LEGACY_FILE_HASHES` in `machinery/join`.
const LEGACY_SHARED: &[(&str, &str, &str)] = &[
    ("agents", "general-purpose.md", "d63abf84950747f2a2b1365a9c95d1a53ac847d836b88371d1a47d7f502dbb27"),
    ("agents", "researcher.md", "7244154fe1f74ed7083add634f557466e8d42eaaad4b0ebeb5ea1fb9aca7c2c7"),
    ("agents", "reviewer.md", "d2a8b3dfbf0f3eabc202899698b179577657d6746af94b55a698ec345746ca10"),
    ("agents", "scout.md", "eb39e1a12379b12aba74399f2c3b921e087ea1a81792e1087049bece094eb6fa"),
    ("agents", "screen-check.md", "c6e85486bc4dbf5aa376a3465c4e14db2d116e6394faba774aebe2f2dd31dc90"),
    ("skills", "compact-handoff", "47a5030d409d23812427cb2d2211002429bbcaf14f3d706a80a362ffa2ba7b03"),
    ("skills", "judge-against-reference", "f121ff72200361d968cd0b7688e55364c3d8953784d8e96adc32a79d204009c6"),
    ("skills", "read-image", "e811e46d5fe6dda247c6dbec87c8ae6c624680e2306ff7be463d607c45762e69"),
    ("skills", "spec", "5ab2c25e8cd877b4790a286434e6a8ad7773356268a28356224725c87436f080"),
    ("output-styles", "manager.md", "e48731c823d89c79fce251b12ccf1a27e0d38a26ced452b518a72ce67ecb27b1"),
    ("commands", "docs-cleanup.md", "5fe37092730a7f63d79c246d5add5c359b4a07e79d44c2c499b4f77a82a65876"),
];

/// The three skill folders a past release exposed to both providers. A symlink
/// under a provider's `skills/` by one of these names, pointing at the
/// machinery's own copy, is Atelier's to remove. Mirrors the tuple in `install`.
const PROVIDER_SKILLS: [&str; 3] = ["atelier", "beads", "external-review"];

/// Where the personal artifacts were installed: a reader's Claude home, their
/// Codex home, and their personal bin. `join` reads the same three under the
/// same overrides, so a differential test can point both at a sandbox.
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
            "this computer names no home folder to tidy personal skills out of".to_string()
        })?;
        Ok(Homes {
            claude: env_dir("ATELIER_CLAUDE_HOME").unwrap_or_else(|| home.join(".claude")),
            codex: env_dir("ATELIER_CODEX_HOME").unwrap_or_else(|| home.join(".codex")),
            personal_bin: env_dir("ATELIER_PERSONAL_BIN")
                .unwrap_or_else(|| home.join(".local").join("bin")),
        })
    }
}

/// Remove only the personal provider artifacts a past release demonstrably owned.
///
/// `<rules_dir>/machinery` is where the skills and the external-review runner
/// were linked from; `<rules_dir>/.claude` is where the shared craft was. A
/// symlink into either that still resolves to its old source is Atelier's, as is
/// a byte-identical copy of a retired craft file and the legacy session-context
/// hook. Everything else is left exactly where it is. On the first filesystem
/// error this stops and reports it, the way `install_tolerantly` abandons
/// `install` on the first `OSError`; the callers treat that as a warning.
pub fn install(rules_dir: &Path, homes: &Homes) -> Result<(), String> {
    // Resolve the rules once, so a legacy symlink's `realpath` and the source
    // path it is compared against are canonical in the same way (as `join`'s
    // `abspath(__file__)` makes them when the rules path holds no symlink).
    let rules_dir = std::fs::canonicalize(rules_dir).unwrap_or_else(|_| rules_dir.to_path_buf());
    let machinery = rules_dir.join("machinery");
    let craft = rules_dir.join(".claude");

    remove_legacy_shared(&craft, &homes.claude)?;
    remove_provider_skills(&machinery, homes)?;
    remove_external_review(&machinery, homes)?;
    remove_session_hooks(homes, &machinery)?;
    Ok(())
}

/// The `for kind, names in LEGACY_SHARED` loop: a symlink back to the retired
/// craft is removed; a byte-identical copy of it is removed (and an emptied
/// skill folder taken away with it); anything else at the name is the reader's.
fn remove_legacy_shared(craft: &Path, claude: &Path) -> Result<(), String> {
    for &(kind, name, hash) in LEGACY_SHARED {
        let where_ = claude.join(kind);
        if !where_.is_dir() {
            continue;
        }
        let link = where_.join(name);
        let target = craft.join(kind).join(name);
        if owned(&link, &target) {
            std::fs::remove_file(&link).map_err(io("remove", &link))?;
            continue;
        }
        // A copy taken in whole rather than linked: the file itself for a craft
        // item, the `SKILL.md` inside for a skill folder.
        let copied = if kind == "skills" {
            link.join("SKILL.md")
        } else {
            link.clone()
        };
        let matches = std::fs::read(&copied)
            .map(|bytes| sha256_hex(&bytes) == hash)
            .unwrap_or(false);
        if matches {
            std::fs::remove_file(&copied).map_err(io("remove", &copied))?;
            if kind == "skills" {
                // rmdir, and only if it is now empty — a reader who added a file
                // of their own beside it keeps the folder. `OSError` is ignored,
                // as `join` ignores it.
                let _ = std::fs::remove_dir(&link);
            }
        }
    }
    Ok(())
}

/// The `for provider in (MACHINE, CODEX_MACHINE)` loop: drop each of the three
/// skill links that still points at the machinery's own copy.
fn remove_provider_skills(machinery: &Path, homes: &Homes) -> Result<(), String> {
    for provider in [&homes.claude, &homes.codex] {
        for name in PROVIDER_SKILLS {
            let link = provider.join("skills").join(name);
            let target = machinery.join("skills").join(name);
            if owned(&link, &target) {
                std::fs::remove_file(&link).map_err(io("remove", &link))?;
            }
        }
    }
    Ok(())
}

/// Take back the external-review runner from the personal bin, if the link there
/// still resolves to the machinery's own script.
fn remove_external_review(machinery: &Path, homes: &Homes) -> Result<(), String> {
    let link = homes.personal_bin.join("external-review");
    let target = machinery
        .join("external-review")
        .join("scripts")
        .join("external_review.py");
    if owned(&link, &target) {
        std::fs::remove_file(&link).map_err(io("remove", &link))?;
    }
    Ok(())
}

/// Whether `link` is a symlink Atelier owns: one that resolves to exactly
/// `target`. A broken link (its source retired) is read straight off the link,
/// so it is still recognised; a live one is canonicalised, so a source reached
/// through a symlinked path is recognised too. Mirrors `os.path.islink(link) and
/// os.path.realpath(link) == target`.
fn owned(link: &Path, target: &Path) -> bool {
    match std::fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            std::fs::read_link(link)
                .map(|read| read.as_path() == target)
                .unwrap_or(false)
                || std::fs::canonicalize(link)
                    .map(|real| real.as_path() == target)
                    .unwrap_or(false)
        }
        _ => false,
    }
}

/// Strip the legacy session-context hook from each provider's settings, keeping
/// every neighbouring hook. Mirrors `remove_session_hooks`.
fn remove_session_hooks(homes: &Homes, machinery: &Path) -> Result<(), String> {
    let word = crate::identity::NAME;
    strip_session_file(&homes.claude.join("settings.json"), machinery, word)?;
    strip_session_file(&homes.codex.join("hooks.json"), machinery, word)?;
    Ok(())
}

fn strip_session_file(where_: &Path, machinery: &Path, word: &str) -> Result<(), String> {
    use serde_json::Value;

    if !where_.exists() {
        return Ok(());
    }
    let text = match std::fs::read_to_string(where_) {
        Ok(text) => text,
        Err(why) => {
            eprintln!(
                "kept   {} — legacy hook cannot be removed safely ({why})",
                where_.display()
            );
            return Ok(());
        }
    };
    let mut held: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(why) => {
            eprintln!(
                "kept   {} — legacy hook cannot be removed safely ({why})",
                where_.display()
            );
            return Ok(());
        }
    };

    if !strip_in_place(&mut held, where_, machinery, word) {
        return Ok(());
    }

    let mut out = serde_json::to_string_pretty(&held)
        .map_err(|e| format!("could not serialise {}: {e}", where_.display()))?;
    out.push('\n');
    let mut tmp = where_.as_os_str().to_owned();
    tmp.push(".atelier-new");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, out.as_bytes()).map_err(io("write", &tmp))?;
    std::fs::rename(&tmp, where_).map_err(io("replace", where_))?;
    Ok(())
}

/// Edit the settings in place; return whether a hook was actually removed (and
/// so the file must be rewritten). Every guard that `remove_session_hooks` walks
/// away from — not a settings object, no `SessionStart`, its blocks not a list —
/// is a `false` here, leaving the file exactly as it was found.
fn strip_in_place(
    held: &mut serde_json::Value,
    where_: &Path,
    machinery: &Path,
    word: &str,
) -> bool {
    use serde_json::Value;

    let Some(obj) = held.as_object_mut() else {
        eprintln!("kept   {} — it is not a settings object", where_.display());
        return false;
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return false;
    };
    if !hooks.contains_key("SessionStart") {
        return false;
    }
    let Some(blocks) = hooks
        .get_mut("SessionStart")
        .and_then(|b| b.as_array_mut())
    else {
        eprintln!(
            "kept   {} — its SessionStart hooks are not a list",
            where_.display()
        );
        return false;
    };

    let mut changed = false;
    for block in blocks.iter_mut() {
        if let Some(bobj) = block.as_object_mut() {
            let before: Vec<Value> = bobj
                .get("hooks")
                .and_then(|h| h.as_array())
                .cloned()
                .unwrap_or_default();
            let after: Vec<Value> = before
                .iter()
                .filter(|hook| {
                    !(hook.is_object() && context_hook(hook.get("command"), machinery, word))
                })
                .cloned()
                .collect();
            if after.len() != before.len() {
                changed = true;
            }
            bobj.insert("hooks".to_string(), Value::Array(after));
        }
    }
    // A block left holding nothing is not a block at all.
    blocks.retain(|block| {
        block
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    });
    changed
}

/// Whether a personal hook command is Atelier's old session-context hook: it
/// runs a `session-context.py`, and does so either through the machinery's own
/// home or under this program's own gate word. Mirrors `context_hook`. The
/// commands Atelier ever wrote here are unquoted, so a whitespace split reads
/// them the way `shlex` does.
fn context_hook(command: Option<&serde_json::Value>, machinery: &Path, word: &str) -> bool {
    let Some(command) = command.and_then(|c| c.as_str()) else {
        return false;
    };
    let words: Vec<&str> = command.split_whitespace().collect();
    let runs_context = words.iter().any(|w| {
        Path::new(w)
            .file_name()
            .map(|f| f == "session-context.py")
            .unwrap_or(false)
    });
    if !runs_context {
        return false;
    }
    let home = machinery.to_string_lossy();
    command.contains(home.as_ref())
        || (!word.is_empty() && words.len() >= 2 && words[0] == word && words[1] == "hook")
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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
    use std::path::Path;

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

    fn trim(m: BTreeMap<PathBuf, Node>) -> BTreeMap<PathBuf, Node> {
        m.into_iter()
            .filter(|(p, _)| {
                let first = p.iter().next().and_then(|s| s.to_str()).unwrap_or("");
                matches!(first, "claude" | "codex" | "bin")
            })
            .collect()
    }

    fn rules_dir() -> PathBuf {
        std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap()
    }

    fn link(target: &Path, at: &Path) {
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(target, at).unwrap();
    }

    fn file(at: &Path, bytes: &[u8]) {
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, bytes).unwrap();
    }

    /// A settings tree carrying two SessionStart blocks: one that also holds a
    /// neighbour's hook (kept, block survives) and one holding only the legacy
    /// hook (block emptied and pruned). Provider-neutral: seeded into both the
    /// Claude settings and the Codex hooks so the same strip runs on each.
    const SETTINGS: &str = r#"{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "atelier hook session-context.py" },
          { "type": "command", "command": "echo keep-me" }
        ]
      },
      {
        "matcher": "resume",
        "hooks": [
          { "type": "command", "command": "atelier hook session-context.py" }
        ]
      }
    ]
  },
  "permissions": { "defaultMode": "acceptEdits" }
}
"#;

    /// Seed one sandbox with a legacy artifact for each removal branch and a
    /// stranger for each keep branch. Owned symlinks point into the shared rules
    /// tree (the same absolute path in every sandbox), so two seeded sandboxes
    /// snapshot identically.
    fn seed(sandbox: &Path, rules: &Path) {
        let craft = rules.join(".claude");
        let machinery = rules.join("machinery");
        let claude = sandbox.join("claude");
        let codex = sandbox.join("codex");
        let bin = sandbox.join("bin");

        // Legacy shared craft under the Claude home: an owned symlink (removed),
        // a legacy-named symlink pointing elsewhere (kept), and a stranger file.
        link(
            &craft.join("agents").join("researcher.md"),
            &claude.join("agents").join("researcher.md"),
        );
        link(
            &machinery.join("join"),
            &claude.join("agents").join("scout.md"),
        );
        file(&claude.join("agents").join("other-agent.md"), b"not ours\n");
        link(
            &craft.join("skills").join("spec"),
            &claude.join("skills").join("spec"),
        );
        file(
            &claude.join("skills").join("mine").join("SKILL.md"),
            b"mine\n",
        );
        link(
            &craft.join("output-styles").join("manager.md"),
            &claude.join("output-styles").join("manager.md"),
        );

        // The three provider skills, into both homes. atelier/beads still have
        // live sources; external-review's was retired, so its link is broken —
        // both are owned and removed.
        for name in PROVIDER_SKILLS {
            link(
                &machinery.join("skills").join(name),
                &claude.join("skills").join(name),
            );
            link(
                &machinery.join("skills").join(name),
                &codex.join("skills").join(name),
            );
        }

        // The external-review runner in the personal bin (source retired, link
        // broken, still owned), beside a stranger tool.
        link(
            &machinery
                .join("external-review")
                .join("scripts")
                .join("external_review.py"),
            &bin.join("external-review"),
        );
        file(&bin.join("other-tool"), b"#!/bin/sh\n");

        // The legacy session hook in each provider's settings.
        file(&claude.join("settings.json"), SETTINGS.as_bytes());
        file(&codex.join("hooks.json"), SETTINGS.as_bytes());
    }

    fn run_join_personal(python: &Path, join: &Path, sandbox: &Path) -> std::process::Output {
        std::process::Command::new(python)
            .arg(join)
            .arg("--personal")
            .env("ATELIER_CLAUDE_HOME", sandbox.join("claude"))
            .env("ATELIER_CODEX_HOME", sandbox.join("codex"))
            .env("ATELIER_PERSONAL_BIN", sandbox.join("bin"))
            .env("ATELIER_GATE_WORD", crate::identity::NAME)
            .env("HOME", sandbox.join("home"))
            .env("ATELIER_DATA_DIR", sandbox.join("data"))
            .output()
            .expect("run machinery/join --personal")
    }

    /// The differential case: the Rust cleanup must leave the very same tree the
    /// Python it replaces leaves — the same owned artifacts gone, the same
    /// strangers kept, the same settings byte for byte — and must create nothing.
    ///
    /// (The byte-identical-copy removal branch is ported faithfully but cannot be
    /// exercised against a real match here: bw-6z1f deleted the craft sources, so
    /// no file hashing to a retired source's SHA-256 can be produced. The seeded
    /// copies therefore land on the keep side, which both engines honour alike.)
    #[test]
    fn personal_setup_links_exactly_what_join_personal_links() {
        let rules = rules_dir();
        let join = rules.join("machinery").join("join");
        if !join.is_file() {
            eprintln!("no machinery/join to compare against");
            return;
        }
        let Some(python) = crate::routes::find_python() else {
            eprintln!("no python on this computer, so the two were not compared");
            return;
        };

        // Seeded sandboxes: the same tree of legacy artifacts and strangers.
        let theirs = tempfile::tempdir().expect("a folder");
        let ours = tempfile::tempdir().expect("a folder");
        seed(theirs.path(), &rules);
        seed(ours.path(), &rules);
        let seeded = trim(snapshot(ours.path()));

        let done = run_join_personal(&python, &join, theirs.path());
        assert!(
            done.status.success(),
            "join --personal failed: {}",
            String::from_utf8_lossy(&done.stderr)
        );

        let homes = Homes {
            claude: ours.path().join("claude"),
            codex: ours.path().join("codex"),
            personal_bin: ours.path().join("bin"),
        };
        install(&rules, &homes).expect("the native personal cleanup to run");

        let theirs_tree = trim(snapshot(theirs.path()));
        let ours_tree = trim(snapshot(ours.path()));

        // Nothing was created: every surviving path was already seeded.
        for path in ours_tree.keys() {
            assert!(
                seeded.contains_key(path),
                "the cleanup created {} — personal setup must link nothing",
                path.display()
            );
        }

        // Every owned artifact is gone from our tree.
        for owned in [
            "claude/agents/researcher.md",
            "claude/skills/spec",
            "claude/output-styles/manager.md",
            "claude/skills/atelier",
            "claude/skills/beads",
            "claude/skills/external-review",
            "codex/skills/atelier",
            "codex/skills/beads",
            "codex/skills/external-review",
            "bin/external-review",
        ] {
            assert!(
                !ours_tree.contains_key(Path::new(owned)),
                "{owned} should have been removed"
            );
        }

        // The strangers are kept, and the settings are stripped to the same bytes.
        assert!(ours_tree.contains_key(Path::new("claude/agents/other-agent.md")));
        assert!(ours_tree.contains_key(Path::new("claude/agents/scout.md")));
        assert!(ours_tree.contains_key(Path::new("bin/other-tool")));

        // The whole-tree compare: the native cleanup and join --personal agree.
        assert_eq!(
            ours_tree, theirs_tree,
            "the native cleanup and join --personal left different trees"
        );
    }

    /// On a machine with nothing installed, both are no-ops: neither removes nor
    /// — the point of this port — creates anything.
    #[test]
    fn personal_setup_is_a_noop_on_a_clean_machine() {
        let rules = rules_dir();
        let join = rules.join("machinery").join("join");
        if !join.is_file() {
            eprintln!("no machinery/join to compare against");
            return;
        }
        let Some(python) = crate::routes::find_python() else {
            eprintln!("no python on this computer, so the two were not compared");
            return;
        };

        let theirs = tempfile::tempdir().expect("a folder");
        let ours = tempfile::tempdir().expect("a folder");

        let done = run_join_personal(&python, &join, theirs.path());
        assert!(
            done.status.success(),
            "join --personal failed: {}",
            String::from_utf8_lossy(&done.stderr)
        );
        install(
            &rules,
            &Homes {
                claude: ours.path().join("claude"),
                codex: ours.path().join("codex"),
                personal_bin: ours.path().join("bin"),
            },
        )
        .expect("the native personal cleanup to run");

        assert!(
            trim(snapshot(theirs.path())).is_empty(),
            "join --personal created something on a clean machine"
        );
        assert!(
            trim(snapshot(ours.path())).is_empty(),
            "the native cleanup created something on a clean machine"
        );
    }
}
