//! Cases before work (docs/grids.md, "Cases"): a cell holds a list of cases,
//! one scenario of its row's feature each; Atelier runs a coverage review that
//! looks for missing scenarios; the agent answers every gap with a case or a
//! dismissal; no one approves the result. A cell moves cases → reviewed when
//! its review is finished, and no cell of a row is proved before every cell
//! of the row is reviewed.

use super::*;

/// Reviews a cell gets; once round 3's gaps are answered it is reviewed.
pub const MAX_ROUNDS: usize = 3;
const CASE_FIELDS: &[&str] = &["id", "given", "when", "then", "command", "red", "covers", "files", "timeout_s"];

/// A case's id in `CASE` lines: `GRID/ROW/COL/CASE`.
pub fn full_id(slug: &str, row: &str, col: &str, id: &str) -> String {
    format!("{slug}/{row}/{col}/{id}")
}

fn list(cell: &Cell) -> Vec<Value> {
    cell.cases.as_ref().and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The ids of a cell's cases.
pub fn ids(cell: &Cell) -> Vec<String> {
    list(cell).iter().filter_map(|case| case["id"].as_str().map(str::to_string)).collect()
}

/// A cell's cases as checks: name the case id, with its full case id.
pub fn as_checks(cell: &Cell) -> Vec<Value> {
    list(cell)
        .iter()
        .map(|case| {
            let mut check = json!({
                "name": case["id"], "command": case["command"], "kind": "test",
                "given": case["given"], "when": case["when"], "then": case["then"],
                "red": case["red"], "case": case["case"],
            });
            for key in ["files", "timeout_s"] {
                if let Some(value) = case.get(key).filter(|value| !value.is_null()) {
                    check[key] = value.clone();
                }
            }
            check
        })
        .collect()
}

/// A cell that counts but whose cases are not reviewed: shown as "Needs cases".
pub fn needs_cases(cell: &Cell) -> bool {
    !matches!(cell.state.as_str(), "na" | "na_pending") && cell.cases_approved.is_none()
}

/// The live cells of `row`, not N/A, whose cases are not reviewed yet.
pub fn row_waiting<'a>(loaded: &'a Loaded, row: &str) -> Vec<&'a Cell> {
    live_pairs(loaded).into_iter().filter(|(r, _, cell)| r.id == row && needs_cases(cell)).map(|(_, _, cell)| cell).collect()
}

/// Why no cell of `row` can be proved yet, or None when every cell of it is reviewed.
pub fn unapproved_row(loaded: &Loaded, row: &str) -> Option<String> {
    let waiting = row_waiting(loaded, row);
    if waiting.is_empty() {
        return None;
    }
    let slug = &loaded.grid.slug;
    let cells: Vec<String> = waiting.iter().map(|cell| format!("{row}.{} (step {}, next `{}`)", cell.col, cell.step, cell.next.as_deref().unwrap_or(""))).collect();
    Some(format!(
        "Needs cases. No cell of row {row} can be proved until every cell of it is reviewed. Waiting: {}. Grid {slug}",
        cells.join(", ")
    ))
}

/// The first `{name}` in any text of `value` other than `{row}`; `${…}` is
/// the shell's, not a placeholder.
pub fn other_placeholder(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let pattern = regex::Regex::new(r"(^|[^$])\{([A-Za-z_][A-Za-z0-9_-]*)\}").expect("valid");
            let found = pattern.captures_iter(text).map(|caps| caps[2].to_string()).find(|name| name != "row");
            found.map(|name| format!("{{{name}}}"))
        }
        Value::Array(items) => items.iter().find_map(other_placeholder),
        Value::Object(map) => map.values().find_map(other_placeholder),
        _ => None,
    }
}

/* ------------------------------------------------------------ the review */

/// The gaps of each round, as (id, scenario).
fn rounds(review: Option<&Value>) -> Vec<Vec<(String, String)>> {
    review
        .and_then(|review| review["rounds"].as_array())
        .into_iter()
        .flatten()
        .map(|round| {
            round
                .as_array()
                .into_iter()
                .flatten()
                .map(|gap| (gap["id"].as_str().unwrap_or("").to_string(), gap["scenario"].as_str().unwrap_or("").to_string()))
                .collect()
        })
        .collect()
}

