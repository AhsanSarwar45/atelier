//! The presenter's half of the shared contract.
//!
//! `src/workbench/__tests__/presentation-corpus.test.ts` answers the same
//! corpus from the reader's side. A payload the presenter accepts and the
//! reader refuses reaches the transcript as a fence that cannot be drawn, and
//! the agent that produced it is given no way to notice — so the two answers
//! are held to one recorded verdict here rather than to each other.

use serde_json::Value;

const CORPUS: &str = include_str!("../../tests/fixtures/presentation-corpus.json");

struct Case {
    name: String,
    accepted: bool,
    why: String,
    payload: Value,
}

fn corpus() -> Vec<Case> {
    let read: Value = serde_json::from_str(CORPUS).expect("the corpus is valid JSON");
    read["widgets"]
        .as_array()
        .expect("the corpus lists widgets")
        .iter()
        .map(|one| {
            let verdict = one["verdict"].as_str().expect("every case has a verdict");
            assert!(
                matches!(verdict, "accept" | "refuse"),
                "verdict is accept or refuse, not {verdict}"
            );
            Case {
                name: one["name"].as_str().expect("every case is named").into(),
                accepted: verdict == "accept",
                why: one["why"].as_str().unwrap_or_default().into(),
                payload: one["payload"].clone(),
            }
        })
        .collect()
}

#[test]
fn the_presenter_answers_every_case_the_way_the_corpus_records_it() {
    let cases = corpus();
    assert!(cases.len() > 50, "the corpus is too small to be a contract");
    assert!(cases.iter().any(|one| one.accepted), "no case is accepted");
    assert!(cases.iter().any(|one| !one.accepted), "no case is refused");

    let mut wrong = Vec::new();
    for one in &cases {
        let accepted = atelier::workbench::media::widget_block(&one.payload).is_ok();
        if accepted != one.accepted {
            wrong.push(format!(
                "  {}: the presenter {} it, the corpus says {} ({})",
                one.name,
                if accepted { "accepts" } else { "refuses" },
                if one.accepted { "accept" } else { "refuse" },
                one.why
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} of {} cases are answered against the corpus:\n{}",
        wrong.len(),
        cases.len(),
        wrong.join("\n")
    );
}

#[test]
fn what_the_presenter_accepts_it_returns_as_a_block_it_can_read_back() {
    for one in corpus().into_iter().filter(|one| one.accepted) {
        let block = atelier::workbench::media::widget_block(&one.payload)
            .unwrap_or_else(|error| panic!("{}: {error}", one.name));
        assert!(
            block.starts_with("```atelier-widget\n") && block.ends_with("```\n"),
            "{}: the block is not the durable fence: {block}",
            one.name
        );
        assert_eq!(
            atelier::workbench::media::widget_specs(&block).len(),
            1,
            "{}: the presenter cannot read back the block it just wrote",
            one.name
        );
    }
}
