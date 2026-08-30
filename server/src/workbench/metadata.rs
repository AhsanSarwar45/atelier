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

/// A short subject while a provider works out its own conversation name.
pub fn conversation_title(prompt: &str) -> Option<String> {
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
    }
}
