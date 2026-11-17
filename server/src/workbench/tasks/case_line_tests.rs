//! One case, one check, one command: a case check's output carries exactly
//! one `CASE <grid>/<row>/<col>/<case> PASS|FAIL <measured> <limit>` line
//! with its own id. No line, two lines or another id make the run invalid
//! (not failed); the line's PASS or FAIL decides red and green.

use super::*;

const ID: &str = "camera/glare/gpu/dark-room";

fn case_check() -> Check {
    parse_check(
        &json!({"name": "dark-room", "command": format!("atelier case {ID} -- cargo test dark_room"), "kind": "test",
            "given": "g", "when": "w", "then": "t", "red": format!("CASE {ID} FAIL"), "case": ID}),
        "case",
    )
    .expect("a check may carry its case id")
}

fn run(exit: i32, output: &str) -> Run {
    Run { exit, output: output.into(), output_tail: output.into(), ..Default::default() }
}

fn invalid(result: Result<impl std::fmt::Debug, String>) -> String {
    match result {
        Err(message) if message.starts_with("invalid") => message,
        other => panic!("expected the run to be invalid, got {other:?}"),
    }
}

#[test]
fn a_case_check_with_no_case_line_is_invalid() {
    let check = case_check();
    let message = invalid(judge_red(&check, &run(101, "test dark_room ... FAILED")));
    assert!(message.contains("no CASE line"), "{message}");
    let message = invalid(judge_green(&check, &run(0, "test dark_room ... ok"), None));
    assert!(message.contains("no CASE line"), "{message}");
}

#[test]
fn a_case_check_with_two_case_lines_is_invalid() {
    let check = case_check();
    let output = format!("CASE {ID} PASS - -\nCASE {ID} PASS - -");
    let message = invalid(judge_green(&check, &run(0, &output), None));
    assert!(message.contains("2 CASE lines"), "{message}");
}

#[test]
fn a_case_line_with_another_id_is_invalid() {
    let check = case_check();
    let message = invalid(judge_green(&check, &run(0, "CASE camera/glare/gpu/fog PASS - -"), None));
    assert!(message.contains("camera/glare/gpu/fog") && message.contains(ID), "{message}");
}

#[test]
fn the_case_line_decides_red_and_green() {
    let check = case_check();
    assert_eq!(judge_red(&check, &run(1, &format!("CASE {ID} FAIL 3.2 2.0"))), Ok(None));
    assert_eq!(judge_green(&check, &run(0, &format!("CASE {ID} PASS 1.1 2.0")), None), Ok(()));
    let red = judge_red(&check, &run(0, &format!("CASE {ID} PASS - -"))).unwrap_err();
    assert!(red.contains("already passes"), "{red}");
    let green = judge_green(&check, &run(0, &format!("CASE {ID} FAIL 3.2 2.0")), None).unwrap_err();
    assert!(!green.starts_with("invalid") && green.contains("FAIL"), "a FAIL line fails, it is not invalid: {green}");
}

#[test]
fn a_case_checks_red_must_contain_its_case_id() {
    let error = parse_check(
        &json!({"name": "dark-room", "command": "x", "kind": "test", "given": "g", "when": "w", "then": "t", "red": "FAILED", "case": ID}),
        "case",
    )
    .unwrap_err();
    assert!(error.contains(ID), "{error}");
}
