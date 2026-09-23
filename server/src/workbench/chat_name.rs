//! What a chat is called, when its project has said how (bw-mv45).
//!
//! A project can arrange a chat's name out of parts: the chat's own title,
//! words of its own, and text a pattern finds in something the chat knows
//! about itself — most usefully the ticket key in the name of the worktree the
//! chat is working in. The template lives in the project's manifest
//! (`[chat_name]`), and every list that names a chat asks here, so the rail,
//! the tray, a push and a search all call one chat the same thing.
//!
//! A name the owner typed by hand is theirs and is shown as typed. A project
//! with no template keeps the app's own rule (`notice::naming`).

use crate::project_manifest::{ChatNamePart, ChatNameSettings, ChatNameSource};
use regex::{Regex, RegexBuilder};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The most parts a template may have. Far past anything a name needs, and
/// short enough that the editor's row of chips fits the screen.
pub const MOST_PARTS: usize = 12;
/// The longest pattern or text a part may hold.
pub const LONGEST: usize = 200;

/// What a chat knows about itself that a name can be built from.
#[derive(Clone, Copy, Debug, Default)]
pub struct Chat<'a> {
    pub title: Option<&'a str>,
    pub named_by_owner: bool,
    /// The directory the chat works in, when the answer has it.
    pub cwd: Option<&'a str>,
    pub project_path: &'a str,
    /// The folder the old rule falls back to, as the caller already knows it.
    pub folder: Option<&'a str>,
    pub brand: &'a str,
}

impl<'a> Chat<'a> {
    pub fn of(session: &'a crate::workbench::store::Session, folder: Option<&'a str>) -> Self {
        Chat {
            title: session.title.as_deref(),
            named_by_owner: session.named_by_owner,
            cwd: Some(&session.cwd),
            project_path: &session.project_path,
            folder,
            brand: &session.brand,
        }
    }
}

enum Piece {
    Title,
    Text(String),
    Extract { source: ChatNameSource, pattern: Regex },
    /// A part whose pattern would not compile: it finds nothing, and so takes
    /// the text beside it with it.
    Broken,
}

/// A template whose patterns have compiled.
pub struct Template {
    pieces: Vec<Piece>,
}

/// Why one part of a template cannot be used, by its position.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PartError {
    pub index: usize,
    pub message: String,
}

fn pattern(text: &str) -> Result<Regex, String> {
    if text.trim().is_empty() {
        return Err("Enter a pattern".into());
    }
    if text.chars().count() > LONGEST {
        return Err(format!("A pattern cannot be longer than {LONGEST} characters"));
    }
    RegexBuilder::new(text)
        .size_limit(1 << 20)
        .build()
        .map_err(|error| match error {
            regex::Error::Syntax(detail) => detail
                .lines()
                .rev()
                .find(|line| line.starts_with("error:"))
                .map(|line| line.trim_start_matches("error:").trim().to_string())
                .map(|why| format!("Not a valid pattern: {why}"))
                .unwrap_or_else(|| "Not a valid pattern".into()),
            _ => "This pattern is too large".into(),
        })
}

/// Every reason the template cannot be saved, part by part. Empty when it can.
pub fn problems(settings: &ChatNameSettings) -> Vec<PartError> {
    let mut found = Vec::new();
    for (index, part) in settings.parts.iter().enumerate() {
        let problem = match part {
            ChatNamePart::Title => None,
            ChatNamePart::Text { text } if text.is_empty() => Some("Enter some text".into()),
            ChatNamePart::Text { text } if text.chars().count() > LONGEST => {
                Some(format!("Text cannot be longer than {LONGEST} characters"))
            }
            ChatNamePart::Text { .. } => None,
            ChatNamePart::Extract { pattern: text, .. } => pattern(text).err(),
        };
        if let Some(message) = problem {
            found.push(PartError { index, message });
        }
    }
    found
}

