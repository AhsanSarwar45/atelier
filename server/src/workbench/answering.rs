//! Auto-approve: the app answering a chat's permission questions itself.
//!
//! Some accounts are not allowed to run their provider in a mode that stops
//! asking — the setting is refused, or the organisation removed it — and the
//! owner is left pressing the same button on every tool call. With
//! auto-approve on, the provider keeps asking exactly as its mode says, and the
//! app presses the allow option for him.
//!
//! It is a setting of its own, beside the permission mode rather than one of
//! them, so it can be on while the chat is in plan mode or any other mode
//! (bw-q8ehk.1). Nothing here writes to the provider's own settings, and the
//! answer is always the once-only option where one is offered, so turning it
//! off leaves no rule behind that keeps approving after he stopped asking for
//! it.

use serde_json::Value;

/// What auto-approve used to be: a permission mode of its own. Read only to
/// carry chats and starred defaults that were in it over to the setting.
pub const ATELIER_AUTO: &str = "atelierAuto";

/// What a card answered this way is marked with, so the transcript can say the
/// app pressed the button rather than the owner.
pub const ANSWERED_BY_APP: &str = "atelier";

/// The option to press on a permission card, from the options the agent gave.
///
/// The once-only option is preferred wherever the agent offers one. The other
/// approving option — "allow always" — is a request to write a standing rule
/// into the provider's own settings, which is both the thing the owner's
/// organisation may be auditing and a rule that outlives the mode. Ids are the
/// agent's own vocabulary and are never matched on; only the protocol `kind`
/// is read (the same rule as the plan path, bw-t26l.20).
///
/// `None` means no approving option was offered — a refuse-only card, or an
/// agent asking something this is not an answer to. The card is then shown and
/// waits, because the app has nothing it can honestly press.
pub fn allow_option(options: &[Value]) -> Option<String> {
    let id = |option: &Value| option["id"].as_str().map(str::to_string);
    options
        .iter()
        .find(|option| option["kind"] == "allow_once")
        .and_then(id)
        .or_else(|| {
            options
                .iter()
                .find(|option| {
                    option["kind"]
                        .as_str()
                        .is_some_and(|kind| kind.starts_with("allow"))
                })
                .and_then(id)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_once_only_option_is_preferred_over_the_standing_rule() {
        let options = json!([
            {"id":"allow-always","kind":"allow_always"},
            {"id":"allow-once","kind":"allow_once"},
            {"id":"reject","kind":"reject_once"}
        ]);
        assert_eq!(allow_option(options.as_array().unwrap()).as_deref(), Some("allow-once"));
    }

    #[test]
    fn an_agent_offering_only_a_standing_rule_is_still_answered() {
        let options = json!([{"id":"yes","kind":"allow_always"},{"id":"no","kind":"reject_once"}]);
        assert_eq!(allow_option(options.as_array().unwrap()).as_deref(), Some("yes"));
    }

    #[test]
    fn a_card_with_nothing_to_approve_is_left_for_the_owner() {
        let options = json!([{"id":"no","kind":"reject_once"},{"id":"never","kind":"reject_always"}]);
        assert_eq!(allow_option(options.as_array().unwrap()), None);
        assert_eq!(allow_option(&[]), None);
    }

    #[test]
    fn the_option_is_chosen_by_its_kind_and_never_by_its_name() {
        // Claude's approving option is called "allow-once" and its refusing
        // one "reject"; an agent that named its refusal "allowance-denied"
        // would be approved by any rule that read the letters in the id.
        let options = json!([
            {"id":"allowance-denied","kind":"reject_once"},
            {"id":"proceed","kind":"allow_once"}
        ]);
        assert_eq!(allow_option(options.as_array().unwrap()).as_deref(), Some("proceed"));
    }
}
