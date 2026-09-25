//! Provider-neutral names and compact session metadata.

use std::collections::HashSet;

const SMALL: &[&str] = &[
    "a", "all", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "for", "from",
    "has", "have", "i", "in", "is", "it", "its", "just", "like", "does", "my", "not", "of", "on",
    "or", "our", "please", "that", "the", "their", "these", "they", "this", "to", "we", "with",
    "you", "your",
];

fn strip_opening(mut text: String) -> String {
    let openings = [
        "hi ",
        "hello ",
        "hey ",
        "so ",
        "okay ",
        "ok ",
        "well ",
        "can you ",
        "could you ",
        "would you ",
        "please ",
        "i want to ",
        "i want you to ",
        "i need to ",
        "i need you to ",
        "i would like to ",
        "i would like you to ",
        "look at ",
        "currently ",
        "we have ",
        "we currently have ",
    ];
    loop {
        let lower = text.to_lowercase();
        let found = openings.iter().find(|opening| lower.starts_with(**opening));
        let Some(opening) = found else { break };
        text = text[opening.len()..]
            .trim_start_matches([',', '!', '.', ' '])
            .to_string();
    }
    text
}

/// The blocks Atelier puts in front of what a person typed, by their tag: the
/// guidance a resumed conversation is given, and the words of the chat an
/// account switch carried over. They reach the provider as part of the user's
/// message, so its record holds them there too.
pub const GUIDANCE: &str = "atelier_connection_guidance";
pub const HANDOFF: &str = "account_handoff";
/// The instructions of an Atelier command, sent after the line that ran it.
pub const COMMAND: &str = "atelier_command";
/// What the cards, chats and skills a message names are, sent after it
/// (`references.rs`, bw-mi3s.2).
pub const REFERENCES: &str = "atelier_references";

/// One block Atelier adds to a message, in the form `persons_words` removes.
///
/// What goes inside can be anyone's text -- a skill, a person's arguments, an
/// earlier chat's words -- so a tag of these blocks inside it is written
/// `&lt;` and cannot end the block early (bw-zldt.1).
pub fn added_by_atelier(tag: &str, body: &str) -> String {
    let mut body = body.to_string();
    for inner in [GUIDANCE, HANDOFF, COMMAND, REFERENCES] {
        for written in [format!("<{inner}>"), format!("</{inner}>")] {
            body = body.replace(&written, &format!("&lt;{}", &written[1..]));
        }
    }
    format!("<{tag}>\n{body}\n</{tag}>")
}

/// A message as the person wrote it: every block Atelier added taken out.
pub fn persons_words(message: &str) -> String {
    let mut rest = message.to_string();
    // A command's instructions are added after what the person typed, and
    // their own tags inside it are escaped, so the last opening is Atelier's;
    // one the person typed in front of it is theirs (bw-zldt.1).
    for tag in [REFERENCES, COMMAND] {
        let (opening, closing) = (format!("<{tag}>"), format!("</{tag}>"));
        if let Some(start) = rest.rfind(&opening) {
            if let Some(at) = rest[start..].find(&closing) {
                rest.replace_range(start..start + at + closing.len(), "");
            }
        }
    }
    for tag in [GUIDANCE, HANDOFF] {
        let (opening, closing) = (format!("<{tag}>"), format!("</{tag}>"));
        while let Some(start) = rest.find(&opening) {
            let end = rest[start..]
                .find(&closing)
                .map_or(rest.len(), |at| start + at + closing.len());
            rest.replace_range(start..end, "");
        }
    }
    rest.trim().to_string()
}

