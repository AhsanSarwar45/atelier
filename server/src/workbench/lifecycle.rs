//! Provider-neutral cleanup when a live conversation transport disappears.

use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
struct AgentRow {
    started: bool,
    finished: bool,
    pending_finish: Option<Value>,
    seconds: i64,
    tokens: i64,
    calls: i64,
}

/// The one canonical child-work state machine used after every provider has
/// translated its native union and before any event reaches storage or wire.
#[derive(Default)]
pub struct AgentLifecycle {
    rows: HashMap<String, AgentRow>,
}

impl AgentLifecycle {
    pub fn accept(&mut self, events: Vec<Value>) -> Vec<Value> {
        let mut accepted = Vec::new();
        for mut event in events {
            let kind = event["type"].as_str().unwrap_or_default();
            if !matches!(kind, "agent.started" | "agent.progress" | "agent.finished") {
                accepted.push(event);
                continue;
            }
            let Some(id) = event["agentId"].as_str().map(str::to_string) else {
                continue;
            };
            let row = self.rows.entry(id).or_default();
            match kind {
                "agent.started" if !row.started && !row.finished => {
                    row.started = true;
                    accepted.push(event);
                    if let Some(mut finish) = row.pending_finish.take() {
                        apply_totals(row, &mut finish);
                        row.finished = true;
                        accepted.push(finish);
                    }
                }
                "agent.progress"
                    if row.started && (!row.finished || event["finalUsage"] == true) =>
                {
                    let changed = apply_totals(row, &mut event);
                    if !row.finished || changed {
                        accepted.push(event)
                    }
                }
                "agent.finished" if !row.finished => {
                    if row.started {
                        apply_totals(row, &mut event);
                        row.finished = true;
                        accepted.push(event);
                    } else if row.pending_finish.is_none() {
                        row.pending_finish = Some(event);
                    }
                }
                _ => {}
            }
        }
        accepted
    }
}

fn apply_totals(row: &mut AgentRow, event: &mut Value) -> bool {
    let before = (row.seconds, row.tokens, row.calls);
    for (field, held) in [
        ("seconds", &mut row.seconds),
        ("tokens", &mut row.tokens),
        ("calls", &mut row.calls),
    ] {
        if let Some(value) = event[field].as_i64().filter(|value| *value >= 0) {
            *held = (*held).max(value);
        }
        event[field] = json!(*held);
    }
    before != (row.seconds, row.tokens, row.calls)
}

/// Resolve interaction cards whose provider request died with the transport.
/// Provider adapters own native request handles; the shared lifecycle owns the
/// WBP meaning shown and persisted by every provider.
pub fn abandoned_interactions(
    asks: impl IntoIterator<Item = String>,
    questions: impl IntoIterator<Item = String>,
    plans: impl IntoIterator<Item = String>,
) -> Vec<Value> {
    let mut events = Vec::new();
    events.extend(
        asks.into_iter().map(
            |ask_id| json!({"type":"ask.resolved","askId":ask_id,"chosen":"provider_stopped"}),
        ),
    );
    events.extend(questions.into_iter().map(
        |request_id| json!({"type":"question.resolved","requestId":request_id,"answers":null}),
    ));
    events.extend(plans.into_iter().map(|proposal_id| {
        json!({"type":"plan.resolved","proposalId":proposal_id,"status":"dismissed","actionId":"provider_stopped","feedback":null})
    }));
    events
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_cleanup_resolves_every_kind_of_blocking_card() {
        let events = abandoned_interactions(["a".into()], ["q".into()], ["p".into()]);
        assert_eq!(
            events
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["ask.resolved", "question.resolved", "plan.resolved"]
        );
    }

    #[test]
    fn agent_lifecycle_orders_once_keeps_tombstones_and_never_runs_backwards() {
        let mut lifecycle = AgentLifecycle::default();
        assert!(lifecycle.accept(vec![json!({"type":"agent.finished","agentId":"a","state":"done","seconds":12,"tokens":100,"calls":3,"model":null,"result":"ok"})]).is_empty());
        let ordered=lifecycle.accept(vec![json!({"type":"agent.started","agentId":"a","toolCallId":"t","kind":"helper","what":"Inspect","agentType":null,"model":null})]);
        assert_eq!(
            ordered
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["agent.started", "agent.finished"]
        );
        assert!(lifecycle
            .accept(vec![
                json!({"type":"agent.started","agentId":"a"}),
                json!({"type":"agent.progress","agentId":"a","seconds":1,"tokens":1,"calls":1})
            ])
            .is_empty());

        let mut active = AgentLifecycle::default();
        active.accept(vec![json!({"type":"agent.started","agentId":"b"})]);
        active.accept(vec![
            json!({"type":"agent.progress","agentId":"b","seconds":20,"tokens":800,"calls":5}),
        ]);
        let later = active.accept(vec![
            json!({"type":"agent.progress","agentId":"b","seconds":12,"tokens":400,"calls":3}),
        ]);
        assert_eq!(later[0]["seconds"], 20);
        assert_eq!(later[0]["tokens"], 800);
        assert_eq!(later[0]["calls"], 5);
    }
}
