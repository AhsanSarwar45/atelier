//! Provider hook entry points that must work on an installed machine with no
//! Python. Hard refusals are limited to ownership, protected Git history and
//! truthful lifecycle transitions. Writing preferences only warn.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Word {
    text: String,
    start: usize,
    end: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Segment {
    words: Vec<Word>,
}

#[derive(Clone, Debug)]
struct BdCall<'a> {
    segment: &'a Segment,
    executable: usize,
    verb: usize,
}

#[derive(Clone, Debug)]
struct GitCall<'a> {
    segment: &'a Segment,
    verb: usize,
    cwd: PathBuf,
}

/// The Git verbs that always change a ref or a working tree.
///
/// This list is the rule, so it is written by what a command *does* rather
/// than by how often it is typed. `read-tree` and `update-ref` are here
/// because between them they are a merge, spelled differently
/// (`docs/hook-friction.md` §4): a gate that reads `merge` but not those two
/// is only selecting for agents who know the plumbing.
const ALWAYS_MUTATING_GIT: &[&str] = &[
    "add",
    "am",
    "checkout",
    "checkout-index",
    "cherry-pick",
    "clean",
    "commit",
    "fast-import",
    "filter-branch",
    "merge",
    "mv",
    "pull",
    "read-tree",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "switch",
    "update-index",
    "update-ref",
];

/// The redirect operators, longest first so `<<-` is never read as `<<`.
const REDIRECTS: &[&str] = &[
    "<<<", "<<-", "&>>", "<<", ">>", "&>", ">&", "<&", ">|", ">", "<",
];

/// The redirect operators that name a file to be written.
const WRITE_REDIRECTS: &[&str] = &[">", ">>", "&>", "&>>", ">|"];

pub const PROTOCOL_VERSION: u32 = 2;

pub fn version() -> String {
    format!(
        "Atelier workflow hooks {} (protocol {PROTOCOL_VERSION})",
        env!("CARGO_PKG_VERSION")
    )
}

const GATES: &[&str] = &[
    "workflow-gate",
    "board-actor",
    "board-merge-gate",
    "board-status-gate",
    "wait-gate",
    "board-touch",
    "board-prime",
    "board-gate",
    "landing-gate",
    "workflow-gate.py",
    "board-actor.py",
    "board-merge-gate.py",
    "board-status-gate.py",
    "wait-gate.py",
    "board-touch.py",
    "board-prime.py",
    "board-gate.py",
    "landing-gate.py",
    "habit-reading.py",
    "helper-proof.py",
    "plan-doc-lint.py",
    "slice-gate.py",
    "agent-fence.py",
    "picture-gate.py",
];

pub fn is_ours(name: &str) -> bool {
    GATES.contains(&name)
}

/// Answer one gate, for the event the caller already read and parsed.
///
/// Standard input is read once, by `rules::hook`, so that the escape hatch in
/// `hook_bypass` can see the same event every gate does.
pub fn run(name: &str, data: &Value) -> i32 {
    let output = match name {
        "board-actor" | "board-actor.py" => actor(data),
        "workflow-gate" | "workflow-gate.py" => workflow(data),
        "board-merge-gate" | "board-merge-gate.py" | "landing-gate" | "landing-gate.py" => {
            merge_gate(data)
        }
        "board-status-gate" | "board-status-gate.py" => status_gate(data),
        "board-touch" | "board-touch.py" => {
            touch(data);
            None
        }
        "board-prime" | "board-prime.py" => prime(data),
        "board-gate" | "board-gate.py" => stop_gate(data),
        "wait-gate" | "wait-gate.py" => {
            wait_warning(data);
            None
        }
        // Presentation and interaction-style hooks are deliberately retired.
        // Existing joined projects may still name them, so they answer here
        // rather than falling through to a Python script.
        _ => None,
    };
    if let Some(output) = output {
        println!("{}", output);
    }
    0
}

fn cwd(data: &Value) -> PathBuf {
    tool_input(data)["workdir"]
        .as_str()
        .map(PathBuf::from)
        .or_else(|| data["cwd"].as_str().map(PathBuf::from))
        .or_else(|| std::env::var_os("CLAUDE_PROJECT_DIR").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn root(data: &Value) -> PathBuf {
    let here = cwd(data);
    command(&here, "git", &["rev-parse", "--show-toplevel"])
        .filter(|(_, ok)| *ok)
        .map(|(out, _)| PathBuf::from(out.trim()))
        .unwrap_or(here)
}

fn tool_input(data: &Value) -> &Value {
    data.get("tool_input")
        .or_else(|| data.get("toolInput"))
        .unwrap_or(&Value::Null)
}

fn tool_name(data: &Value) -> &str {
    data.get("tool_name")
        .or_else(|| data.get("toolName"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn shell(data: &Value) -> &str {
    tool_input(data)["command"].as_str().unwrap_or("")
}
fn session(data: &Value) -> String {
    format!(
        "s-{}",
        data.get("session_id")
            .or_else(|| data.get("sessionId"))
            .and_then(Value::as_str)
            .unwrap_or("nosession")
            .chars()
            .take(8)
            .collect::<String>()
    )
}

fn command(root: &Path, program: &str, args: &[&str]) -> Option<(String, bool)> {
    let resolved = if program == "git" {
        crate::routes::find_git().unwrap_or_else(|| PathBuf::from(program))
    } else {
        PathBuf::from(program)
    };
    let output = Command::new(resolved)
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    Some((
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        output.status.success(),
    ))
}

fn bd(root: &Path, args: &[&str]) -> Option<Value> {
    let path = crate::routes::find_bd()?;
    let output = Command::new(path)
        .args(args)
        .current_dir(root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        Value::Object(_) => vec![value],
        _ => Vec::new(),
    }
}

fn pretool(decision: &str, reason: &str, updated: Option<Value>) -> Value {
    let mut output = json!({"hookEventName":"PreToolUse","permissionDecision":decision,
        "permissionDecisionReason":reason});
    if let Some(updated) = updated {
        output["updatedInput"] = updated;
    }
    json!({"hookSpecificOutput":output})
}

fn deny(reason: impl Into<String>) -> Option<Value> {
    Some(pretool("deny", &reason.into(), None))
}

fn redirect_at(command: &str, at: usize) -> Option<&'static str> {
    REDIRECTS
        .iter()
        .copied()
        .find(|operator| command[at..].starts_with(operator))
}

/// The running state of one pass over a command line.
struct Lexer<'a> {
    command: &'a str,
    segments: Vec<Segment>,
    words: Vec<Word>,
    text: String,
    start: usize,
    /// The word after `<<` names where the heredoc body ends.
    expect_delimiter: bool,
    strip_tabs: bool,
    /// Heredocs opened on the current line, still waiting for their bodies.
    pending: Vec<(String, bool)>,
}

impl<'a> Lexer<'a> {
    fn new(command: &'a str) -> Self {
        Lexer {
            command,
            segments: Vec::new(),
            words: Vec::new(),
            text: String::new(),
            start: 0,
            expect_delimiter: false,
            strip_tabs: false,
            pending: Vec::new(),
        }
    }

    fn push(&mut self, at: usize, character: char) {
        if self.text.is_empty() {
            self.start = at;
        }
        self.text.push(character);
    }

    fn finish_word(&mut self, at: usize) {
        if self.text.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.text);
        if self.expect_delimiter {
            self.expect_delimiter = false;
            self.pending.push((text.clone(), self.strip_tabs));
        }
        let start = self.start;
        self.words.push(Word {
            text,
            start,
            end: at,
        });
    }

    fn finish_segment(&mut self) {
        if !self.words.is_empty() {
            self.segments.push(Segment {
                words: std::mem::take(&mut self.words),
            });
        }
    }

    fn operator(&mut self, at: usize, operator: &str) {
        self.finish_word(at);
        self.words.push(Word {
            text: operator.to_string(),
            start: at,
            end: at + operator.len(),
        });
        if operator == "<<" || operator == "<<-" {
            self.expect_delimiter = true;
            self.strip_tabs = operator == "<<-";
        }
    }

    /// Step over the bodies of the heredocs opened on the line just ended.
    ///
    /// A heredoc body is data. Reading it as shell is how a document that
    /// merely names a path came to be refused as a write to that path
    /// (`docs/hook-friction.md` §3), and how prose containing `rm` came to be
    /// read as a deletion.
    fn skip_heredocs(&mut self, mut at: usize) -> usize {
        while !self.pending.is_empty() {
            let (delimiter, strip) = self.pending.remove(0);
            loop {
                if at >= self.command.len() {
                    return self.command.len();
                }
                let end = self.command[at..]
                    .find('\n')
                    .map(|found| at + found)
                    .unwrap_or(self.command.len());
                let line = &self.command[at..end];
                let candidate = if strip {
                    line.trim_start_matches('\t')
                } else {
                    line
                };
                at = (end + 1).min(self.command.len());
                if candidate.trim_end_matches('\r') == delimiter {
                    break;
                }
            }
        }
        at
    }
}

/// Split a command line into the segments a gate can reason about.
///
/// Quoted text and heredoc bodies are data, not command. Redirect operators
/// are kept as words of their own, so the target that follows one is never
/// mistaken for an ordinary argument and `2>&1` no longer looks like the `&`
/// that ends a command.
fn shell_segments(command: &str) -> Vec<Segment> {
    let bytes = command.as_bytes();
    let mut lexer = Lexer::new(command);
    let mut quote = 0u8;
    let mut escaped = false;
    let mut at = 0;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte >= 0x80 {
            // One character at a time, so a path with an accent in it survives
            // the pass instead of arriving as a run of replacement bytes.
            let character = command[at..]
                .chars()
                .next()
                .unwrap_or(char::REPLACEMENT_CHARACTER);
            lexer.push(at, character);
            escaped = false;
            at += character.len_utf8();
            continue;
        }
        if escaped {
            lexer.push(at, byte as char);
            escaped = false;
            at += 1;
            continue;
        }
        if quote != b'\'' && byte == b'\\' {
            if lexer.text.is_empty() {
                lexer.start = at;
            }
            escaped = true;
            at += 1;
            continue;
        }
        if quote == 0 && matches!(byte, b'\'' | b'"') {
            if lexer.text.is_empty() {
                lexer.start = at;
            }
            quote = byte;
            at += 1;
            continue;
        }
        if quote != 0 {
            if quote == byte {
                quote = 0;
            } else {
                lexer.push(at, byte as char);
            }
            at += 1;
            continue;
        }
        if byte.is_ascii_whitespace() {
            lexer.finish_word(at);
            at += 1;
            if byte == b'\n' {
                lexer.finish_segment();
                at = lexer.skip_heredocs(at);
            }
            continue;
        }
        if let Some(operator) = redirect_at(command, at) {
            lexer.operator(at, operator);
            at += operator.len();
            continue;
        }
        if matches!(byte, b';' | b'|' | b'&') {
            lexer.finish_word(at);
            lexer.finish_segment();
            at += if at + 1 < bytes.len() && bytes[at + 1] == byte {
                2
            } else {
                1
            };
            continue;
        }
        lexer.push(at, byte as char);
        at += 1;
    }
    lexer.finish_word(bytes.len());
    lexer.finish_segment();
    lexer.segments
}

fn executable(word: &str) -> &str {
    Path::new(word)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(word)
}

/// Where the command itself starts, past leading assignments and redirects.
fn first_command_word(segment: &Segment) -> usize {
    let mut at = 0;
    while let Some(word) = segment.words.get(at) {
        if REDIRECTS.contains(&word.text.as_str()) {
            at += 2;
            continue;
        }
        if word.text.contains('=') {
            at += 1;
            continue;
        }
        return at;
    }
    segment.words.len()
}

/// The value of a leading `NAME=...` assignment, if the command carries one.
///
/// Leading is the whole point: the word has to be in the position bash reads
/// as an assignment, so prose, an argument or a heredoc body that merely spells
/// the name out is not mistaken for someone setting it.
pub(crate) fn leading_assignment(command: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    shell_segments(command).into_iter().find_map(|segment| {
        let stop = first_command_word(&segment);
        segment.words[..stop]
            .iter()
            .find_map(|word| word.text.strip_prefix(&prefix))
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    })
}

fn bd_call(segment: &Segment) -> Option<BdCall<'_>> {
    let executable_at = first_command_word(segment);
    if executable(segment.words.get(executable_at)?.text.as_str()) != "bd" {
        return None;
    }
    let mut verb = executable_at + 1;
    while let Some(word) = segment.words.get(verb).map(|word| word.text.as_str()) {
        if matches!(
            word,
            "--actor" | "-C" | "--directory" | "--db" | "--database"
        ) {
            verb += 2;
            continue;
        }
        if ["--actor=", "--directory=", "--db=", "--database="]
            .iter()
            .any(|prefix| word.starts_with(prefix))
        {
            verb += 1;
            continue;
        }
        if matches!(
            word,
            "--global"
                | "--json"
                | "--readonly"
                | "--sandbox"
                | "--no-color"
                | "-q"
                | "--quiet"
                | "-v"
                | "--verbose"
        ) {
            verb += 1;
            continue;
        }
        break;
    }
    segment.words.get(verb)?;
    Some(BdCall {
        segment,
        executable: executable_at,
        verb,
    })
}