/// Whether a template can be saved, in one sentence when it cannot.
pub fn check(settings: &ChatNameSettings) -> Result<(), String> {
    if settings.parts.is_empty() {
        return Ok(());
    }
    if settings.parts.len() > MOST_PARTS {
        return Err(format!("A chat name can have at most {MOST_PARTS} parts"));
    }
    if settings.parts.iter().all(|part| matches!(part, ChatNamePart::Text { .. })) {
        return Err("A chat name needs the chat title or extracted text".into());
    }
    match problems(settings).into_iter().next() {
        Some(problem) => Err(format!("Chat name part {}: {}", problem.index + 1, problem.message)),
        None => Ok(()),
    }
}

/// The template as it can be used. A part that cannot be used — a pattern
/// broken by hand in the file — finds nothing, rather than losing every name.
pub fn compile(settings: &ChatNameSettings) -> Option<Template> {
    let pieces: Vec<Piece> = settings
        .parts
        .iter()
        .map(|part| match part {
            ChatNamePart::Title => Piece::Title,
            ChatNamePart::Text { text } => Piece::Text(text.clone()),
            ChatNamePart::Extract { source, pattern: text } => pattern(text)
                .map(|pattern| Piece::Extract { source: *source, pattern })
                .unwrap_or(Piece::Broken),
        })
        .collect();
    pieces
        .iter()
        .any(|piece| matches!(piece, Piece::Title | Piece::Extract { .. }))
        .then_some(Template { pieces })
}

/// The checkout a directory is in: the nearest folder holding `.git`.
fn checkout_root(cwd: &str) -> Option<PathBuf> {
    Path::new(cwd)
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

/// The branch checked out at a checkout, read from git's own files.
///
/// A worktree's `.git` is a file naming its private directory; a main
/// checkout's is that directory. Either way `HEAD` there names the branch.
fn branch_at(root: &Path) -> Option<String> {
    let dot_git = root.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let pointer = std::fs::read_to_string(&dot_git).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        let target = Path::new(target);
        if target.is_absolute() { target.to_path_buf() } else { root.join(target) }
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    head.trim()
        .strip_prefix("ref: refs/heads/")
        .map(str::to_string)
}

/// What each source says for one chat, read only when a part asks for it.
#[derive(Default)]
pub struct Facts {
    pub worktree: Option<String>,
    pub branch: Option<String>,
    pub path: Option<String>,
}

impl Facts {
    pub fn read(template: &Template, cwd: Option<&str>) -> Self {
        let wants = |wanted: ChatNameSource| {
            template.pieces.iter().any(
                |piece| matches!(piece, Piece::Extract { source, .. } if *source == wanted),
            )
        };
        let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) else {
            return Facts::default();
        };
        let root = (wants(ChatNameSource::Worktree) || wants(ChatNameSource::Branch))
            .then(|| checkout_root(cwd))
            .flatten();
        Facts {
            worktree: wants(ChatNameSource::Worktree).then(|| {
                root.as_deref()
                    .and_then(|root| root.file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
                    .or_else(|| crate::workbench::notice::folder_of(cwd))
            }).flatten(),
            branch: wants(ChatNameSource::Branch)
                .then(|| root.as_deref().and_then(branch_at))
                .flatten(),
            path: wants(ChatNameSource::Path).then(|| cwd.to_string()),
        }
    }

    fn of(&self, source: ChatNameSource) -> Option<&str> {
        match source {
            ChatNameSource::Worktree => self.worktree.as_deref(),
            ChatNameSource::Branch => self.branch.as_deref(),
            ChatNameSource::Path => self.path.as_deref(),
        }
    }
}

fn found(pattern: &Regex, haystack: &str) -> Option<String> {
    let captures = pattern.captures(haystack)?;
    let chosen = captures.get(1).or_else(|| captures.get(0))?;
    Some(chosen.as_str().trim().to_string()).filter(|text| !text.is_empty())
}

/// The name a template builds for one chat, or `None` when every part came
/// out empty.
///
/// Text between parts is kept only when the parts on both sides of it have
/// something to say, so a chat with no ticket key reads "Fix the tray" rather
/// than ": Fix the tray".
pub fn render(template: &Template, title: Option<&str>, facts: &Facts) -> Option<String> {
    let values: Vec<Option<String>> = template
        .pieces
        .iter()
        .map(|piece| match piece {
            Piece::Title => title
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_string),
            Piece::Text(_) | Piece::Broken => None,
            Piece::Extract { source, pattern } => facts.of(*source).and_then(|it| found(pattern, it)),
        })
        .collect();
    let spoken = |index: usize| values[index].is_some();
    let is_text = |index: usize| matches!(template.pieces[index], Piece::Text(_));
    let mut name = String::new();
    for (index, piece) in template.pieces.iter().enumerate() {
        match piece {
            Piece::Text(text) => {
                let before = (0..index).rev().find(|&at| !is_text(at));
                let after = (index + 1..template.pieces.len()).find(|&at| !is_text(at));
                if before.is_none_or(spoken) && after.is_none_or(spoken) {
                    name.push_str(text);
                }
            }
            _ => {
                if let Some(value) = &values[index] {
                    name.push_str(value);
                }
            }
        }
    }
    let name = name.trim().to_string();
    (!name.is_empty()).then_some(name)
}