/// The gaps of the last round with no answer yet.
fn unanswered(review: Option<&Value>) -> Vec<String> {
    let answers = review.map(|review| &review["answers"]);
    rounds(review)
        .last()
        .map(|round| {
            round.iter().filter(|(id, _)| answers.is_none_or(|answers| answers.get(id).is_none())).map(|(id, _)| id.clone()).collect()
        })
        .unwrap_or_default()
}

/// Where a cell's cases stand: None (needs cases or answers), `review`
/// (ready for a review) or `reviewed` (a clean review, or the last round's
/// gaps answered).
fn case_step(cases: &[Value], review: Option<&Value>) -> Option<String> {
    if cases.is_empty() {
        return None;
    }
    let rounds = rounds(review);
    match rounds.last() {
        None => Some("review".into()),
        Some(last) if last.is_empty() => Some("reviewed".into()),
        Some(_) if !unanswered(review).is_empty() => None,
        Some(_) if rounds.len() >= MAX_ROUNDS => Some("reviewed".into()),
        Some(_) => Some("review".into()),
    }
}

fn line(slug: &str, cell: &Cell) -> String {
    format!("{slug}.{}.{}: step {}, next `{}`", cell.row, cell.col, cell.step, cell.next.as_deref().unwrap_or(""))
}

