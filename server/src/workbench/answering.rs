//! The permission mode the app answers in, and what answering means.
//!
//! Every other permission mode is a word the provider understands: the app
//! passes it along and the provider decides what to ask about. This one is the
//! app's own. Some accounts are not allowed to run their provider in a mode
//! that stops asking — the setting is refused, or the organisation removed it —
//! and the owner is left pressing the same button on every tool call. In this
//! mode the provider keeps asking exactly as it would when asking first, and
//! the app presses the allow option for him.
//!
//! Nothing here writes to the provider's own settings, and the answer is
//! always the once-only option where one is offered, so turning the mode off
//! leaves no rule behind that keeps approving after he stopped asking for it.

use serde_json::Value;

/// The mode's wire id. Drawn as "Atelier automatic" (`machine-words.ts`).
pub const ATELIER_AUTO: &str = "atelierAuto";

/// What a card answered this way is marked with, so the transcript can say the
/// app pressed the button rather than the owner.
pub const ANSWERED_BY_APP: &str = "atelier";

/// The mode the provider itself is put in while the app is answering.
///
/// It has to be a mode that still asks. Handing the provider a mode that
/// approves by itself would defeat the point twice over: those are the modes
/// the account cannot use, and a provider that never asks gives the app
/// nothing to answer and no record of what it approved.
pub fn asking_mode(brand: &str) -> &'static str {
    if brand == "claude" {
        "default"
    } else {
        "on-request"
    }
}

/// The mode to hand the provider for a mode the owner picked.
///
/// Every mode but this one is the provider's own word and passes through
/// untouched.
pub fn provider_mode(brand: &str, mode: &str) -> String {
    if mode == ATELIER_AUTO {
        asking_mode(brand).to_string()
    } else {
        mode.to_string()
    }
}

/// Keep the owner's mode when it is the app's own.
///
/// After a mode is pushed, the provider is asked what mode it is now in and
/// the answer is written down as the chat's mode. The provider answers with
/// its own word — it was never told the app's — so reading its answer back
/// without this would replace "Atelier automatic" with "Ask first" the moment
/// the chat started, and the chat would go back to waiting on every tool call
/// without anyone having changed the setting.
pub fn read_back(owner_picked: &str, brand: &str, provider_says: &str) -> String {
    if owner_picked == ATELIER_AUTO && provider_says == asking_mode(brand) {
        return ATELIER_AUTO.to_string();
    }
    provider_says.to_string()
}

/// Put the app's own mode in a menu of the provider's modes.
///
/// It belongs to the app, not to the provider, so no provider lists it and it
/// has to be added to every menu that can honestly carry it. It goes last: the
/// modes above it are the ones the provider itself enforces, and this one is
/// the fallback for an account that cannot reach them.
///
/// `provider_still_asks` is whether this agent can actually be left asking.
/// Offering the mode to an agent that cannot is a promise on the picker that
/// nothing behind it keeps: an agent that lists modes but not the asking one
/// would be left in whatever it is already in, and the app would claim to be
/// answering questions that are never put. An agent that lists no modes at all
/// is a different case and does qualify — it keeps whatever mode it starts in,
/// nothing is sent to it, and any question it does ask is answered.
pub fn offer_in_menu(modes: &mut Vec<String>, provider_still_asks: bool) {
    if provider_still_asks && !modes.iter().any(|mode| mode == ATELIER_AUTO) {
        modes.push(ATELIER_AUTO.to_string());
    }
}

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
    fn the_provider_is_left_asking() {
        assert_eq!(provider_mode("claude", ATELIER_AUTO), "default");
        assert_eq!(provider_mode("codex", ATELIER_AUTO), "on-request");
        assert_eq!(provider_mode("local", ATELIER_AUTO), "on-request");
    }

    #[test]
    fn every_other_mode_is_the_providers_own_word() {
        assert_eq!(provider_mode("claude", "bypassPermissions"), "bypassPermissions");
        assert_eq!(provider_mode("codex", "never"), "never");
    }

    #[test]
    fn the_mode_survives_the_provider_being_asked_what_mode_it_is_in() {
        assert_eq!(read_back(ATELIER_AUTO, "claude", "default"), ATELIER_AUTO);
        assert_eq!(read_back(ATELIER_AUTO, "codex", "on-request"), ATELIER_AUTO);
    }

    #[test]
    fn a_mode_the_owner_did_not_pick_is_read_back_as_it_came() {
        assert_eq!(read_back(ATELIER_AUTO, "claude", "plan"), "plan");
        assert_eq!(read_back("default", "claude", "default"), "default");
    }

    #[test]
    fn the_menu_offers_it_once_however_often_it_is_built() {
        let mut modes = vec!["default".to_string(), "plan".to_string()];
        offer_in_menu(&mut modes, true);
        offer_in_menu(&mut modes, true);
        assert_eq!(modes, ["default", "plan", ATELIER_AUTO]);
    }

    /// An agent that cannot be left asking is not offered the mode.
    ///
    /// Picking it there used to send the agent a mode it never listed, which
    /// ACP answers with a fatal `Invalid params`: the pick came back as a
    /// steer error, the chat stayed in the mode it was already in, and the app
    /// never started answering anything (bw-0z25.1).
    #[test]
    fn an_agent_that_cannot_be_left_asking_is_not_offered_it() {
        let mut modes = vec!["yolo".to_string()];
        offer_in_menu(&mut modes, false);
        assert_eq!(modes, ["yolo"]);
    }

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