/// How long a project's template is trusted before its manifest is read
/// again. Saving the settings forgets it at once; this only bounds how long a
/// hand edit to the file takes to show.
const FRESH_FOR: Duration = Duration::from_secs(5);

type Cached = (Instant, Option<Arc<Template>>);

fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Read every project's template afresh on the next name. Called when a
/// project's settings are saved.
pub fn forget() {
    if let Ok(mut held) = cache().lock() {
        held.clear();
    }
}

fn settings_of(project_path: &str) -> Option<ChatNameSettings> {
    let data = crate::identity::data_dir()?;
    let located = if project_path.starts_with("dolt://") {
        crate::project_manifest::locate_key(project_path, &data)
    } else {
        crate::project_manifest::locate(Path::new(project_path), &data)
    }?;
    Some(located.manifest.chat_name)
}

/// The template of the project at this path, if it has one.
pub fn template_for(project_path: &str) -> Option<Arc<Template>> {
    if project_path.is_empty() {
        return None;
    }
    if let Ok(held) = cache().lock() {
        if let Some((at, template)) = held.get(project_path) {
            if at.elapsed() < FRESH_FOR {
                return template.clone();
            }
        }
    }
    let template = settings_of(project_path)
        .and_then(|settings| compile(&settings))
        .map(Arc::new);
    if let Ok(mut held) = cache().lock() {
        held.insert(project_path.to_string(), (Instant::now(), template.clone()));
    }
    template
}

/// What to call this chat: the owner's own name, else the project's
/// template, else the app's own rule.
pub fn name_of(chat: &Chat<'_>) -> String {
    if chat.named_by_owner {
        return name_by(None, chat);
    }
    name_by(template_for(chat.project_path).as_deref(), chat)
}

/// What a given template would call this chat. The preview asks this with a
/// template that has not been saved yet.
pub fn name_by(template: Option<&Template>, chat: &Chat<'_>) -> String {
    let fallback = || crate::workbench::notice::naming(chat.title, chat.folder, chat.brand);
    match template {
        Some(template) if !chat.named_by_owner => {
            render(template, chat.title, &Facts::read(template, chat.cwd)).unwrap_or_else(fallback)
        }
        _ => fallback(),
    }
}