/// `atelier grid cases SLUG ROW COL` with `{cases?, dismiss?}`: replace the
/// cell's cases, answer its review's gaps (a case's `covers`, or a dismissal
/// with a reason), or both.
pub fn set(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let (loaded, mut cell) = live_cell(connection, request, "cases")?;
    let slug = loaded.grid.slug.clone();
    let (row, col) = (cell.row.clone(), cell.col.clone());
    let at = format!("{slug}.{row}.{col}");
    let again = format!("Fix it and run `atelier grid cases {slug} {row} {col}` again");
    let fail = |message: String| -> TaskError { TaskError::Refused(format!("{message}. {again}")) };
    if cell.state == "na" {
        return refuse(format!("{at} is N/A; it needs no cases"));
    }
    if let Some(why) = loaded.unordered(&row, &col) {
        return refuse(format!("{at}: {why}"));
    }
    let object = request.payload.as_object().ok_or_else(|| fail("the payload must be an object: {cases?, dismiss?}".into()))?;
    if let Some(unknown) = object.keys().find(|key| !["cases", "dismiss"].contains(&key.as_str())) {
        return Err(fail(format!("{unknown} is not allowed (allowed: cases, dismiss)")));
    }
    if object.get("cases").is_none() && object.get("dismiss").is_none() {
        return Err(fail("give cases, dismiss or both".into()));
    }
    let gaps: Vec<String> = rounds(cell.review.as_ref()).into_iter().flatten().map(|(id, _)| id).collect();
    let column_checks = loaded.plain_check_names(&row, &col);
    let mut answers: Vec<(String, Value)> = Vec::new();

    let new_cases = match object.get("cases") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            let mut checked: Vec<Value> = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let here = format!("cases[{index}]");
                let case = item.as_object().ok_or_else(|| fail(format!("{here} must be an object: {{id, given, when, then, command, red?, covers?}}")))?;
                if let Some(unknown) = case.keys().find(|key| !CASE_FIELDS.contains(&key.as_str())) {
                    return Err(fail(format!("{here}.{unknown} is not a case field (allowed: {})", CASE_FIELDS.join(", "))));
                }
                let id = case.get("id").and_then(Value::as_str).unwrap_or("");
                if !valid_id(id) {
                    return Err(fail(format!("{here}.id \"{id}\" is not a valid case id ({ID_RULE})")));
                }
                if checked.iter().any(|known| known["id"] == id) {
                    return Err(fail(format!("case \"{id}\" is given twice")));
                }
                if column_checks.iter().any(|name| name == id) {
                    return Err(fail(format!("case \"{id}\" has a column check's name; pick another id")));
                }
                let full = full_id(&slug, &row, &col, id);
                let mut check = json!({"name": id, "kind": "test", "case": full});
                for key in ["command", "given", "when", "then", "red", "files", "timeout_s"] {
                    if let Some(value) = case.get(key) {
                        check[key] = value.clone();
                    }
                }
                let parsed = crate::workbench::tasks::checks::parse_check(&check, &format!("{here} (case \"{id}\")")).map_err(fail)?;
                let mut stored = json!({
                    "id": id, "case": full, "given": parsed.given, "when": parsed.when, "then": parsed.then,
                    "command": parsed.command, "red": parsed.red,
                });
                if !parsed.files.is_empty() {
                    stored["files"] = json!(parsed.files);
                }
                if case.contains_key("timeout_s") {
                    stored["timeout_s"] = json!(parsed.timeout_s);
                }
                match case.get("covers") {
                    None | Some(Value::Null) => {}
                    Some(Value::String(gap)) if gaps.contains(gap) => {
                        stored["covers"] = json!(gap);
                        answers.push((gap.clone(), json!({"case": id})));
                    }
                    Some(other) => {
                        return Err(fail(format!(
                            "{here}.covers {other} is not a gap of {at}'s review (gaps: {})",
                            if gaps.is_empty() { "none".to_string() } else { gaps.join(", ") }
                        )))
                    }
                }
                checked.push(stored);
            }
            Some(checked)
        }
        Some(_) => return Err(fail("cases must be a list of {id, given, when, then, command, red?, covers?}".into())),
    };
    match object.get("dismiss") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (gap, reason) in map {
                if !gaps.contains(gap) {
                    return Err(fail(format!(
                        "dismiss.{gap} is not a gap of {at}'s review (gaps: {})",
                        if gaps.is_empty() { "none".to_string() } else { gaps.join(", ") }
                    )));
                }
                let reason = reason.as_str().map(str::trim).unwrap_or("");
                if reason.is_empty() {
                    return Err(fail(format!("dismissing {gap} needs a reason: why the case it asks for is not needed")));
                }
                if reason.chars().count() > 600 {
                    return Err(fail(format!("the reason for dismissing {gap} is over 600 characters")));
                }
                answers.push((gap.clone(), json!({"dismissed": reason})));
            }
        }
        Some(_) => return Err(fail("dismiss must be an object: {GAP: reason}".into())),
    }

    // Edited cases after a finished review start the review over.
    let edited = new_cases.as_ref().is_some_and(|cases| Some(cases) != cell.cases.as_ref().and_then(Value::as_array));
    if edited && (cell.case_step.as_deref() == Some("reviewed") || cell.cases_approved.is_some()) {
        cell.review = None;
        cell.cases_approved = None;
        answers.clear();
    }
    if let Some(cases) = new_cases {
        cell.cases = (!cases.is_empty()).then(|| json!(cases));
    }
    if !answers.is_empty() {
        let review = cell.review.get_or_insert_with(|| json!({"rounds": [], "answers": {}}));
        for (gap, answer) in &answers {
            review["answers"][gap] = answer.clone();
        }
    }
    cell.case_step = case_step(&list(&cell), cell.review.as_ref());
    ready(&mut cell, request.now);
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, request.now, "cases", Some((&row, &col)), request.session.as_deref(), &request.actor,
        &json!({"cases": cell.cases, "answers": answers.iter().map(|(gap, answer)| json!({"gap": gap, "answer": answer})).collect::<Vec<_>>()}))?;
    let cell = get_cell(connection, &request.project, &slug, &row, &col)?.expect("just saved");
    let count = list(&cell).len();
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((row, col)),
        summary: format!("{at} has {count} case{}.\nStep: {}", if count == 1 { "" } else { "s" }, line(&slug, &cell)),
        grids: vec![slug],
        ..Default::default()
    })
}