fn call_cwd(initial: &Path, words: &[Word], executable: usize, names: &[&str]) -> PathBuf {
    let mut cwd = initial.to_path_buf();
    let mut at = executable + 1;
    while let Some(word) = words.get(at).map(|word| word.text.as_str()) {
        if names.contains(&word) {
            let Some(named) = words.get(at + 1).map(|word| PathBuf::from(&word.text)) else {
                break;
            };
            cwd = if named.is_absolute() {
                named
            } else {
                cwd.join(named)
            };
            at += 2;
            continue;
        }
        if let Some(named) = names
            .iter()
            .find_map(|name| word.strip_prefix(&format!("{name}=")))
        {
            let named = PathBuf::from(named);
            cwd = if named.is_absolute() {
                named
            } else {
                cwd.join(named)
            };
        }
        at += 1;
    }
    cwd
}

fn bd_cwd(call: &BdCall<'_>, initial: &Path) -> PathBuf {
    call_cwd(
        initial,
        &call.segment.words[..call.verb],
        call.executable,
        &["-C", "--directory"],
    )
}

fn git_call<'a>(segment: &'a Segment, initial: &Path) -> Option<GitCall<'a>> {
    let executable_at = first_command_word(segment);
    if executable(segment.words.get(executable_at)?.text.as_str()) != "git" {
        return None;
    }
    let mut cwd = initial.to_path_buf();
    let mut verb = executable_at + 1;
    while let Some(word) = segment.words.get(verb).map(|word| word.text.as_str()) {
        if matches!(
            word,
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace"
        ) {
            let named = PathBuf::from(segment.words.get(verb + 1)?.text.as_str());
            if word == "-C" {
                cwd = if named.is_absolute() {
                    named
                } else {
                    cwd.join(named)
                };
            }
            verb += 2;
        } else if let Some(named) = word.strip_prefix("-C") {
            if named.is_empty() {
                return None;
            }
            let named = PathBuf::from(named);
            cwd = if named.is_absolute() {
                named
            } else {
                cwd.join(named)
            };
            verb += 1;
        } else if word.starts_with('-') {
            verb += 1;
        } else {
            return Some(GitCall { segment, verb, cwd });
        }
    }
    None
}

fn git_mutates(call: &GitCall<'_>) -> bool {
    let verb = call.segment.words[call.verb].text.as_str();
    let args = &call.segment.words[call.verb + 1..];
    if ALWAYS_MUTATING_GIT.contains(&verb) {
        return true;
    }
    match verb {
        "apply" => !args.iter().any(|word| word.text == "--check"),
        "branch"
            if args
                .iter()
                .any(|word| matches!(word.text.as_str(), "-l" | "--list")) =>
        {
            false
        }
        "branch" => args.iter().any(|word| {
            matches!(word.text.as_str(), "-d" | "-D" | "-m" | "-M" | "-c" | "-C")
                || !word.text.starts_with('-')
        }),
        "tag"
            if args
                .iter()
                .any(|word| matches!(word.text.as_str(), "-l" | "--list")) =>
        {
            false
        }
        "tag" => args
            .iter()
            .any(|word| word.text == "-d" || !word.text.starts_with('-')),
        "stash" => args
            .first()
            .is_none_or(|word| !matches!(word.text.as_str(), "list" | "show")),
        "worktree" => args.first().is_some_and(|word| {
            matches!(
                word.text.as_str(),
                "add" | "lock" | "move" | "prune" | "remove" | "repair" | "unlock"
            )
        }),
        "push" => !args
            .iter()
            .any(|word| matches!(word.text.as_str(), "--dry-run" | "-n")),
        "symbolic-ref" => {
            args.iter()
                .any(|word| matches!(word.text.as_str(), "-d" | "--delete"))
                || args.iter().filter(|word| !word.text.starts_with('-')).count() > 1
        }
        "replace" => {
            args.iter()
                .any(|word| matches!(word.text.as_str(), "-d" | "--delete"))
                || args.iter().any(|word| !word.text.starts_with('-'))
        }
        "notes" => args
            .first()
            .is_some_and(|word| !matches!(word.text.as_str(), "list" | "show")),
        "sparse-checkout" => args
            .first()
            .is_some_and(|word| word.text.as_str() != "list"),
        "reflog" => args
            .first()
            .is_some_and(|word| matches!(word.text.as_str(), "expire" | "delete" | "drop")),
        "submodule" => args.first().is_some_and(|word| {
            matches!(
                word.text.as_str(),
                "add" | "update" | "init" | "deinit" | "sync" | "set-url" | "set-branch"
                    | "absorbgitdirs"
            )
        }),
        _ => false,
    }
}

/// A thing a command would change: what the command called it, the directory
/// that name was resolved against, and where it came to.
///
/// A refusal that names only the resolved path is the hardest kind to act on
/// when the command held no absolute path at all — a relative target resolved
/// from a working directory the agent did not expect looks impossible until
/// both ends are said (`docs/hook-friction-2.md` §2).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Target {
    named: String,
    from: PathBuf,
    path: PathBuf,
}

impl Target {
    fn named(here: &Path, named: &str) -> Self {
        Target {
            named: named.to_string(),
            from: here.to_path_buf(),
            path: path_from(here, named),
        }
    }

    /// A whole directory, changed by a command that works in place.
    fn here(here: &Path) -> Self {
        let here = tidy(here);
        Target {
            named: String::new(),
            from: here.clone(),
            path: here,
        }
    }

    /// How a refusal says where this came from. The resolution is only worth
    /// spelling out when it did something — an absolute path resolved to
    /// itself.
    fn spelled(&self) -> String {
        if self.named.is_empty() || Path::new(&self.named).is_absolute() {
            return format!("resolved target: {}", self.path.display());
        }
        format!(
            "target `{}` resolved from {} \u{2192} {}",
            self.named,
            self.from.display(),
            self.path.display()
        )
    }
}

fn path_from(here: &Path, text: &str) -> PathBuf {
    let path = PathBuf::from(text);
    tidy(&if path.is_absolute() {
        path
    } else {
        here.join(path)
    })
}

/// A path with its `.` and `..` steps taken, without asking the disk.
///
/// The target of a refusal often does not exist yet, so it cannot be
/// canonicalized — and a message that reads
/// `worktrees/bw-1/../../src/lib.rs` explains a resolution by obscuring it.
fn tidy(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => match out.components().next_back() {
                // `/..` is `/`, and a `..` with nothing above it to take is
                // part of where the path points.
                Some(std::path::Component::RootDir) => {}
                Some(std::path::Component::Normal(_)) => {
                    out.pop();
                }
                _ => out.push(part),
            },
            part => out.push(part),
        }
    }
    if out.as_os_str().is_empty() {
        return PathBuf::from(".");
    }
    out
}