/// A short subject while a provider works out its own conversation name.
///
/// Named from the person's words alone: a title made from the guidance
/// Atelier put in front of them names every chat the same (bw-8yln.1).
pub fn conversation_title(prompt: &str) -> Option<String> {
    // `/skill:standup` is named `/standup`: the prefix says where the command
    // lives, not what the chat is about.
    let prompt = persons_words(prompt);
    let prompt = match prompt.strip_prefix("/skill:") {
        Some(rest) => format!("/{rest}"),
        None => prompt,
    };
    let mut plain = String::new();
    let mut tag = false;
    for ch in prompt.chars() {
        match ch {
            '<' => {
                tag = true;
                plain.push(' ');
            }
            '>' if tag => {
                tag = false;
                plain.push(' ');
            }
            _ if tag => {}
            '`' | '*' | '_' | '#' | '>' | '[' | ']' | '(' | ')' | '{' | '}' => plain.push(' '),
            _ => plain.push(ch),
        }
    }
    let plain = strip_opening(plain.split_whitespace().collect::<Vec<_>>().join(" "));
    let mut words = Vec::new();
    let mut word = String::new();
    for ch in plain
        .trim_end_matches(['.', '!', '?', ',', ';', ':'])
        .chars()
    {
        if ch.is_alphanumeric() || "'’+./-".contains(ch) {
            word.push(ch);
        } else if !word.is_empty() {
            let found = std::mem::take(&mut word)
                .trim_end_matches(['.', '!', '?', ',', ';', ':'])
                .to_string();
            if !found.is_empty() {
                words.push(found);
            }
        }
    }
    if !word.is_empty() {
        let found = word.trim_end_matches(['.', '!', '?', ',', ';', ':']);
        if !found.is_empty() {
            words.push(found.to_string());
        }
    }
    let small: HashSet<_> = SMALL.iter().copied().collect();
    let meaningful: Vec<_> = words
        .iter()
        .filter(|word| !small.contains(word.to_lowercase().as_str()))
        .collect();
    let chosen: Vec<_> = if meaningful.len() >= 3 {
        meaningful
    } else {
        words.iter().collect()
    };
    let title = chosen
        .into_iter()
        .take(6)
        .map(|word| {
            let chars: Vec<_> = word.chars().collect();
            let camel = chars
                .windows(2)
                .any(|pair| pair[0].is_lowercase() && pair[1].is_uppercase());
            let several_caps = chars.iter().filter(|ch| ch.is_uppercase()).count() > 1;
            if camel || several_caps {
                return word.clone();
            }
            let mut chars = word.chars();
            chars
                .next()
                .map(|first| {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_workbench_services_metadata_titles_name_the_subject() {
        assert_eq!(conversation_title("look at all these chats. they are just being names with the first message not an agent defined message like in normal chat apps").as_deref(), Some("Chats Names First Message Agent Defined"));
        assert_eq!(
            conversation_title("Could you please fix the WebSocket reconnect loop in APIClient.")
                .as_deref(),
            Some("Fix WebSocket Reconnect Loop APIClient")
        );
        assert_eq!(
            conversation_title("Investigate why the export button is not working in Safari")
                .as_deref(),
            Some("Investigate Why Export Button Working Safari")
        );
        assert_eq!(conversation_title(" <context></context> "), None);
        assert_eq!(
            conversation_title("/skill:standup\n\n<atelier_command>\nUse the following shared skill\n</atelier_command>").as_deref(),
            Some("/standup")
        );
    }

    #[test]
    fn a_chat_is_named_from_what_the_person_typed_not_what_atelier_added() {
        let guidance = added_by_atelier(
            GUIDANCE,
            "The user-configured shared guidance for this connection follows. It replaces earlier shared-library instructions.",
        );
        let handoff = added_by_atelier(HANDOFF, "The account changed during this chat.");
        let sent = format!("{handoff}\n{guidance}\nReply with the single word: ping");
        assert_eq!(persons_words(&sent), "Reply with the single word: ping");
        assert_eq!(conversation_title(&sent), conversation_title("Reply with the single word: ping"));
        // A message that is nothing but what Atelier added has no name in it.
        assert_eq!(conversation_title(&guidance), None);
        // One cut off before its end still says nothing of the person's.
        assert_eq!(persons_words("<account_handoff>\nhalf a hand"), "");
    }
}
