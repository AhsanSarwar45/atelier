//! Search, the same way over everything that can be searched (bw-21a2.6).
//!
//! The chats, the board and the files each keep their own words in their own
//! place, and each has keys of its own: a chat has `me:` and `agent:`, a card
//! `comment:` and `status:`, a file `ext:`. What they share is everything a
//! person meets: how the box is read ([`words`]), and how an agent is asked to
//! find something described in plain language ([`agent`]) and how what it
//! names is read back and checked ([`named`]). A source supplies its keys, its
//! tools and the skill that says how to use them.

pub mod agent;
pub mod named;
pub mod words;