/// The same, for a chat whose saved record is in hand.
pub fn name_session(session: &crate::workbench::store::Session) -> String {
    let folder = crate::workbench::notice::folder_of(&session.cwd);
    name_of(&Chat::of(session, folder.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn extract(source: ChatNameSource, pattern: &str) -> ChatNamePart {
        ChatNamePart::Extract { source, pattern: pattern.into() }
    }

    fn text(text: &str) -> ChatNamePart {
        ChatNamePart::Text { text: text.into() }
    }

    fn template(parts: Vec<ChatNamePart>) -> Template {
        compile(&ChatNameSettings { parts }).expect("a usable template")
    }

    fn worktree(name: &str) -> Facts {
        Facts { worktree: Some(name.into()), ..Default::default() }
    }

    fn key_then_title() -> Template {
        template(vec![
            extract(ChatNameSource::Worktree, r"bw-[a-z0-9]+"),
            text(": "),
            ChatNamePart::Title,
        ])
    }

    #[test]
    fn the_ticket_key_leads_the_title() {
        assert_eq!(
            render(&key_then_title(), Some("Fix the tray"), &worktree("bw-a9ln")).as_deref(),
            Some("bw-a9ln: Fix the tray")
        );
    }

    #[test]
    fn a_key_that_is_not_there_takes_its_separator_with_it() {
        assert_eq!(
            render(&key_then_title(), Some("Fix the tray"), &worktree("beads-web")).as_deref(),
            Some("Fix the tray")
        );
    }

    #[test]
    fn a_chat_with_no_title_yet_is_named_by_its_key_alone() {
        assert_eq!(
            render(&key_then_title(), None, &worktree("bw-a9ln")).as_deref(),
            Some("bw-a9ln")
        );
    }

    #[test]
    fn nothing_found_anywhere_is_no_name_at_all() {
        assert_eq!(render(&key_then_title(), Some("  "), &worktree("main")), None);
    }

    #[test]
    fn a_trailing_key_in_brackets_drops_both_brackets_when_missing() {
        let bracketed = template(vec![
            ChatNamePart::Title,
            text(" ("),
            extract(ChatNameSource::Worktree, r"bw-\w+"),
            text(")"),
        ]);
        assert_eq!(
            render(&bracketed, Some("Fix"), &worktree("bw-1")).as_deref(),
            Some("Fix (bw-1)")
        );
        assert_eq!(render(&bracketed, Some("Fix"), &worktree("x")).as_deref(), Some("Fix"));
    }

    #[test]
    fn a_capture_group_picks_out_just_what_it_holds() {
        let numbered = template(vec![
            text("#"),
            extract(ChatNameSource::Branch, r"feature/(\d+)"),
        ]);
        let facts = Facts { branch: Some("feature/1231-login".into()), ..Default::default() };
        assert_eq!(render(&numbered, None, &facts).as_deref(), Some("#1231"));
    }

    #[test]
    fn a_broken_pattern_is_named_before_it_is_saved() {
        let broken = ChatNameSettings { parts: vec![extract(ChatNameSource::Worktree, "bw-(")] };
        let found = problems(&broken);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].index, 0);
        assert!(found[0].message.starts_with("Not a valid pattern"), "{}", found[0].message);
        assert!(check(&broken).is_err());
    }

    #[test]
    fn a_template_of_only_words_cannot_be_saved() {
        let words = ChatNameSettings { parts: vec![text("chat")] };
        assert!(check(&words).is_err());
        assert!(compile(&words).is_none());
    }

    #[test]
    fn a_pattern_broken_by_hand_leaves_the_rest_of_the_template_working() {
        let settings = ChatNameSettings {
            parts: vec![extract(ChatNameSource::Worktree, "("), text(": "), ChatNamePart::Title],
        };
        let usable = compile(&settings).expect("the title still names the chat");
        assert_eq!(render(&usable, Some("Fix"), &worktree("bw-1")).as_deref(), Some("Fix"));
    }

    #[test]
    fn the_worktree_and_branch_are_read_from_git_s_own_files() {
        let home = std::env::temp_dir().join(format!("chat-name-{}", uuid::Uuid::new_v4()));
        let main = home.join("repo");
        let private = main.join(".git/worktrees/bw-a9ln");
        std::fs::create_dir_all(&private).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(private.join("HEAD"), "ref: refs/heads/bw-a9ln\n").unwrap();
        let tree = main.join("worktrees/bw-a9ln");
        std::fs::create_dir_all(tree.join("src")).unwrap();
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", private.display())).unwrap();

        let both = template(vec![
            extract(ChatNameSource::Worktree, r".+"),
            text(" @ "),
            extract(ChatNameSource::Branch, r".+"),
        ]);
        let inside = tree.join("src");
        let facts = Facts::read(&both, inside.to_str());
        assert_eq!(render(&both, None, &facts).as_deref(), Some("bw-a9ln @ bw-a9ln"));
        let facts = Facts::read(&both, main.to_str());
        assert_eq!(render(&both, None, &facts).as_deref(), Some("repo @ main"));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn a_name_the_owner_typed_is_left_alone() {
        let chat = Chat {
            title: Some("My own name"),
            named_by_owner: true,
            project_path: "/nowhere/at/all",
            brand: "claude",
            ..Default::default()
        };
        assert_eq!(name_of(&chat), "My own name");
    }
}