/// Whether `atelier grid review` may run on this cell now; the route asks
/// before it starts the reviewer. The cell, as loaded.
pub fn review_ready(connection: &Connection, project: &str, slug: &str, row: &str, col: &str) -> Result<(Loaded, Cell), TaskError> {
    let (loaded, cell) = find_live_cell(connection, project, slug, row, col)?;
    let at = format!("{slug}.{row}.{col}");
    if matches!(cell.state.as_str(), "na" | "na_pending") {
        return refuse(format!("{at} is {}; it needs no review", cell.state.replace('_', " ")));
    }
    if let Some(why) = loaded.unordered(row, col) {
        return refuse(format!("{at}: {why}"));
    }
    if list(&cell).is_empty() {
        return refuse(format!("{at} has no cases to review. It is at step cases; next `atelier grid cases {slug} {row} {col}`"));
    }
    if cell.cases_approved.is_some() {
        return refuse(format!("{at}'s cases are reviewed; edit them with `atelier grid cases {slug} {row} {col}` to review them again"));
    }
    let done = rounds(cell.review.as_ref()).len();
    if done >= MAX_ROUNDS {
        return refuse(format!(
            "{at} has had {MAX_ROUNDS} rounds of review. Step {}; next `{}`",
            cell.step,
            cell.next.as_deref().unwrap_or("")
        ));
    }
    let open = unanswered(cell.review.as_ref());
    if !open.is_empty() {
        return refuse(format!(
            "{at}: answer the review's gaps {} first, each with a case that `covers` it or a dismissal with a reason: `atelier grid cases {slug} {row} {col}`. Step cases",
            open.join(", ")
        ));
    }
    if cell.case_step.as_deref() == Some("reviewed") {
        return refuse(format!("{at} is reviewed. Step reviewed; next `{}`", cell.next.as_deref().unwrap_or("")));
    }
    Ok((loaded, cell))
}

