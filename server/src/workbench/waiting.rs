//! What is waiting on the owner besides a chat's own permission question.
//!
//! A task in review, a task proposal, a plan change, a grid draft and an N/A
//! request each stop an agent until the owner answers, and each used to be
//! visible only on its own card, scrolled somewhere in a transcript or behind
//! the Tasks tab. This is the one list of them, read from the task and grid
//! tables as they stand, so the composer bar, the rail, the tray, the Tasks tab
//! and the push to a phone all name the same items in the same words.
//!
//! Each item has a key that names one occurrence of it, not the thing it is
//! about: a task sent back and handed in again is a new review, and a grid
//! drafted again is a new draft. What the owner has read and what a device
//! has been told are written against that key (`waiting_notice`), so a second
//! occurrence is news again while the first is said once.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;

/// `CREATE`d from `store.rs`, beside the tables it is about.
pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS waiting_notice (
  key TEXT PRIMARY KEY,
  read_at TEXT,
  announced_at TEXT
);
"#;

pub fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SCHEMA)
}

/// One thing waiting on the owner.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    /// One occurrence: `review:PROJECT:N:SEQ`, `proposal:PROJECT:ID`,
    /// `amend:PROJECT:N:SEQ`, `grid_draft:PROJECT:SLUG:AT`, `na:PROJECT:SLUG:ROW:COL:SEQ`.
    pub key: String,
    /// `review`, `proposal`, `amend`, `grid_draft` or `na`.
    pub kind: String,
    pub project_id: String,
    /// The chat the answer goes back to, when one does.
    pub session_id: Option<String>,
    pub task: Option<i64>,
    pub proposal: Option<i64>,
    pub grid: Option<String>,
    pub row: Option<String>,
    pub col: Option<String>,
    /// The task, proposal or grid's title, or the cell's names.
    pub title: String,
    /// The line the composer bar and the Tasks tab draw.
    pub says: String,
    /// The shorter line the tray and a phone draw beside the chat's name.
    pub short: String,
    /// When it started waiting, in milliseconds.
    pub since: i64,
}

fn latest_event(connection: &Connection, project: &str, number: i64, kinds: &[&str]) -> rusqlite::Result<Option<(i64, i64)>> {
    let marks = kinds.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&project, &number];
    for kind in kinds {
        values.push(kind);
    }
    connection
        .query_row(
            &format!(
                "SELECT seq, at FROM task_event WHERE project_id = ? AND number = ? AND kind IN ({marks})
                  ORDER BY seq DESC LIMIT 1"
            ),
            values.as_slice(),
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
}