/// The checkout every worktree of a repository shares.
///
/// `git_root` answers with the worktree it was asked from, so two worktrees of
/// one project look like two projects to it. Deciding whether a new worktree
/// belongs to this project is exactly the question it cannot answer.
fn project_root(path: &Path) -> Option<PathBuf> {
    let mut probe = path;
    while !probe.is_dir() {
        probe = probe.parent()?;
    }
    command(
        probe,
        "git",
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .filter(|(_, ok)| *ok)
    .map(|(out, _)| PathBuf::from(out.trim()))
    .filter(|path| !path.as_os_str().is_empty())
    .and_then(|path| path.parent().map(Path::to_path_buf))
}

/// Does this target name a file the worktree rule is about?
///
/// The null device, the character devices generally, the process and system
/// pseudo-filesystems, and bash's own `/dev/tcp` socket paths are not files: a
/// write to one leaves nothing behind in any working tree and cannot escape
/// one. Refusing them was `docs/hook-friction.md` §1 and §2 — the commonest way
/// to silence a command, and the project's own way of probing a port, both
/// refused by a rule about editing a repository. A file descriptor
/// duplication (`>&2`) and a process substitution are not files either.
fn writes_a_file(target: &str) -> bool {
    if target.is_empty() || target.starts_with('&') || target.starts_with('(') {
        return false;
    }
    let path = Path::new(target);
    !["/dev", "/proc", "/sys"]
        .iter()
        .any(|special| path.starts_with(special))
}

/// The arguments of a command, with its redirects and their targets removed.
fn operands(args: &[Word]) -> Vec<&str> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(word) = args.get(at) {
        if REDIRECTS.contains(&word.text.as_str()) {
            at += 2;
            continue;
        }
        if !word.text.starts_with('-') {
            out.push(word.text.as_str());
        }
        at += 1;
    }
    out
}

fn shell_file_targets(segment: &Segment, here: &Path) -> Vec<Target> {
    let at = first_command_word(segment);
    let Some(name) = segment.words.get(at).map(|word| executable(&word.text)) else {
        return Vec::new();
    };
    let args = &segment.words[at + 1..];
    let operands = operands(args);
    let targets: Vec<&str> = match name {
        "cp" | "install" | "ln" => operands.last().into_iter().copied().collect(),
        "mv" | "rm" | "mkdir" | "touch" | "truncate" | "tee" => operands,
        "chmod" | "chown" => operands.into_iter().skip(1).collect(),
        "sed"
            if args
                .iter()
                .any(|word| word.text == "-i" || word.text.starts_with("-i")) =>
        {
            operands.last().into_iter().copied().collect()
        }
        _ => Vec::new(),
    };
    targets
        .into_iter()
        .filter(|target| writes_a_file(target))
        .map(|target| Target::named(here, target))
        .collect()
}

fn redirection_targets(segment: &Segment, here: &Path) -> Vec<Target> {
    segment
        .words
        .windows(2)
        .filter(|pair| WRITE_REDIRECTS.contains(&pair[0].text.as_str()))
        .map(|pair| pair[1].text.as_str())
        .filter(|target| writes_a_file(target))
        .map(|target| Target::named(here, target))
        .collect()
}

fn calls(command: &str, initial: &Path) -> Vec<(Segment, PathBuf)> {
    let mut cwd = initial.to_path_buf();
    let mut out = Vec::new();
    for segment in shell_segments(command) {
        let executable_at = first_command_word(&segment);
        if segment
            .words
            .get(executable_at)
            .is_some_and(|word| executable(&word.text) == "cd")
        {
            if let Some(named) = segment.words.get(executable_at + 1) {
                let named = PathBuf::from(&named.text);
                cwd = if named.is_absolute() {
                    named
                } else {
                    cwd.join(named)
                };
            }
        } else {
            out.push((segment, cwd.clone()));
        }
    }
    out
}

fn actor(data: &Value) -> Option<Value> {
    if tool_name(data) != "Bash" {
        return None;
    }
    let original = shell(data);
    let who = session(data);
    let parsed = calls(original, &cwd(data));
    let mut insertions: Vec<(usize, String)> = Vec::new();
    for (segment, here) in &parsed {
        let Some(call) = bd_call(segment) else {
            continue;
        };
        let effective = bd_cwd(&call, here);
        let copy = issue_at(&effective)
            .or_else(|| worktree_issue(&effective))
            .unwrap_or_else(|| "main".to_string());
        let args = &call.segment.words[call.executable + 1..];
        let has_actor = args
            .iter()
            .any(|word| word.text == "--actor" || word.text.starts_with("--actor="));
        if !has_actor {
            insertions.push((
                call.segment.words[call.executable].end,
                format!(" --actor {who}"),
            ));
        }
        let is_update_claim = call.segment.words[call.verb].text == "update"
            && call
                .segment
                .words
                .get(call.verb + 1)
                .is_some_and(|word| !word.text.starts_with('-'))
            && call.segment.words[call.verb + 2..]
                .iter()
                .any(|word| word.text == "--claim");
        let has_copy = args
            .windows(2)
            .any(|pair| pair[0].text == "--add-label" && pair[1].text.starts_with("copy:"))
            || args
                .iter()
                .any(|word| word.text.starts_with("--add-label=copy:"));
        if is_update_claim && !has_copy {
            let claim = call.segment.words[call.verb + 2..]
                .iter()
                .find(|word| word.text == "--claim")
                .unwrap();
            insertions.push((claim.end, format!(" --add-label copy:{copy}")));
        }
    }
    let mut stamped = original.to_string();
    insertions.sort_by_key(|(at, _)| *at);
    for (at, value) in insertions.into_iter().rev() {
        stamped.insert_str(at, &value);
    }
    if stamped == original {
        return None;
    }
    let mut updated = tool_input(data).clone();
    updated["command"] = json!(stamped);
    Some(pretool("allow", "board identity", Some(updated)))
}

/// What one command in a line would change.
fn segment_targets(segment: &Segment, here: &Path) -> Vec<Target> {
    let mut targets = redirection_targets(segment, here);
    if let Some(call) = bd_call(segment) {
        if matches!(
            call.segment.words[call.verb].text.as_str(),
            "close" | "create" | "reopen" | "update"
        ) {
            targets.push(Target::here(&bd_cwd(&call, here)));
        }
        return targets;
    }
    if let Some(call) = git_call(segment, here) {
        if git_mutates(&call) && !lands(&call) && !isolates(&call) {
            targets.push(Target::here(&call.cwd));
        }
        return targets;
    }
    targets.extend(shell_file_targets(segment, here));
    targets
}