/// What the coverage reviewer is asked: the column's purpose, the row's
/// feature and the cell's checks and cases, with the gaps already answered.
/// Nothing from the chat that wrote them.
pub fn review_prompt(loaded: &Loaded, cell: &Cell) -> String {
    let row = loaded.row(&cell.row);
    let col = loaded.column(&cell.col);
    let mut out = String::from(
        "You review the test cases of one cell of a coverage grid. The cell is one feature (the row) against one requirement (the column).\n\
         List the scenarios of this feature that this requirement needs and that no case below tests. Count only real scenarios of this \
         feature for this requirement, each one a case on its own; do not ask for style changes or for what another column covers. Do not \
         repeat a gap already answered below.\n\n",
    );
    if let Some(col) = col {
        out.push_str(&format!("Requirement (column): {}\nWhat counts as proof: {}\n\n", col.name, col.proof_rule));
    }
    if let Some(row) = row {
        out.push_str(&format!("Feature (row): {} ({})\n", row.name, row.id));
        if !row.paths.is_empty() {
            out.push_str(&format!("Its code: {}\n", row.paths.join(", ")));
        }
        out.push('\n');
    }
    let column_checks: Vec<Value> = {
        let cases = ids(cell);
        loaded.cell_checks(&cell.row, &cell.col).into_iter().filter(|check| !cases.iter().any(|id| check["name"] == id.as_str())).collect()
    };
    if !column_checks.is_empty() {
        out.push_str("Checks every row of this column runs:\n");
        for check in &column_checks {
            out.push_str(&format!("- {}: given {}, when {}, then {} (`{}`)\n", check["name"].as_str().unwrap_or(""), text(&check["given"]), text(&check["when"]), text(&check["then"]), text(&check["command"])));
        }
        out.push('\n');
    }
    out.push_str("Cases:\n");
    for case in list(cell) {
        out.push_str(&format!("- {}: given {}, when {}, then {} (`{}`)\n", text(&case["id"]), text(&case["given"]), text(&case["when"]), text(&case["then"]), text(&case["command"])));
    }
    let answers = cell.review.as_ref().map(|review| review["answers"].clone()).unwrap_or(Value::Null);
    let answered: Vec<String> = rounds(cell.review.as_ref())
        .into_iter()
        .flatten()
        .filter_map(|(id, scenario)| {
            let answer = answers.get(&id)?;
            Some(match (answer["case"].as_str(), answer["dismissed"].as_str()) {
                (Some(case), _) => format!("- {scenario}: covered by case {case}"),
                (_, Some(reason)) => format!("- {scenario}: dismissed, {reason}"),
                _ => return None,
            })
        })
        .collect();
    if !answered.is_empty() {
        out.push_str(&format!("\nGaps already answered:\n{}\n", answered.join("\n")));
    }
    out.push_str("\nAnswer with JSON only, no other text: {\"gaps\": [{\"scenario\": \"one missing scenario in a sentence\"}]}. Answer {\"gaps\": []} when the cases cover the requirement for this feature.\n");
    out
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// The reviewer's answer: the scenarios it found missing.
pub fn parse_reply(reply: &str) -> Result<Vec<String>, String> {
    let trimmed = reply.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
    let start = trimmed.find('{').ok_or_else(|| format!("the reviewer did not answer with JSON: {}", short(trimmed)))?;
    let end = trimmed.rfind('}').ok_or_else(|| format!("the reviewer did not answer with JSON: {}", short(trimmed)))?;
    let value: Value = serde_json::from_str(&trimmed[start..=end]).map_err(|error| format!("the reviewer's JSON is not readable ({error}): {}", short(trimmed)))?;
    let gaps = value["gaps"].as_array().ok_or_else(|| format!("the reviewer's answer has no gaps list: {}", short(trimmed)))?;
    Ok(gaps
        .iter()
        .filter_map(|gap| gap["scenario"].as_str().or_else(|| gap.as_str()))
        .map(|scenario| scenario.trim().chars().take(600).collect::<String>())
        .filter(|scenario| !scenario.is_empty())
        .take(20)
        .collect())
}

fn short(text: &str) -> String {
    text.chars().take(300).collect()
}

/// The coverage review's answer, recorded: actor `reviewer` (the route,
/// after it ran the reviewer), payload `{gaps: [{scenario}]}`.
pub fn record_review(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "review")?;
    let row = need(&request.row, "row", "review")?;
    let col = need(&request.col, "col", "review")?;
    if request.actor != "reviewer" {
        return refuse(format!(
            "Atelier runs the coverage review: run `atelier grid review {slug} {row} {col}` and it records what a fresh reviewer finds"
        ));
    }
    let (_, mut cell) = review_ready(connection, &request.project, slug, row, col)?;
    let scenarios: Vec<String> = request.payload["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|gap| gap["scenario"].as_str().map(str::to_string))
        .collect();
    let review = cell.review.get_or_insert_with(|| json!({"rounds": [], "answers": {}}));
    let round = review["rounds"].as_array().map_or(0, Vec::len) + 1;
    let gaps: Vec<Value> = scenarios.iter().enumerate().map(|(index, scenario)| json!({"id": format!("r{round}g{}", index + 1), "scenario": scenario})).collect();
    if let Some(rounds) = review["rounds"].as_array_mut() {
        rounds.push(json!(gaps));
    }
    cell.case_step = case_step(&list(&cell), cell.review.as_ref());
    ready(&mut cell, request.now);
    save_cell(connection, &request.project, slug, &cell)?;
    append_event(connection, &request.project, slug, request.now, "reviewed", Some((row, col)), request.session.as_deref(), "reviewer",
        &json!({"round": round, "gaps": gaps}))?;
    let cell = get_cell(connection, &request.project, slug, row, col)?.expect("just saved");
    let found = if gaps.is_empty() {
        format!("Review round {round} of {slug}.{row}.{col} found no gaps.")
    } else {
        let lines: Vec<String> = gaps.iter().map(|gap| format!("  {}: {}", text(&gap["id"]), text(&gap["scenario"]))).collect();
        format!(
            "Review round {round} of {slug}.{row}.{col} found {} gap{}:\n{}\nAnswer each with `atelier grid cases {slug} {row} {col}`: a case with \"covers\": \"GAP\", or \"dismiss\": {{\"GAP\": \"reason\"}}.",
            gaps.len(),
            if gaps.len() == 1 { "" } else { "s" },
            lines.join("\n")
        )
    };
    Ok(Outcome {
        slug: Some(slug.to_string()),
        cell: Some((row.to_string(), col.to_string())),
        summary: format!("{found}\nStep: {}", line(slug, &cell)),
        grids: vec![slug.to_string()],
        ..Default::default()
    })
}

/// A cell whose review is finished (clean, or round 3's gaps answered) is
/// ready to be proved; no one approves it.
fn ready(cell: &mut Cell, now: i64) {
    if cell.case_step.as_deref() == Some("reviewed") && cell.cases_approved.is_none() {
        cell.cases_approved = Some(now);
    }
}