/// Everything waiting on the owner, in one project or all of them, oldest
/// first so a list reads in the order things were asked.
pub fn list(connection: &Connection, project: Option<&str>) -> rusqlite::Result<Vec<Waiting>> {
    let mut found = Vec::new();

    let mut statement = connection.prepare(
        "SELECT project_id, number, title, status, session_id, pending_amend IS NOT NULL, updated_at FROM task
          WHERE (?1 IS NULL OR project_id = ?1) AND (status = 'review' OR pending_amend IS NOT NULL)",
    )?;
    let tasks: Vec<(String, i64, String, String, Option<String>, bool, i64)> = statement
        .query_map([project], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (project_id, number, title, status, session_id, amend, updated) in tasks {
        if status == "review" {
            let (seq, at) = latest_event(connection, &project_id, number, &["submitted"])?.unwrap_or((0, updated));
            found.push(Waiting {
                key: format!("review:{project_id}:{number}:{seq}"),
                kind: "review".into(),
                says: format!("#{number} is ready for review"),
                short: format!("#{number} ready for review"),
                since: at,
                ..item(&project_id, &session_id, Some(number), &title)
            });
        }
        if amend {
            let (seq, at) = latest_event(connection, &project_id, number, &["amend_proposed"])?.unwrap_or((0, updated));
            found.push(Waiting {
                key: format!("amend:{project_id}:{number}:{seq}"),
                kind: "amend".into(),
                says: format!("Plan change for #{number}"),
                short: format!("Plan change for #{number}"),
                since: at,
                ..item(&project_id, &session_id, Some(number), &title)
            });
        }
    }

    let mut statement = connection.prepare(
        "SELECT project_id, id, session_id, title, created_at FROM task_proposal
          WHERE (?1 IS NULL OR project_id = ?1) AND status = 'pending'",
    )?;
    let proposals: Vec<(String, i64, String, String, i64)> = statement
        .query_map([project], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (project_id, id, session_id, title, at) in proposals {
        found.push(Waiting {
            key: format!("proposal:{project_id}:{id}"),
            kind: "proposal".into(),
            proposal: Some(id),
            says: format!("Proposal: {title}"),
            short: "Proposal waiting".into(),
            since: at,
            ..item(&project_id, &Some(session_id), None, &title)
        });
    }

    // A draft is a new grid's first draft or an approved grid's edit; either
    // way its `pending` holds what the owner is asked to approve.
    let mut statement = connection.prepare(
        "SELECT project_id, slug, title, pending, updated_at FROM grid
          WHERE (?1 IS NULL OR project_id = ?1) AND pending IS NOT NULL AND status <> 'discarded'",
    )?;
    let drafts: Vec<(String, String, String, Option<String>, i64)> = statement
        .query_map([project], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (project_id, slug, title, pending, updated) in drafts {
        let pending: serde_json::Value = pending.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
        let title = pending["title"].as_str().map(str::to_string).unwrap_or(title);
        let at = pending["draftedAt"].as_i64().unwrap_or(updated);
        found.push(Waiting {
            key: format!("grid_draft:{project_id}:{slug}:{at}"),
            kind: "grid_draft".into(),
            grid: Some(slug),
            says: format!("Grid draft: {title}"),
            short: "Grid draft waiting".into(),
            since: at,
            ..item(&project_id, &pending["draftedBy"].as_str().map(str::to_string), None, &title)
        });
    }

    // The chat that asked is the one the answer goes to; a request with no
    // asker on record goes to the chat whose task claims the cell.
    let mut statement = connection.prepare(
        "SELECT c.project_id, c.slug, c.row, c.col,
                COALESCE(r.name, c.row), COALESCE(k.name, c.col),
                e.seq, e.at, COALESCE(e.session_id, t.session_id)
           FROM grid_cell c
           LEFT JOIN grid_row r ON r.project_id = c.project_id AND r.slug = c.slug AND r.id = c.row
           LEFT JOIN grid_column k ON k.project_id = c.project_id AND k.slug = c.slug AND k.id = c.col
           LEFT JOIN grid_event e ON e.project_id = c.project_id AND e.slug = c.slug AND e.seq =
                (SELECT MAX(seq) FROM grid_event x WHERE x.project_id = c.project_id AND x.slug = c.slug
                    AND x.row = c.row AND x.col = c.col AND x.kind = 'na_asked')
           LEFT JOIN task t ON t.project_id = c.project_id AND t.number = c.claimed_task
          WHERE (?1 IS NULL OR c.project_id = ?1) AND c.state = 'na_pending'",
    )?;
    type Asked = (String, String, String, String, String, String, Option<i64>, Option<i64>, Option<String>);
    let asked: Vec<Asked> = statement
        .query_map([project], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    for (project_id, slug, row, col, row_name, col_name, seq, at, session_id) in asked {
        let title = format!("{row_name} × {col_name}");
        found.push(Waiting {
            key: format!("na:{project_id}:{slug}:{row}:{col}:{}", seq.unwrap_or(0)),
            kind: "na".into(),
            grid: Some(slug),
            row: Some(row),
            col: Some(col),
            says: format!("N/A request: {title}"),
            short: "N/A request waiting".into(),
            since: at.unwrap_or(0),
            ..item(&project_id, &session_id, None, &title)
        });
    }

    found.sort_by(|a, b| a.since.cmp(&b.since).then_with(|| a.key.cmp(&b.key)));
    Ok(found)
}

/// The fields every kind shares; each kind fills in the rest.
fn item(project_id: &str, session_id: &Option<String>, task: Option<i64>, title: &str) -> Waiting {
    Waiting {
        key: String::new(),
        kind: String::new(),
        project_id: project_id.to_string(),
        session_id: session_id.clone(),
        task,
        proposal: None,
        grid: None,
        row: None,
        col: None,
        title: title.to_string(),
        says: String::new(),
        short: String::new(),
        since: 0,
    }
}

/// What has been read and announced, by key.
#[derive(Clone, Debug, Default)]
pub struct Noticed {
    pub read: bool,
    pub announced: bool,
}

pub fn noticed(connection: &Connection) -> rusqlite::Result<HashMap<String, Noticed>> {
    let mut statement = connection.prepare("SELECT key, read_at IS NOT NULL, announced_at IS NOT NULL FROM waiting_notice")?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, Noticed { read: row.get(1)?, announced: row.get(2)? })))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The owner has read these items in the tray.
pub fn mark_read(connection: &Connection, keys: &[String], at: &str) -> rusqlite::Result<()> {
    for key in keys {
        connection.execute(
            "INSERT INTO waiting_notice (key, read_at) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET read_at = excluded.read_at",
            params![key, at],
        )?;
    }
    Ok(())
}

/// A device has been told about this item, or it was already waiting when
/// the watcher started and is not news.
pub fn mark_announced(connection: &Connection, key: &str, at: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO waiting_notice (key, announced_at) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET announced_at = excluded.announced_at",
        params![key, at],
    )?;
    Ok(())
}