fn mutation_targets(data: &Value) -> Vec<Target> {
    match tool_name(data) {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "apply_patch" => {
            let named = [
                "file_path",
                "filePath",
                "notebook_path",
                "notebookPath",
                "path",
            ]
            .iter()
            .find_map(|key| tool_input(data)[key].as_str());
            vec![match named {
                Some(named) => Target::named(&cwd(data), named),
                None => Target::here(&cwd(data)),
            }]
        }
        "Bash" => calls(shell(data), &cwd(data))
            .into_iter()
            .flat_map(|(segment, here)| segment_targets(&segment, &here))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
fn mutation_paths(data: &Value) -> Vec<PathBuf> {
    mutation_targets(data)
        .into_iter()
        .map(|target| target.path)
        .collect()
}

/// A fast-forward merge, which is how finished work lands.
///
/// It writes nothing of its own: it moves a branch onto commits that were
/// written, named and reviewed under their own card, in that card's worktree.
/// The landing branch's checkout is not anybody's card worktree and never can
/// be, so the ownership rule would refuse every landing there is — and refuse
/// it in the one place the instructions say to do it. The merge gate is what
/// governs a landing (fast-forward only, the merge slot's holder, a clean tree),
/// so leave this to it.
fn lands(call: &GitCall<'_>) -> bool {
    call.segment.words[call.verb].text == "merge"
        && call.segment.words[call.verb + 1..]
            .iter()
            .any(|word| word.text == "--ff-only")
}

/// `git worktree add worktrees/<ID> -b <ID>`, which builds the isolation the
/// ownership rule demands rather than breaching it.
///
/// The rule is that a repository change needs an owned card in its own
/// worktree. This is the command the instructions give for making that
/// worktree, so refusing it made the state the gate requires unreachable from
/// a clean start: the only cards claimable without a bypass were the ones
/// already claimed (`docs/hook-friction-2.md` §3). The carve-out is the exact
/// documented shape and nothing else — the destination must sit in the
/// project's own worktree directory, be named for the card, and the branch
/// being created must be that same card. Every other `worktree` subcommand
/// stays gated.
fn isolates(call: &GitCall<'_>) -> bool {
    if call.segment.words[call.verb].text != "worktree" {
        return false;
    }
    let arguments = &call.segment.words[call.verb + 1..];
    let words = operands(arguments);
    if words.first() != Some(&"add") {
        return false;
    }
    let Some(destination) = words.get(1).map(|text| path_from(&call.cwd, text)) else {
        return false;
    };
    let Some(issue) = worktree_issue(&destination) else {
        return false;
    };
    let leaf = destination.file_name().and_then(|name| name.to_str());
    if leaf != Some(issue.as_str()) && leaf != Some(format!("bd-{issue}").as_str()) {
        return false;
    }
    // A `worktrees/<ID>` component is not enough on its own: the new worktree
    // has to belong to the project it is a worktree of.
    if project_root(&destination) != project_root(&call.cwd) {
        return false;
    }
    arguments
        .windows(2)
        .filter(|pair| matches!(pair[0].text.as_str(), "-b" | "-B"))
        .any(|pair| pair[1].text == issue)
}

fn worktree_issue(path: &Path) -> Option<String> {
    let parts: Vec<_> = path
        .components()
        .filter_map(|part| part.as_os_str().to_str())
        .collect();
    parts.windows(2).find_map(|pair| match pair[0] {
        "worktrees" => Some(pair[1].to_string()),
        ".worktrees" => Some(pair[1].strip_prefix("bd-").unwrap_or(pair[1]).to_string()),
        _ => None,
    })
}

fn git_root(path: &Path) -> Option<PathBuf> {
    let mut probe = path;
    while !probe.is_dir() {
        probe = probe.parent()?;
    }
    command(probe, "git", &["rev-parse", "--show-toplevel"])
        .filter(|(_, ok)| *ok)
        .map(|(out, _)| PathBuf::from(out.trim()))
}

fn issue_at(path: &Path) -> Option<String> {
    let project = git_root(path)?;
    let branch = current_branch(&project);
    if branch.starts_with("bw-") {
        Some(branch)
    } else {
        worktree_issue(&project)
    }
}

fn claim_transition(data: &Value) -> Option<(String, PathBuf)> {
    let parsed = calls(shell(data), &cwd(data));
    let bd_calls: Vec<usize> = parsed
        .iter()
        .enumerate()
        .filter(|(_, (segment, _))| bd_call(segment).is_some())
        .map(|(at, _)| at)
        .collect();
    let &[at] = bd_calls.as_slice() else {
        return None;
    };
    // The line may do other things, so long as none of them would change
    // anything: making the worktree and stepping into it are the two commands
    // the documented start of work puts either side of the claim
    // (`docs/hook-friction-2.md` §3). Anything that writes is judged on its
    // own merits, which keeps `rm file && bd update ID --claim` refused.
    if parsed
        .iter()
        .enumerate()
        .any(|(other, (segment, here))| other != at && !segment_targets(segment, here).is_empty())
    {
        return None;
    }
    let (segment, from) = &parsed[at];
    let call = bd_call(segment)?;
    let here = &bd_cwd(&call, from);
    let call = &call;
    if call.segment.words[call.verb].text != "update" {
        return None;
    }
    let issue = call.segment.words.get(call.verb + 1)?.text.clone();
    if issue.starts_with('-')
        || !call.segment.words[call.verb + 2..]
            .iter()
            .any(|word| word.text == "--claim")
    {
        return None;
    }
    Some((issue, here.clone()))
}

/// The worktree a line makes for itself, when it makes the one it then claims.
///
/// The documented start of work is three commands on one line: make the
/// worktree, step into it, claim the card. A gate runs before any of them, so
/// the worktree it would want to see does not exist yet, and judging the claim
/// on a directory the same line is about to create refuses the whole
/// documented opening (`docs/hook-friction-2.md` §3).
fn isolation_made(data: &Value, issue: &str) -> Option<PathBuf> {
    calls(shell(data), &cwd(data))
        .into_iter()
        .filter_map(|(segment, here)| {
            let call = git_call(&segment, &here)?;
            let arguments = &call.segment.words[call.verb + 1..];
            let destination = operands(arguments).get(1).copied()?;
            isolates(&call).then(|| path_from(&call.cwd, destination))
        })
        .find(|made| worktree_issue(made).as_deref() == Some(issue))
}

fn creates_first_work(data: &Value) -> bool {
    let parsed = calls(shell(data), &cwd(data));
    parsed.len() == 1
        && bd_call(&parsed[0].0).is_some_and(|call| call.segment.words[call.verb].text == "create")
}

fn expired(card: &Value) -> bool {
    card["lease_expires_at"]
        .as_str()
        .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
        .is_some_and(|when| when < chrono::Utc::now())
}

fn claimable(card: &Value, who: &str) -> bool {
    let assignee = card["assignee"].as_str().unwrap_or("");
    (card["status"].as_str() == Some("open") && assignee.is_empty())
        || assignee == who
        || expired(card)
}

fn ownership_refusal(card: &Value, issue: &str, who: &str) -> Option<String> {
    if card["status"].as_str() != Some("in_progress") {
        return Some(format!(
            "Beads issue {issue} must be claimed and in_progress before this worktree is changed."
        ));
    }
    let assignee = card["assignee"].as_str().unwrap_or("");
    if !assignee.is_empty() && assignee != who {
        return Some(format!(
            "Beads issue {issue} is owned by {assignee}, not this session."
        ));
    }
    None
}

fn workflow(data: &Value) -> Option<Value> {
    let targets = mutation_targets(data);
    if targets.is_empty() {
        return None;
    }
    if creates_first_work(data) {
        return None;
    }
    if let Some((issue, here)) = claim_transition(data) {
        let isolated = issue_at(&here).as_deref() == Some(&issue)
            || isolation_made(data, &issue).as_deref() == Some(here.as_path());
        if !isolated {
            return deny(format!(
                "Claim {issue} from its own isolated worktree, not {}.",
                here.display()
            ));
        }
        let project = command(&here, "git", &["rev-parse", "--show-toplevel"])
            .filter(|(_, ok)| *ok)
            .map(|(out, _)| PathBuf::from(out))
            .unwrap_or(here);
        let Some(card) = bd(&project, &["show", &issue, "--json"])
            .and_then(|value| rows(value).into_iter().next())
        else {
            // Preserve the existing outage behavior for an already isolated,
            // correctly named worktree.
            return None;
        };
        if claimable(&card, &session(data)) {
            return None;
        }
        return deny(format!(
            "Beads issue {issue} is owned by {}, not this session.",
            card["assignee"].as_str().unwrap_or("another session")
        ));
    }
    for target in targets {
        // A path in no Git worktree is not a change to anybody's work: a
        // scratch file, a temporary directory, a log outside the project. The
        // rule is about repository changes, so a target with no repository is
        // simply not its business (`docs/hook-friction.md` §1).
        let Some(project) = git_root(&target.path) else {
            continue;
        };
        let Some(issue) = issue_at(&project) else {
            return deny(format!(
                "Changes require an owned Beads work item in its isolated worktree ({}).",
                target.spelled()
            ));
        };
        let Some(card) =
            bd(&project, &["show", &issue, "--json"]).and_then(|v| rows(v).into_iter().next())
        else {
            // An isolated Git worktree on a task branch is enough during a temporary board outage.
            continue;
        };
        if let Some(reason) = ownership_refusal(&card, &issue, &session(data)) {
            return deny(format!("{reason} The {}.", target.spelled()));
        }
    }
    None
}

fn current_branch(root: &Path) -> String {
    command(root, "git", &["branch", "--show-current"])
        .map(|v| v.0)
        .unwrap_or_default()
}

fn landing_branch(root: &Path) -> String {
    let candidates = ["ours", "main", "master"];
    candidates
        .into_iter()
        .find(|name| {
            command(
                root,
                "git",
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{name}"),
                ],
            )
            .is_some_and(|(_, ok)| ok)
        })
        .unwrap_or("main")
        .to_string()
}

fn merge_refusal(
    on_landing: bool,
    fast_forward: bool,
    holder: &str,
    who: &str,
    overwritten: &[String],
) -> Option<String> {
    if !on_landing {
        return None;
    }
    if !fast_forward {
        return Some(
            "A merge into the landing branch must be a fast-forward (`git merge --ff-only`)."
                .into(),
        );
    }
    if !holder.is_empty() && holder != who {
        return Some(format!(
            "The merge slot is held by {holder}; only its owner may land."
        ));
    }
    if !overwritten.is_empty() {
        return Some(format!(
            "The landing worktree has its own uncommitted changes to {}, which this merge would overwrite; commit or stash those files first.",
            overwritten.join(", ")
        ));
    }
    None
}

/// The files this landing would write over, out of those already changed here.
///
/// Demanding a spotless tree refused a landing whenever the checkout held any
/// unrelated edit — which, on a working machine, it usually does
/// (`docs/hook-friction.md` §4). A fast-forward only writes the files it
/// actually changes, so those are the only ones worth protecting.
fn overwritten_by(project: &Path, branch: &str) -> Vec<String> {
    let changing: Vec<String> = command(project, "git", &["diff", "--name-only", "HEAD", branch])
        .filter(|(_, ok)| *ok)
        .map(|(out, _)| out.lines().map(str::to_string).collect())
        .unwrap_or_default();
    if changing.is_empty() {
        return Vec::new();
    }
    // `diff --name-only HEAD` rather than `status --porcelain`: it names the
    // tracked files that differ from the commit, staged or not, with no status
    // column to parse off the front of each line.
    command(project, "git", &["diff", "--name-only", "HEAD"])
        .filter(|(_, ok)| *ok)
        .map(|(out, _)| {
            out.lines()
                .filter(|path| changing.iter().any(|changed| changed == path))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn merge_gate(data: &Value) -> Option<Value> {
    let parsed = calls(shell(data), &cwd(data));
    for (segment, here) in &parsed {
        let Some(call) = git_call(segment, here) else {
            continue;
        };
        if call.segment.words[call.verb].text != "merge" {
            continue;
        }
        let project = command(&call.cwd, "git", &["rev-parse", "--show-toplevel"])
            .filter(|(_, ok)| *ok)
            .map(|(out, _)| PathBuf::from(out))
            .unwrap_or(call.cwd.clone());
        let on_landing = current_branch(&project) == landing_branch(&project);
        let fast_forward = call.segment.words[call.verb + 1..]
            .iter()
            .any(|word| word.text == "--ff-only");
        let who = session(data);
        let slot = bd(
            &project,
            &["merge-slot", "check", "--json", "--actor", &who],
        );
        let holder = slot
            .as_ref()
            .and_then(|value| value["holder"].as_str().or_else(|| value["owner"].as_str()))
            .unwrap_or("");
        let branch = call.segment.words[call.verb + 1..]
            .iter()
            .find(|word| !word.text.starts_with('-') && !REDIRECTS.contains(&word.text.as_str()))
            .map(|word| word.text.clone())
            .unwrap_or_default();
        let overwritten = if on_landing && fast_forward && !branch.is_empty() {
            overwritten_by(&project, &branch)
        } else {
            Vec::new()
        };
        if let Some(reason) = merge_refusal(on_landing, fast_forward, holder, &who, &overwritten) {
            return deny(reason);
        }
    }
    None
}

fn no_commit(card: &Value) -> bool {
    card["issue_type"]
        .as_str()
        .is_some_and(|t| matches!(t, "epic" | "decision"))
        || card["labels"].as_array().is_some_and(|labels| {
            labels.iter().any(|l| {
                matches!(
                    l.as_str(),
                    Some("job" | "no-code" | "find" | "question" | "decision")
                )
            })
        })
}

fn subject_names(subject: &str, id: &str) -> bool {
    subject
        .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '.')))
        .any(|word| word == id)
}

fn landed(root: &Path, id: &str) -> bool {
    command(root, "git", &["log", &landing_branch(root), "--format=%s"])
        .is_some_and(|(out, ok)| ok && out.lines().any(|subject| subject_names(subject, id)))
}

fn flag_value(words: &[Word], name: &str) -> Option<String> {
    words
        .iter()
        .position(|word| word.text == name)
        .and_then(|at| words.get(at + 1))
        .map(|word| word.text.clone())
        .or_else(|| {
            words.iter().find_map(|word| {
                word.text
                    .strip_prefix(&format!("{name}="))
                    .map(str::to_string)
            })
        })
}

fn labels(card: &Value) -> Vec<&str> {
    card["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn passing_check(text: &str, tree: &str) -> bool {
    text.contains(&format!("checks: tree {tree} "))
        && text.contains("=PASSED")
        && !text.contains("=FAILED")
}

/// The name a run's evidence is filed under: the tree of what is committed.
///
/// A tree, not a commit. It is what a run actually checked, it is what the
/// evidence says (`checks: tree HASH ...`), and it survives the thing that
/// happens to every card here — a rebase, which gives the same files a new
/// commit. Read as a commit, a green run's own evidence went stale the moment
/// its branch was rebased, and no checks card could be closed at all
/// (bw-zd18).
fn checked_tree(root: &Path) -> Option<String> {
    let (tree, ok) = command(root, "git", &["rev-parse", "HEAD^{tree}"])?;
    (ok && !tree.is_empty()).then_some(tree)
}

fn fresh_checks(root: &Path, id: &str, card: &Value) -> bool {
    if !labels(card).contains(&"step:checks") {
        return true;
    }
    let Some(tree) = checked_tree(root) else {
        return false;
    };
    let comments = bd(root, &["comments", id, "--json"])
        .map(rows)
        .unwrap_or_default();
    comments.iter().any(|comment| {
        let text = comment["text"]
            .as_str()
            .or_else(|| comment["body"].as_str())
            .or_else(|| comment["comment"].as_str())
            .unwrap_or("");
        passing_check(text, &tree)
    })
}

/// The `bd` flags that take a separate value, so the value is never read as
/// the card the command is about.
///
/// `bd update --status closed bw-1` used to be read as a command about a card
/// named `closed`, which no board has — so the whole gate stood down and the
/// close went through unchecked.
const BD_FLAGS_WITH_VALUES: &[&str] = &[
    "--status",
    "-s",
    "--reason",
    "--assignee",
    "-a",
    "--priority",
    "-p",
    "--type",
    "-t",
    "--title",
    "--parent",
    "--description",
    "-d",
    "--acceptance",
    "--design",
    "--add-label",
    "--remove-label",
    "-l",
    "--set-metadata",
    "--append-notes",
    "--notes",
    "--limit",
    "--actor",
    "--db",
    "--database",
    "--directory",
    "-C",
];

/// The card a `bd` call is about.
fn subject_id(arguments: &[Word]) -> Option<String> {
    let mut at = 0;
    while let Some(word) = arguments.get(at) {
        let text = word.text.as_str();
        if REDIRECTS.contains(&text) {
            at += 2;
            continue;
        }
        if text.starts_with('-') {
            at += if BD_FLAGS_WITH_VALUES.contains(&text) {
                2
            } else {
                1
            };
            continue;
        }
        return Some(text.to_string());
    }
    None
}

fn manager_review_refusal(card: &Value, id: &str) -> Option<String> {
    (card["status"].as_str() == Some("manager_review"))
        .then(|| format!("{id} is in the manager's column and only the manager may move it."))
}

fn status_gate(data: &Value) -> Option<Value> {
    for (segment, here) in calls(shell(data), &cwd(data)) {
        let Some(call) = bd_call(&segment) else {
            continue;
        };
        let here = bd_cwd(&call, &here);
        let verb = call.segment.words[call.verb].text.as_str();
        if verb == "create" {
            eprintln!("warning: direct bd create skips optional ticket-writing guidance");
        }
        let arguments = &call.segment.words[call.verb + 1..];
        let status = flag_value(arguments, "--status").or_else(|| flag_value(arguments, "-s"));
        let closing = verb == "close" || status.as_deref() == Some("closed");
        let reviewing = matches!(
            status.as_deref(),
            Some("in_review" | "inreview" | "manager_review")
        );
        let moving = status.is_some() || verb == "reopen";
        if !closing && !moving {
            continue;
        }
        if closing
            && arguments
                .iter()
                .any(|word| matches!(word.text.as_str(), "--force" | "-f"))
        {
            return deny("A forced close can skip blockers and unfinished children; close truthfully without --force.");
        }
        let Some(id) = subject_id(arguments) else {
            continue;
        };
        let project = command(&here, "git", &["rev-parse", "--show-toplevel"])
            .filter(|(_, ok)| *ok)
            .map(|(out, _)| PathBuf::from(out))
            .unwrap_or(here);
        let Some(card) =
            bd(&project, &["show", &id, "--json"]).and_then(|v| rows(v).into_iter().next())
        else {
            continue;
        };
        if let Some(reason) = manager_review_refusal(&card, &id) {
            return deny(reason);
        }
        if (closing || reviewing) && !no_commit(&card) && !landed(&project, &id) {
            return deny(format!(
                "{id} cannot advance: no commit naming it has reached {}.",
                landing_branch(&project)
            ));
        }
        if closing {
            // Tracked changes only: an untracked scratch file, a build
            // artifact or a log is not unfinished work, and refusing a close
            // over one is a refusal that protects nothing.
            if !no_commit(&card)
                && command(
                    &project,
                    "git",
                    &["status", "--porcelain", "--untracked-files=no"],
                )
                .is_some_and(|(out, ok)| ok && !out.is_empty())
            {
                return deny(format!(
                    "{id} cannot close while its worktree has uncommitted changes to tracked files."
                ));
            }
            if !fresh_checks(&project, &id, &card) {
                return deny(format!("{id} is the checks step and has no fresh passing evidence for the current Git tree."));
            }
            let children = bd(
                &project,
                &[
                    "list", "--parent", &id, "--status", "all", "--limit", "0", "--json",
                ],
            )
            .map(rows)
            .unwrap_or_default();
            if children
                .iter()
                .any(|row| row["status"].as_str() != Some("closed"))
            {
                return deny(format!("{id} still has unfinished children."));
            }
            let gates = bd(&project, &["gate", "list", "--json"])
                .map(rows)
                .unwrap_or_default();
            if gates.iter().any(|row| {
                row["status"].as_str() != Some("closed")
                    && (row["parent"].as_str() == Some(&id)
                        || row["issue_id"].as_str() == Some(&id))
            }) {
                return deny(format!("{id} still has unresolved review gates."));
            }
        }
    }
    None
}

/// How often a heartbeat is worth a round trip to the board.
///
/// `board-touch` runs after every tool call. Asking the board for the
/// session's cards, heartbeating them and advancing the goal each time put two
/// or three database round trips in front of every edit an agent made.
const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(45);

/// Has enough time passed to be worth telling the board this session is alive?
///
/// A missing or unreadable stamp means yes: the throttle exists to save time,
/// never to lose a heartbeat.
fn heartbeat_due(who: &str, project: &Path) -> bool {
    let Some(directory) = crate::identity::data_dir().map(|dir| dir.join("heartbeat")) else {
        return true;
    };
    if std::fs::create_dir_all(&directory).is_err() {
        return true;
    }
    let mut mixed: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in project.to_string_lossy().bytes() {
        mixed = (mixed ^ u64::from(byte)).wrapping_mul(0x100_0000_01b3);
    }
    let stamp = directory.join(format!("{who}-{mixed:016x}"));
    let fresh = std::fs::metadata(&stamp)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|when| when.elapsed().ok())
        .is_some_and(|age| age < HEARTBEAT_INTERVAL);
    if fresh {
        return false;
    }
    let _ = std::fs::write(&stamp, "");
    true
}

fn touch(data: &Value) {
    let who = session(data);
    let mut projects: Vec<PathBuf> = mutation_targets(data)
        .into_iter()
        .filter_map(|target| git_root(&target.path))
        .collect();
    if projects.is_empty() {
        projects.push(root(data));
    }
    projects.sort();
    projects.dedup();
    for project in projects {
        if !heartbeat_due(&who, &project) {
            continue;
        }
        let Some(cards) = bd(
            &project,
            &[
                "list",
                "--assignee",
                &who,
                "--status",
                "in_progress",
                "--limit",
                "0",
                "--json",
            ],
        )
        .map(rows) else {
            continue;
        };
        let ids: Vec<String> = cards
            .iter()
            .filter_map(|card| card["id"].as_str().map(str::to_string))
            .collect();
        if !ids.is_empty() {
            if let Some(path) = crate::routes::find_bd() {
                let _ = Command::new(path)
                    .arg("--actor")
                    .arg(&who)
                    .arg("heartbeat")
                    .args(&ids)
                    .current_dir(&project)
                    .status();
            }
        }
        crate::board_tools::advance_all(&project);
    }
}

fn prime(data: &Value) -> Option<Value> {
    let project = root(data);
    let who = session(data);
    let ready = bd(&project, &["ready", "--limit", "8", "--json"])
        .map(rows)
        .unwrap_or_default();
    let names: Vec<String> = ready
        .iter()
        .filter_map(|card| {
            Some(format!(
                "{} P{} {}",
                card["id"].as_str()?,
                card["priority"].as_i64().unwrap_or(2),
                card["title"].as_str().unwrap_or("")
            ))
        })
        .collect();
    let context = format!("Board actor: {who}. Claim work before editing; work in its isolated worktree; name the card in commits; use fast-forward landings; do not move cards out of manager review. Ticket prose preferences are guidance, not hard gates.{}",
        if names.is_empty() { String::new() } else { format!("\n\nReady now:\n  {}", names.join("\n  ")) });
    Some(json!({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":context}}))
}

fn stop_gate(data: &Value) -> Option<Value> {
    if data["stop_hook_active"].as_bool() == Some(true) {
        return None;
    }
    let project = root(data);
    let who = session(data);
    let cards = bd(
        &project,
        &[
            "list",
            "--assignee",
            &who,
            "--status",
            "in_progress",
            "--limit",
            "0",
            "--json",
        ],
    )
    .map(rows)
    .unwrap_or_default();
    if cards.is_empty() {
        return None;
    }
    let ids: Vec<&str> = cards
        .iter()
        .filter_map(|card| card["id"].as_str())
        .collect();
    let message = data["last_assistant_message"].as_str().unwrap_or("");
    if message.contains('?') || message.to_ascii_lowercase().contains("blocked") {
        return None;
    }
    Some(
        json!({"decision":"block","reason":format!("Owned work is still open: {}. Continue, close it truthfully, or state the concrete blocker.", ids.join(", "))}),
    )
}

fn wait_warning(data: &Value) {
    let text = shell(data);
    if text.contains("sleep ") && (text.contains("while ") || text.contains("until ")) {
        eprintln!("warning: this foreground polling loop can consume an agent turn; use a background command when practical");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_machinery_updated_hook_input_is_an_explicit_allow() {
        let value = pretool(
            "allow",
            "board identity",
            Some(json!({"command":"bd --actor s-test show x-1"})),
        );
        assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(value["hookSpecificOutput"]["updatedInput"].is_object());
    }

    #[test]
    fn native_machinery_hook_protocol_has_an_installed_provenance_number() {
        assert_eq!(PROTOCOL_VERSION, 2);
        assert!(version().contains("protocol 2"));
    }

    #[test]
    fn native_machinery_ticket_prose_is_not_a_hard_gate() {
        let data = json!({"tool_name":"Bash","tool_input":{"command":"bd create --title 'Fix duplicate cards'"}});
        assert!(status_gate(&data).is_none());
    }

    #[test]
    fn native_machinery_uses_explicit_tool_workdir() {
        let data = json!({"cwd":"/wrong", "tool_input":{"workdir":"/right"}});
        assert_eq!(cwd(&data), PathBuf::from("/right"));

        let claude = json!({"cwd":"/wrong", "toolInput":{"workdir":"/right"}});
        assert_eq!(cwd(&claude), PathBuf::from("/right"));
    }

    #[test]
    fn native_machinery_accepts_snake_and_camel_provider_envelopes() {
        let snake = json!({"tool_name":"Bash", "session_id":"abcdefghijk",
            "tool_input":{"command":"git -C /repo/worktrees/bw-1 commit -m saved"}});
        let camel = json!({"toolName":"Bash", "sessionId":"abcdefghijk",
            "toolInput":{"command":"git -C /repo/worktrees/bw-1 commit -m saved"}});

        assert_eq!(tool_name(&snake), "Bash");
        assert_eq!(tool_name(&camel), "Bash");
        assert_eq!(session(&snake), "s-abcdefgh");
        assert_eq!(session(&camel), "s-abcdefgh");
        assert_eq!(mutation_paths(&snake), mutation_paths(&camel));
    }

    #[test]
    fn native_machinery_resolves_each_mutation_target_instead_of_the_hook_cwd() {
        let add = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command":"git -C /repo/worktrees/bw-1 add src/lib.rs"}});
        let commit = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command":"cd worktrees/bw-1 && git commit -m saved"}});
        assert_eq!(
            mutation_paths(&add),
            vec![PathBuf::from("/repo/worktrees/bw-1")]
        );
        assert_eq!(
            mutation_paths(&commit),
            vec![PathBuf::from("/repo/worktrees/bw-1")]
        );

        let edit = json!({"tool_name":"Edit", "cwd":"/repo",
            "toolInput":{"filePath":"/repo/worktrees/bw-1/src/lib.rs"}});
        assert_eq!(
            mutation_paths(&edit),
            vec![PathBuf::from("/repo/worktrees/bw-1/src/lib.rs")]
        );

        let files = json!({"tool_name":"Bash", "cwd":"/repo", "tool_input":{
            "command":"cd worktrees/bw-1 && cp source ../bw-2/copied && echo done>notes.txt"}});
        assert_eq!(
            mutation_paths(&files),
            vec![
                PathBuf::from("/repo/worktrees/bw-2/copied"),
                PathBuf::from("/repo/worktrees/bw-1/notes.txt"),
            ]
        );
    }

    /// A document is not a command. Refusing a heredoc because its prose named
    /// a path was `docs/hook-friction.md` §3, and it made the worktree's own
    /// preferred tool unable to write the file describing the problem.
    #[test]
    fn native_machinery_a_heredoc_body_is_data_not_command() {
        let doc = "cat > docs/hook-friction.md <<'EOF'\n\
            Refused with `The mutation target ... /dev/nul`, quoting prose.\n\
            rm -rf /etc > /somewhere/else\n\
            EOF\n";
        let data = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command": doc}});
        assert_eq!(
            mutation_paths(&data),
            vec![PathBuf::from("/repo/worktrees/bw-1/docs/hook-friction.md")],
            "the body was read as commands"
        );

        // The tab-stripping form ends at its delimiter too, and what follows
        // the body is a command again.
        let after = "cat <<-END > kept.txt\n\tbody\n\tEND\nrm gone.txt\n";
        let data = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command": after}});
        assert_eq!(
            mutation_paths(&data),
            vec![
                PathBuf::from("/repo/worktrees/bw-1/kept.txt"),
                PathBuf::from("/repo/worktrees/bw-1/gone.txt"),
            ]
        );
    }

    /// The null device, a socket path and a file-descriptor duplication are
    /// not files, and the commonest reason to write one is to say nothing
    /// (`docs/hook-friction.md` §1 and §2).
    #[test]
    fn native_machinery_only_real_files_are_redirect_targets() {
        let quiet = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1", "tool_input":{
            "command":"grep -n pattern file 2>/dev/null >>/dev/null && echo hi >&2"}});
        assert!(mutation_paths(&quiet).is_empty());

        let probe = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1", "tool_input":{
            "command":"echo > /dev/tcp/127.0.0.1/3008"}});
        assert!(mutation_paths(&probe).is_empty());

        let real = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1", "tool_input":{
            "command":"cargo build > build.log 2>&1"}});
        assert_eq!(
            mutation_paths(&real),
            vec![PathBuf::from("/repo/worktrees/bw-1/build.log")]
        );
    }

    /// `2>&1` is a redirect, not the `&` that ends a command, so what follows
    /// it stays part of the same call.
    #[test]
    fn native_machinery_a_descriptor_redirect_does_not_end_the_command() {
        let data = json!({"tool_name":"Bash", "cwd":"/repo", "tool_input":{
            "command":"git -C worktrees/bw-1 commit -m saved 2>&1 | tee -a /dev/null"}});
        assert_eq!(
            mutation_paths(&data),
            vec![PathBuf::from("/repo/worktrees/bw-1")]
        );
    }

    #[test]
    fn native_machinery_words_survive_a_command_with_accents_in_it() {
        let segments = shell_segments("touch caf\u{e9}/na\u{ef}ve.txt");
        let words: Vec<&str> = segments[0].words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(words, vec!["touch", "caf\u{e9}/na\u{ef}ve.txt"]);
    }

    /// A gate that reads the value of `--status` as the card it is judging
    /// judges a card that does not exist, and then stands down entirely.
    #[test]
    fn native_machinery_a_flag_value_is_never_mistaken_for_the_card() {
        let subject = |command: &str| {
            let segments = shell_segments(command);
            let call = bd_call(&segments[0]).unwrap();
            subject_id(&segments[0].words[call.verb + 1..])
        };
        assert_eq!(subject("bd update --status closed bw-1").as_deref(), Some("bw-1"));
        assert_eq!(subject("bd update bw-1 --status closed").as_deref(), Some("bw-1"));
        assert_eq!(
            subject("bd close --reason 'done here' bw-1").as_deref(),
            Some("bw-1")
        );
        assert_eq!(subject("bd update --status=closed bw-1").as_deref(), Some("bw-1"));
    }

    /// The escape hatch has to be readable off the command a gate is judging,
    /// and only where bash would read it as an assignment.
    #[test]
    fn native_machinery_a_leading_assignment_is_the_only_bypass_a_command_carries() {
        assert_eq!(
            leading_assignment(
                "ATELIER_BYPASS='no way to land' git merge --ff-only bw-1",
                "ATELIER_BYPASS"
            )
            .as_deref(),
            Some("no way to land")
        );
        assert_eq!(
            leading_assignment("true && ATELIER_BYPASS=stuck rm notes.txt", "ATELIER_BYPASS")
                .as_deref(),
            Some("stuck")
        );
        for command in [
            "echo ATELIER_BYPASS=x",
            "git commit -m 'ATELIER_BYPASS=x'",
            "ATELIER_BYPASS= git status",
        ] {
            assert!(
                leading_assignment(command, "ATELIER_BYPASS").is_none(),
                "excused by: {command}"
            );
        }
    }

    /// A refusal that names only where a relative path landed makes the one
    /// thing the agent cannot see the only thing it says
    /// (`docs/hook-friction-2.md` §2).
    #[test]
    fn native_machinery_a_refusal_says_both_ends_of_the_resolution() {
        let here = Path::new("/repo");
        assert_eq!(
            Target::named(here, "tests/run.log").spelled(),
            "target `tests/run.log` resolved from /repo \u{2192} /repo/tests/run.log"
        );
        // An absolute path resolved to itself; saying so twice explains nothing.
        assert_eq!(
            Target::named(here, "/elsewhere/run.log").spelled(),
            "resolved target: /elsewhere/run.log"
        );
        assert_eq!(Target::here(here).spelled(), "resolved target: /repo");
        // The steps are taken, so the reader sees where it actually landed.
        assert_eq!(
            Target::named(Path::new("/repo/worktrees/bw-1"), "../../src/lib.rs").spelled(),
            "target `../../src/lib.rs` resolved from /repo/worktrees/bw-1 \u{2192} /repo/src/lib.rs"
        );
    }

    #[test]
    fn native_machinery_tidies_a_path_without_asking_the_disk() {
        assert_eq!(tidy(Path::new("/a/./b/../c")), PathBuf::from("/a/c"));
        assert_eq!(tidy(Path::new("/a/.")), PathBuf::from("/a"));
        // Nothing above the root to pop, and a relative path keeps the steps
        // it cannot take.
        assert_eq!(tidy(Path::new("/../a")), PathBuf::from("/a"));
        assert_eq!(tidy(Path::new("../a")), PathBuf::from("../a"));
        assert_eq!(tidy(Path::new(".")), PathBuf::from("."));
    }

    /// The gate treated its own two preconditions as breaches of itself, so
    /// the state it demanded could never be reached from a clean start
    /// (`docs/hook-friction-2.md` §3).
    #[test]
    fn native_machinery_lets_a_session_earn_the_worktree_the_rule_demands() {
        let home = tempfile::tempdir().unwrap();
        let repo = home.path().join("project");
        std::fs::create_dir(&repo).unwrap();
        assert!(Command::new("git")
            .args(["init", "-q", "-b", "ours"])
            .current_dir(&repo)
            .status()
            .unwrap()
            .success());
        let isolating = |command: &str| {
            let segments = shell_segments(command);
            segments
                .iter()
                .filter_map(|segment| git_call(segment, &repo))
                .any(|call| isolates(&call))
        };

        assert!(isolating("git -C . worktree add worktrees/bw-1 -b bw-1"));
        assert!(isolating("git worktree add worktrees/bw-1 -b bw-1"));
        assert!(isolating("git worktree add .worktrees/bd-bw-1 -b bw-1"));

        // The branch must be the card the destination is named for, the
        // destination must be the project's own worktree directory, and no
        // other subcommand is the rule being obeyed.
        assert!(!isolating("git worktree add worktrees/bw-1 -b other"));
        assert!(!isolating("git worktree add worktrees/sneaky -b bw-1"));
        assert!(!isolating("git worktree add worktrees/bw-1"));
        assert!(!isolating("git worktree remove worktrees/bw-1"));
        assert!(!isolating("git worktree add /elsewhere/worktrees/bw-1 -b bw-1"));
    }

    /// The documented opening is three commands on one line, and the gate runs
    /// before any of them: the worktree it wants to see is the one the line is
    /// about to make.
    #[test]
    fn native_machinery_reads_the_claim_a_whole_opening_line_makes() {
        let opening = "git -C . worktree add worktrees/bw-1 -b bw-1\n\
            cd worktrees/bw-1\n\
            bd update bw-1 --claim";
        let data = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command": opening}});
        assert_eq!(
            claim_transition(&data).unwrap(),
            ("bw-1".to_string(), PathBuf::from("/repo/worktrees/bw-1")),
            "the claim is the only thing this line changes"
        );
        assert_eq!(
            isolation_made(&data, "bw-1"),
            Some(PathBuf::from("/repo/worktrees/bw-1")),
            "the line makes the worktree it then claims into"
        );

        // A command that writes rides along with nothing excusing it.
        let smuggled = json!({"tool_name":"Bash", "cwd":"/repo", "tool_input":{"command":
            "cd worktrees/bw-1\nrm ../../src/lib.rs && bd update bw-1 --claim"}});
        assert!(claim_transition(&smuggled).is_none());

        // And a claim into a worktree nothing in the line creates is still
        // judged on the worktree it names.
        let elsewhere = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command":"bd update bw-1 --claim"}});
        assert_eq!(isolation_made(&elsewhere, "bw-1"), None);
    }

    #[test]
    fn native_machinery_git_reads_remain_ungated_while_writes_share_one_rule() {
        for command in [
            "git status",
            "git branch --show-current",
            "git branch --list bw-1",
            "git tag --list 'v*'",
            "git worktree list",
            "git stash list",
            "git apply --check fix.patch",
        ] {
            let data = json!({"tool_name":"Bash", "cwd":"/repo", "tool_input":{"command":command}});
            assert!(
                mutation_paths(&data).is_empty(),
                "treated read as mutation: {command}"
            );
        }
        for command in [
            "git add src",
            "git commit -m saved",
            "git branch bw-1",
            "git tag v1",
            "git worktree add ../one bw-1",
            "git stash push",
            "git apply fix.patch",
        ] {
            let data = json!({"tool_name":"Bash", "cwd":"/repo", "tool_input":{"command":command}});
            assert_eq!(
                mutation_paths(&data),
                vec![PathBuf::from("/repo")],
                "missed write: {command}"
            );
        }
    }

    #[test]
    fn native_machinery_git_global_options_do_not_become_fake_verbs() {
        let data = json!({"tool_name":"Bash", "cwd":"/repo", "tool_input":{
            "command":"git -c advice.detachedHead=false -C worktrees/bw-1 commit -m saved"}});
        assert_eq!(
            mutation_paths(&data),
            vec![PathBuf::from("/repo/worktrees/bw-1")]
        );
    }

    #[test]
    fn native_machinery_discovers_issue_from_git_branch_not_folder_shape() {
        let repo = tempfile::tempdir().unwrap();
        let git = crate::routes::find_git().unwrap();
        let status = Command::new(git)
            .args(["init", "-q", "-b", "bw-anywhere"])
            .current_dir(repo.path())
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(issue_at(repo.path()).as_deref(), Some("bw-anywhere"));
    }

    #[test]
    fn native_machinery_stamps_bd_and_only_labels_update_claim() {
        let ready = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"bd ready --claim"}});
        let value = actor(&ready).expect("all bd calls receive an actor");
        assert_eq!(
            value["hookSpecificOutput"]["updatedInput"]["command"],
            "bd --actor s-test ready --claim"
        );

        let update = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"bd update bw-1 --claim"}});
        let value = actor(&update).expect("a claim transition is rewritten");
        assert_eq!(value["hookSpecificOutput"]["permissionDecision"], "allow");
        assert!(value["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .contains("--claim --add-label copy:bw-1"));

        let chained = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo",
            "tool_input":{"command":"cd .worktrees/bd-bw-2 && bd update bw-2 --claim"}});
        let command = actor(&chained).unwrap()["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(command.contains("--add-label copy:bw-2"), "{command}");

        let show = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo",
            "tool_input":{"command":"echo before && /usr/local/bin/bd show bw-1 | bd list"}});
        let value = actor(&show).expect("both real bd calls are stamped");
        assert_eq!(
            value["hookSpecificOutput"]["updatedInput"]["command"],
            "echo before && /usr/local/bin/bd --actor s-test show bw-1 | bd --actor s-test list"
        );

        let every = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo",
            "tool_input":{"command":"bd ready || bd show bw-1; bd list\nbd blocked"}});
        let command = actor(&every).unwrap()["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(command.matches("bd --actor s-test").count(), 4, "{command}");
    }

    #[test]
    fn native_machinery_does_not_duplicate_actor_or_copy_label() {
        let data = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/.worktrees/bd-bw-1",
            "tool_input":{"command":"bd --actor somebody update bw-1 --claim --add-label copy:bw-1"}});
        assert!(actor(&data).is_none());

        let data = json!({"tool_name":"Bash", "session_id":"test", "cwd":"/repo/.worktrees/bd-bw-2",
            "tool_input":{"command":"bd --actor somebody update bw-2 --claim"}});
        let command = actor(&data).unwrap()["hookSpecificOutput"]["updatedInput"]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(command.matches("--actor").count(), 1, "{command}");
        assert!(command.contains("--add-label copy:bw-2"), "{command}");
    }

    #[test]
    fn native_machinery_does_not_mutate_unrelated_or_quoted_bd() {
        for command in ["echo bd ready", "echo 'bd update bw-1 --claim'", "touch bd"] {
            let data = json!({"tool_name":"Bash", "tool_input":{"command":command}});
            assert!(actor(&data).is_none(), "mutated {command}");
        }
    }

    #[test]
    fn native_machinery_parses_real_merges_only() {
        let merges = |command: &str| {
            calls(command, Path::new("/start"))
                .iter()
                .any(|(segment, here)| {
                    git_call(segment, here)
                        .is_some_and(|call| call.segment.words[call.verb].text == "merge")
                })
        };
        assert!(merges("git merge --ff-only bw-1"));
        assert!(merges("cd /repo && git merge --ff-only bw-1"));
        assert!(merges("true || /usr/bin/git merge --ff-only bw-1"));
        assert!(!merges("git merge-base ours bw-1"));
        assert!(!merges("echo git merge --ff-only bw-1"));
        assert!(!merges("echo 'git merge --ff-only bw-1'"));
        assert!(!merges("touch git-merge"));
    }

    #[test]
    fn native_machinery_claim_bootstrap_is_narrow() {
        let open = json!({"status":"open"});
        let mine = json!({"status":"in_progress", "assignee":"s-test"});
        let theirs = json!({"status":"in_progress", "assignee":"s-other",
            "lease_expires_at":"2999-01-01T00:00:00Z"});
        let expired = json!({"status":"in_progress", "assignee":"s-old",
            "lease_expires_at":"2000-01-01T00:00:00Z"});
        assert!(claimable(&open, "s-test"));
        assert!(claimable(&mine, "s-test"));
        assert!(!claimable(&theirs, "s-test"));
        assert!(claimable(&expired, "s-test"));
        assert!(ownership_refusal(&theirs, "bw-1", "s-test")
            .unwrap()
            .contains("s-other"));

        let claim = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command":"cd worktrees/bw-1 && bd update bw-1 --claim"}});
        assert_eq!(claim_transition(&claim).unwrap().0, "bw-1");
        let directed = json!({"tool_name":"Bash", "cwd":"/repo",
            "tool_input":{"command":"bd -C worktrees/bw-1 update bw-1 --claim"}});
        assert_eq!(
            claim_transition(&directed).unwrap().1,
            PathBuf::from("/repo/worktrees/bw-1")
        );
        let ready = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"bd ready --claim"}});
        assert!(claim_transition(&ready).is_none());
        let mixed = json!({"tool_name":"Bash", "cwd":"/repo/worktrees/bw-1",
            "tool_input":{"command":"rm file && bd update bw-1 --claim"}});
        assert!(claim_transition(&mixed).is_none());
    }

    /// A repository change with no owned card is refused; a write with no
    /// repository at all is not the rule's business (`docs/hook-friction.md` §1).
    #[test]
    fn native_machinery_only_repository_changes_need_an_owned_card() {
        let repo = tempfile::tempdir().unwrap();
        let git = crate::routes::find_git().unwrap();
        assert!(Command::new(git)
            .args(["init", "-q", "-b", "ours"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        let inside = json!({"tool_name":"Edit", "cwd": repo.path(),
            "tool_input":{"file_path": repo.path().join("src/lib.rs")}});
        let refusal = workflow(&inside).expect("a denial");
        assert_eq!(refusal["hookSpecificOutput"]["permissionDecision"], "deny");

        let outside = tempfile::tempdir().unwrap();
        let scratch = json!({"tool_name":"Edit", "cwd": outside.path(),
            "tool_input":{"file_path": outside.path().join("notes.txt")}});
        assert!(workflow(&scratch).is_none(), "a scratch file is not a change");

        for command in [
            "grep -n pattern src/lib.rs 2>/dev/null",
            "echo probe > /dev/tcp/127.0.0.1/3008",
            "cargo build >/dev/null 2>&1",
        ] {
            let data = json!({"tool_name":"Bash", "cwd": repo.path(),
                "tool_input":{"command": command}});
            assert!(workflow(&data).is_none(), "refused: {command}");
        }
    }

    #[test]
    fn native_machinery_lets_a_fast_forward_landing_reach_its_own_gate() {
        let repo = tempfile::tempdir().unwrap();
        assert!(Command::new(crate::routes::find_git().unwrap())
            .args(["init", "-q", "-b", "ours"])
            .current_dir(repo.path())
            .status()
            .unwrap()
            .success());
        // The landing branch's checkout is nobody's card worktree, so the
        // ownership rule would refuse every landing. A fast-forward merge is
        // the merge gate's business, not the workflow gate's.
        let landing = json!({"tool_name":"Bash", "cwd": repo.path(),
            "tool_input":{"command":"git merge --ff-only bw-t26l.20"}});
        assert!(workflow(&landing).is_none());
        // Any other merge is still a change like any other.
        let ordinary = json!({"tool_name":"Bash", "cwd": repo.path(),
            "tool_input":{"command":"git merge bw-t26l.20"}});
        assert_eq!(
            workflow(&ordinary).expect("a denial")["hookSpecificOutput"]["permissionDecision"],
            "deny"
        );
        // And so is a landing performed with the plumbing a merge is made of.
        for plumbing in [
            "git read-tree -m -u HEAD bw-t26l.20",
            "git update-ref refs/heads/ours bw-t26l.20",
            "git push . bw-t26l.20:ours",
        ] {
            let data = json!({"tool_name":"Bash", "cwd": repo.path(),
                "tool_input":{"command": plumbing}});
            assert_eq!(
                workflow(&data).expect("a denial")["hookSpecificOutput"]["permissionDecision"],
                "deny",
                "walked around the gate: {plumbing}"
            );
        }
    }

    #[test]
    fn native_machinery_merge_invariants_are_hard_denials() {
        let clean: &[String] = &[];
        let clash = [String::from("src/lib.rs")];
        assert!(merge_refusal(true, false, "", "s-test", clean)
            .unwrap()
            .contains("fast-forward"));
        assert!(merge_refusal(true, true, "s-other", "s-test", clean)
            .unwrap()
            .contains("s-other"));
        assert!(merge_refusal(true, true, "s-test", "s-test", &clash)
            .unwrap()
            .contains("src/lib.rs"));
        assert!(merge_refusal(true, true, "s-test", "s-test", clean).is_none());
    }

    /// A landing is refused only over the files it would actually write.
    ///
    /// The owner's checkout nearly always holds some unrelated edit. Refusing
    /// every landing on that basis is `docs/hook-friction.md` §4's residue:
    /// finished work waiting on a person for no reason a merge would give.
    #[test]
    fn native_machinery_a_landing_is_refused_only_over_files_it_would_overwrite() {
        let repo = tempfile::tempdir().unwrap();
        let git = crate::routes::find_git().unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new(&git)
                .args(args)
                .current_dir(repo.path())
                .status()
                .unwrap()
                .success());
        };
        run(&["init", "-q", "-b", "ours"]);
        run(&["config", "user.email", "gate@example.com"]);
        run(&["config", "user.name", "gate"]);
        std::fs::write(repo.path().join("landed.txt"), "one\n").unwrap();
        std::fs::write(repo.path().join("untouched.txt"), "one\n").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-qm", "first"]);
        run(&["checkout", "-q", "-b", "bw-1"]);
        std::fs::write(repo.path().join("landed.txt"), "two\n").unwrap();
        run(&["commit", "-qam", "bw-1: second"]);
        run(&["checkout", "-q", "ours"]);

        // An unrelated local edit is not this landing's business.
        std::fs::write(repo.path().join("untouched.txt"), "local\n").unwrap();
        assert!(overwritten_by(repo.path(), "bw-1").is_empty());

        // An edit to a file the landing rewrites is.
        std::fs::write(repo.path().join("landed.txt"), "local\n").unwrap();
        assert_eq!(overwritten_by(repo.path(), "bw-1"), vec!["landed.txt"]);
    }

    #[test]
    fn native_machinery_manager_review_cannot_be_moved() {
        let card = json!({"status":"manager_review"});
        assert!(manager_review_refusal(&card, "bw-1")
            .unwrap()
            .contains("only the manager"));
    }

    #[test]
    fn native_machinery_landed_subjects_name_exact_cards() {
        assert!(subject_names("fix bw-oesd.16.1: database", "bw-oesd.16.1"));
        assert!(!subject_names(
            "fix bw-oesd.16.10: database",
            "bw-oesd.16.1"
        ));
    }

    #[test]
    fn native_machinery_check_evidence_is_fresh_and_passing() {
        assert!(passing_check("checks: tree abc cargo=PASSED", "abc"));
        assert!(!passing_check("checks: tree old cargo=PASSED", "abc"));
        assert!(!passing_check("checks: tree abc cargo=FAILED", "abc"));
    }

    /// Evidence is filed under the tree, so the rebase every card here ends
    /// with does not throw a green run away (bw-zd18).
    #[test]
    fn native_machinery_check_evidence_outlives_a_rewritten_commit() {
        let repo = tempfile::tempdir().unwrap();
        let git = crate::routes::find_git().unwrap();
        let run = |args: &[&str]| {
            assert!(Command::new(&git)
                .args(args)
                .current_dir(repo.path())
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .status()
                .unwrap()
                .success());
        };
        run(&["init", "-q", "-b", "ours"]);
        std::fs::write(repo.path().join("a.txt"), "one").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-qm", "one"]);

        let recorded = checked_tree(repo.path()).expect("the tree a run would record");
        run(&["commit", "-q", "--amend", "-m", "one, said again"]);
        assert_eq!(
            checked_tree(repo.path()).as_deref(),
            Some(recorded.as_str()),
            "a rewritten commit threw away evidence for files that never changed"
        );

        std::fs::write(repo.path().join("a.txt"), "two").unwrap();
        run(&["commit", "-qam", "two"]);
        assert_ne!(
            checked_tree(repo.path()).as_deref(),
            Some(recorded.as_str()),
            "evidence for the old files still counts for new ones"
        );
    }

    /// The two halves read each other, which is the whole of what went wrong:
    /// a green run wrote `Project checks=719/0` and this gate was looking for
    /// the word PASSED, so the run recorded a pass its own close could not
    /// read and every checks card stood open (bw-zd18).
    #[test]
    fn what_a_run_records_is_what_this_gate_accepts() {
        let green = crate::board_tools::proof_of("abc", &["Project checks", "cargo"], &[true, true]);
        assert!(
            passing_check(&green, "abc"),
            "a green run recorded evidence its own close cannot read: {green}"
        );
        let red = crate::board_tools::proof_of("abc", &["Project checks"], &[false]);
        assert!(
            !passing_check(&red, "abc"),
            "a run with a failing suite recorded a pass: {red}"
        );
    }
}
