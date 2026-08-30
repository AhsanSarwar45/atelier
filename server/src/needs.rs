//! What Atelier needs from the computer it is on, and whether it is there.
//!
//! Every one of these is a program somebody else installs. The app looks for
//! each of them in the reader's own list of places and then in the ordinary
//! install and system folders, so a copy the machine starts at login — which
//! inherits no shell and so no list at all — still finds them.
//!
//! It exists as one list rather than as four lookups scattered through the
//! server because "what must I install?" had only ever been answered by
//! reading our code. Nothing could be asked. This is the thing that answers
//! it, for a person at a terminal now and for the screens later (bw-dwxw).

use crate::routes::find_tool;
use std::path::PathBuf;

/// One outside program the app starts, and what it is started for.
pub struct Need {
    /// What we call it, and the first spelling looked for.
    pub name: &'static str,
    /// The other spellings the same program wears, tried in turn after it.
    pub also: &'static [&'static str],
    /// What stops working when it is not here, in the reader's own terms.
    pub carries: &'static str,
    /// Where a reader gets it.
    pub from: &'static str,
}

/// Every outside program the app starts, in the order a reader meets them.
///
/// `git` is first because without it a project cannot be read at all.
pub const NEEDED: &[Need] = &[
    Need {
        name: "git",
        also: &[],
        carries: "reading and writing your project, and cutting each ticket its own copy",
        from: "https://git-scm.com/downloads",
    },
    Need {
        name: "python3",
        also: &["python"],
        carries: "setting a project up, and checking every move on the board",
        from: "https://www.python.org/downloads/",
    },
    Need {
        name: "bd",
        also: &[],
        carries: "the board, for projects that opt into one",
        from: "https://github.com/gastownhall/beads",
    },
];

/// One need, and where this computer holds it.
pub struct Found {
    pub need: &'static Need,
    pub at: Option<PathBuf>,
}

/// Every need, looked for now.
///
/// The answers are the same remembered ones the rest of the server uses, so
/// what this reports is what the server will actually start.
pub fn looked() -> Vec<Found> {
    NEEDED
        .iter()
        .map(|need| Found {
            need,
            at: find_tool(need.name, need.also),
        })
        .collect()
}

/// The report as a person reads it, one line for each program.
///
/// The name and the word come first and are one space-separated field each, so
/// a script checking a fresh machine can read the answer with `awk` and does
/// not need us to grow a second, machine-shaped output nobody looks at.
pub fn printed() -> String {
    written(&looked())
}

/// The report over rows handed in, so the shape a script reads can be put to a
/// test.
///
/// `scripts/fresh-machine.sh` decides whether a container is missing a tool by
/// taking the second field of each line. Nothing else in a build would notice
/// that word moving, and the script would then find nothing missing anywhere
/// and pass on every machine — which is the failure the whole check exists to
/// stop (bw-dwxw).
fn written(rows: &[Found]) -> String {
    let widest = NEEDED.iter().map(|need| need.name.len()).max().unwrap_or(0);
    let mut out = String::new();
    for Found { need, at } in rows {
        let (word, detail) = match at {
            Some(path) => ("found  ", path.display().to_string()),
            None => ("missing", format!("get it from {}", need.from)),
        };
        out.push_str(&format!("{:widest$}  {word}  {detail}\n", need.name));
        out.push_str(&format!("{:widest$}           {}\n", "", need.carries));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The word a script reads is the second field, and it is one of two.
    ///
    /// `scripts/fresh-machine.sh` takes `$2` of every line. If that word ever
    /// moved, or a missing tool stopped saying `missing`, the script would
    /// report nothing missing on a container holding nothing at all and pass
    /// (bw-dwxw).
    #[test]
    fn a_script_can_read_which_ones_are_missing() {
        let rows = vec![
            Found { need: &NEEDED[0], at: Some(PathBuf::from("/usr/bin/git")) },
            Found { need: &NEEDED[1], at: None },
        ];
        let said = written(&rows);
        let words: Vec<Vec<&str>> = said
            .lines()
            .map(|line| line.split_whitespace().collect())
            .filter(|fields: &Vec<&str>| {
                matches!(fields.get(1), Some(&"found") | Some(&"missing"))
            })
            .collect();

        assert_eq!(words.len(), 2, "one readable line for each program, in:\n{said}");
        assert_eq!(words[0][0], "git");
        assert_eq!(words[0][1], "found");
        assert_eq!(words[1][0], "python3");
        assert_eq!(words[1][1], "missing");
    }

    /// Every program is named once, and each says where to get it.
    #[test]
    fn every_program_the_app_starts_says_what_it_is_for() {
        for need in NEEDED {
            assert!(!need.carries.is_empty(), "{} says nothing about itself", need.name);
            assert!(need.from.starts_with("https://"), "{} names nowhere to get it", need.name);
        }
        let mut names: Vec<&str> = NEEDED.iter().map(|need| need.name).collect();
        names.sort_unstable();
        let counted = names.len();
        names.dedup();
        assert_eq!(names.len(), counted, "a program is listed twice");
    }
}
