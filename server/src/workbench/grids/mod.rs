//! Coverage grids: the features of one area of a project (rows), the
//! requirements each must meet (columns), and a cell for every pair that says
//! whether it is met and links to the proof (docs/grids.md).
//!
//! Everything that changes a grid goes through [`apply`], on the database
//! writer, inside one transaction, with one `grid_event` row per change. The
//! route gathers what needs the outside world first — the row search's
//! output, the checks' results, fingerprints of the covered code — and hands
//! it in, as the tasks route does with commits.
//!
//! Staleness is never stored: a proved cell is stale when its row's covered
//! code, fingerprinted now in the project's folder, differs from the
//! fingerprint stored with the proof. Callers pass those fingerprints in as
//! [`Prints`].

pub mod cases;
pub mod cli;
pub mod proof;
pub mod search;
pub mod watch;

use super::tasks::TaskError;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS grid (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  area TEXT NOT NULL,
  status TEXT NOT NULL,
  template TEXT,
  row_search TEXT NOT NULL,
  pending TEXT,
  created_by TEXT,
  drafted_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approved_at INTEGER,
  discovery TEXT,
  PRIMARY KEY (project_id, slug)
);
CREATE TABLE IF NOT EXISTS grid_column (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  proof_rule TEXT NOT NULL,
  position INTEGER NOT NULL,
  from_template INTEGER NOT NULL DEFAULT 0,
  retired_at INTEGER,
  PRIMARY KEY (project_id, slug, id)
);
CREATE TABLE IF NOT EXISTS grid_row (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  paths TEXT NOT NULL DEFAULT '[]',
  of TEXT NOT NULL DEFAULT '[]',
  ref TEXT,
  source TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  missing_since INTEGER,
  removed_at INTEGER,
  PRIMARY KEY (project_id, slug, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS grid_row_owner ON grid_row(project_id, id)
  WHERE kind <> 'reference' AND removed_at IS NULL;
CREATE TABLE IF NOT EXISTS grid_cell (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  row TEXT NOT NULL,
  col TEXT NOT NULL,
  state TEXT NOT NULL,
  proof TEXT,
  fingerprint TEXT,
  proved_by TEXT,
  proved_at INTEGER,
  last_check TEXT,
  claimed_task INTEGER,
  claimed_from TEXT,
  reason TEXT,
  audited_at INTEGER,
  audited_by TEXT,
  PRIMARY KEY (project_id, slug, row, col)
);
CREATE INDEX IF NOT EXISTS grid_cell_by_claim ON grid_cell(project_id, claimed_task)
  WHERE claimed_task IS NOT NULL;
CREATE TABLE IF NOT EXISTS grid_event (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  row TEXT,
  col TEXT,
  session_id TEXT,
  actor TEXT NOT NULL,
  payload TEXT,
  PRIMARY KEY (project_id, slug, seq)
);
CREATE INDEX IF NOT EXISTS grid_event_by_cell ON grid_event(project_id, slug, row, col);
CREATE TABLE IF NOT EXISTS grid_template (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  columns TEXT NOT NULL DEFAULT '[]',
  pending TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS grid_task_cell (
  project_id TEXT NOT NULL,
  task INTEGER NOT NULL,
  slug TEXT NOT NULL,
  row TEXT NOT NULL,
  col TEXT NOT NULL,
  PRIMARY KEY (project_id, task, slug, row, col)
);
"#;

/// Create the grid tables, and the column a proposal keeps its cells in.
/// Run from `store.rs` right after `tasks::SCHEMA`.
pub fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(SCHEMA)?;
    let has_cells = connection
        .prepare("SELECT 1 FROM pragma_table_info('task_proposal') WHERE name = 'cells'")?
        .exists([])?;
    if !has_cells {
        connection.execute_batch("ALTER TABLE task_proposal ADD COLUMN cells TEXT;")?;
    }
    // Check templates on columns and a cell's own checks (docs/grids.md,
    // "Checks"); the files they lock, hashed in the chat's folder when written.
    // What a row or column comes after (docs/grids.md, "Order").
    // A cell's step, the command that moves it on, and the cells it waits
    // for (docs/grids.md, "Steps").
    for (table, column) in [("grid_column", "checks"), ("grid_cell", "checks"), ("grid", "hashes"), ("grid_column", "after"), ("grid_row", "after"),
        ("grid_cell", "step"), ("grid_cell", "next"), ("grid_cell", "after"),
        // A cell's cases, its coverage review and where its cases stand
        // (docs/grids.md, "Cases").
        ("grid_cell", "cases"), ("grid_cell", "review"), ("grid_cell", "case_step"),
        // Why a row, column or cell comes where the order puts it
        // (docs/grids.md, "Order").
        ("grid_row", "order_reason"), ("grid_column", "order_reason"), ("grid_cell", "after_reason")] {
        let has = connection
            .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}'"))?
            .exists([])?;
        if !has {
            connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT;"))?;
        }
    }
    // Where a row or column stands in the written order; NULL until an
    // agent orders it, since a grid has no default order. Whether a proved
    // cell's checks changed since its proof (docs/grids.md, "Checks").
    for (table, column) in [("grid_cell", "cases_approved"), ("grid_row", "order_seq"), ("grid_column", "order_seq"), ("grid_cell", "checks_changed")] {
        let has = connection
            .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}'"))?
            .exists([])?;
        if !has {
            connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} INTEGER;"))?;
        }
    }
    // A finished review readies a cell with no one's approval.
    connection.execute("UPDATE grid_cell SET cases_approved = 1 WHERE case_step = 'reviewed' AND cases_approved IS NULL", [])?;
    bring_over(connection)?;
    refresh_steps(connection, "step IS NULL OR step IN ('open', 'cases', 'reviewed', 'approved', 'red', 'work')", params![])?;
    Ok(())
}

/// A database from before grids needed no approval and cells no task: a
/// draft, edit or template change that waited for the owner is applied, a
/// cell a task claimed is back to the state it had before, every claim is
/// gone, and an N/A that waited for the owner is N/A.
fn bring_over(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "UPDATE grid_cell SET state = COALESCE(NULLIF(claimed_from, 'in_progress'), 'gap') WHERE state = 'in_progress';
         UPDATE grid_cell SET claimed_task = NULL, claimed_from = NULL WHERE claimed_task IS NOT NULL OR claimed_from IS NOT NULL;
         UPDATE grid_cell SET state = 'na' WHERE state = 'na_pending';",
    )?;
    let waiting: Vec<(String, String)> = connection
        .prepare("SELECT project_id, slug FROM grid WHERE pending IS NOT NULL AND status <> 'discarded'")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (project, slug) in waiting {
        let Some(mut grid) = get_grid(connection, &project, &slug)? else { continue };
        let Some(pending) = grid.pending.take() else { continue };
        let now = grid.updated_at;
        let applied = if pending["checksOnly"] == true {
            let changed = strings(&pending["changed"]);
            let checks: Vec<(String, Vec<Value>)> = pending["columns"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|column| changed.iter().any(|id| column["id"] == id.as_str()))
                .map(|column| (column["id"].as_str().unwrap_or("").to_string(), column["checks"].as_array().cloned().unwrap_or_default()))
                .collect();
            set_column_checks(connection, &project, &mut grid, &checks, pending.get("hashes"), now).map(|_| ())
        } else {
            apply_pending(connection, &project, grid, &pending, None, now).map(|_| ())
        };
        if let Err(error) = applied {
            tracing::warn!(project = %project, grid = %slug, "a grid change from before could not be applied: {error:?}");
            connection.execute("UPDATE grid SET pending = NULL WHERE project_id = ?1 AND slug = ?2", params![project, slug])?;
        }
    }
    let templates: Vec<(String, String, String)> = connection
        .prepare("SELECT project_id, name, pending FROM grid_template WHERE pending IS NOT NULL")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (project, name, pending) in templates {
        let pending: Value = serde_json::from_str(&pending).unwrap_or(Value::Null);
        let columns = pending["columns"].as_array().cloned().unwrap_or_default();
        let (by, at) = (pending["by"].as_str().map(str::to_string), pending["at"].as_i64().unwrap_or(0));
        if let Err(error) = set_template(connection, &project, &name, &columns, by.as_deref(), at) {
            tracing::warn!(project = %project, template = %name, "a template change from before could not be applied: {error:?}");
        }
        connection.execute("UPDATE grid_template SET pending = NULL WHERE project_id = ?1 AND name = ?2", params![project, name])?;
    }
    Ok(())
}

/// Sets `step` and `next` of the cells `filter` picks from their state, the
/// grid's order and their cases: order (its row or column has no place in
/// the written order), cases (needs cases, or answers to its review's gaps,
/// or a review), reviewed (its review is finished: ready to prove), proved,
/// or na. No task moves a cell.
fn refresh_steps(connection: &Connection, filter: &str, values: impl rusqlite::Params) -> rusqlite::Result<()> {
    const STEP: &str = "CASE
        WHEN state = 'na' THEN 'na'
        WHEN state = 'proved' THEN 'proved'
        WHEN (SELECT r.order_seq FROM grid_row r WHERE r.project_id = grid_cell.project_id AND r.slug = grid_cell.slug AND r.id = grid_cell.row) IS NULL
          OR (SELECT c.order_seq FROM grid_column c WHERE c.project_id = grid_cell.project_id AND c.slug = grid_cell.slug AND c.id = grid_cell.col) IS NULL
          THEN 'order'
        WHEN cases_approved IS NOT NULL OR case_step = 'reviewed' THEN 'reviewed'
        ELSE 'cases' END";
    // One statement, so the filter sees each cell as it was.
    connection.execute(
        &format!(
            "UPDATE grid_cell SET step = {STEP}, next = CASE {STEP}
               WHEN 'reviewed' THEN 'atelier grid prove ' || slug || ' ' || row || ' ' || col
               WHEN 'order' THEN 'atelier grid order ' || slug
               WHEN 'cases' THEN CASE WHEN case_step = 'review'
                 THEN 'atelier grid review ' || slug || ' ' || row || ' ' || col
                 ELSE 'atelier grid cases ' || slug || ' ' || row || ' ' || col END
               ELSE 'atelier grid next ' || slug END
             WHERE {filter}"
        ),
        values,
    )?;
    Ok(())
}

/// Marks every cell of grid `slug` as reviewed with its row's cases
/// approved, for tests of the steps after cases. Rows and columns with no
/// order get their drawn place, so those tests need not write one.
#[cfg(test)]
pub fn approve_all_cases(connection: &Connection, project: &str, slug: &str) {
    connection
        .execute("UPDATE grid_cell SET case_step = 'reviewed', cases_approved = 1 WHERE project_id = ?1 AND slug = ?2", params![project, slug])
        .unwrap();
    test_order(connection, project, slug);
}

/// Gives every unordered row and column of grid `slug` its drawn place, for
/// tests of the steps after the order.
#[cfg(test)]
pub fn test_order(connection: &Connection, project: &str, slug: &str) {
    connection
        .execute_batch(&format!(
            "UPDATE grid_row SET order_seq = rowid, order_reason = 'set by the test' WHERE project_id = '{project}' AND slug = '{slug}' AND order_seq IS NULL;
             UPDATE grid_column SET order_seq = position, order_reason = 'set by the test' WHERE project_id = '{project}' AND slug = '{slug}' AND order_seq IS NULL;"
        ))
        .unwrap();
    refresh_steps(connection, "project_id = ?1 AND slug = ?2", params![project, slug]).unwrap();
}

/// Forgets grid `slug`'s order, for tests of a grid that has none.
#[cfg(test)]
pub(crate) fn clear_order(connection: &Connection, project: &str, slug: &str) {
    for table in ["grid_row", "grid_column"] {
        connection
            .execute(&format!("UPDATE {table} SET order_seq = NULL, order_reason = NULL WHERE project_id = ?1 AND slug = ?2"), params![project, slug])
            .unwrap();
    }
    refresh_steps(connection, "project_id = ?1 AND slug = ?2", params![project, slug]).unwrap();
}

fn step_line(slug: &str, cell: &Cell) -> String {
    format!("{slug}.{}.{}: step {}, next `{}`", cell.row, cell.col, cell.step, cell.next.as_deref().unwrap_or(""))
}

pub const AGENT_ACTIONS: &[&str] = &[
    "draft", "checks", "change", "discover", "prove", "verify", "na", "audit_done", "pass", "reopen", "template_set", "note", "order", "cases", "review",
];
/// What the owner does on the Grids screen; nothing there is an approval.
pub const OWNER_ACTIONS: &[&str] = &["reopen", "verify", "discover", "note", "order"];
/// What a `grid` widget's `event` may be.
pub const WIDGET_EVENTS: &[&str] = &["draft", "template", "prove", "na", "audit", "reopen", "pass", "discover"];
pub const STATUSES: &[&str] = &["draft", "approved", "discarded"];
/// A cell's states; `in_progress` and `na_pending` only on cards drawn before
/// cells stopped waiting for tasks and for the owner.
pub const STATES: &[&str] = &["unchecked", "gap", "in_progress", "proved", "na_pending", "na"];
pub const MAX_ROWS: usize = 400;
pub const MAX_COLUMNS: usize = 40;
pub const ID_RULE: &str = "lower-case letters, digits, _ and -, starting with a letter or digit, at most 64 characters";

/// Ids (grid slug, row, column, template) are `[a-z0-9][a-z0-9_-]{0,63}`.
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

/// A path inside the repository, written from its top.
pub fn repo_relative(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path.split('/').all(|part| part != "..")
}

fn refuse<T>(message: impl Into<String>) -> Result<T, TaskError> {
    Err(TaskError::Refused(message.into()))
}

fn json_column(row: &Row, index: usize) -> rusqlite::Result<Option<Value>> {
    Ok(row
        .get::<_, Option<String>>(index)?
        .and_then(|text| serde_json::from_str(&text).ok()))
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect()
}

/* ------------------------------------------------------------- records */

#[derive(Clone, Debug)]
pub struct Grid {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub area: String,
    pub status: String,
    pub template: Option<String>,
    pub row_search: Value,
    pub pending: Option<Value>,
    pub created_by: Option<String>,
    pub drafted_by: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub approved_at: Option<i64>,
    pub discovery: Option<Value>,
    /// What approval locked: `{files: {path: sha256}}` for the check files
    /// of every cell, taken in the project's folder.
    pub hashes: Option<Value>,
}

const GRID_COLUMNS: &str = "project_id, slug, title, area, status, template, row_search, pending, created_by, drafted_by,
    created_at, updated_at, approved_at, discovery, hashes";

fn grid_record(row: &Row) -> rusqlite::Result<Grid> {
    Ok(Grid {
        project_id: row.get(0)?,
        slug: row.get(1)?,
        title: row.get(2)?,
        area: row.get(3)?,
        status: row.get(4)?,
        template: row.get(5)?,
        row_search: json_column(row, 6)?.unwrap_or(Value::Null),
        pending: json_column(row, 7)?,
        created_by: row.get(8)?,
        drafted_by: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        approved_at: row.get(12)?,
        discovery: json_column(row, 13)?,
        hashes: json_column(row, 14)?,
    })
}

pub fn get_grid(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Option<Grid>> {
    connection
        .query_row(
            &format!("SELECT {GRID_COLUMNS} FROM grid WHERE project_id = ?1 AND slug = ?2"),
            params![project, slug],
            grid_record,
        )
        .optional()
}

/// A project's grids, discarded ones included, by slug.
pub fn list_grids(connection: &Connection, project: &str) -> rusqlite::Result<Vec<Grid>> {
    let mut statement = connection.prepare(&format!("SELECT {GRID_COLUMNS} FROM grid WHERE project_id = ?1 ORDER BY slug"))?;
    let rows = statement.query_map([project], grid_record)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The projects that have a live grid, for the watcher.
pub fn projects_with_grids(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare("SELECT DISTINCT project_id FROM grid WHERE status = 'approved' ORDER BY project_id")?;
    let rows = statement.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn save_grid(connection: &Connection, grid: &Grid) -> rusqlite::Result<()> {
    let text = |value: &Option<Value>| value.as_ref().map(Value::to_string);
    connection.execute(
        &format!("INSERT OR REPLACE INTO grid ({GRID_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"),
        params![
            grid.project_id, grid.slug, grid.title, grid.area, grid.status, grid.template,
            grid.row_search.to_string(), text(&grid.pending), grid.created_by, grid.drafted_by,
            grid.created_at, grid.updated_at, grid.approved_at, text(&grid.discovery), text(&grid.hashes),
        ],
    )?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub id: String,
    pub name: String,
    pub proof_rule: String,
    pub position: i64,
    pub from_template: bool,
    pub retired_at: Option<i64>,
    /// Check templates, `{row}` standing for the row id.
    pub checks: Vec<Value>,
    /// Columns whose cell in the same row must be proved or N/A first.
    pub after: Vec<String>,
    /// Its place in the written order, and why; None until ordered.
    pub order_seq: Option<i64>,
    pub order_reason: Option<String>,
}

pub fn columns(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Vec<Column>> {
    let mut statement = connection.prepare(
        "SELECT id, name, proof_rule, position, from_template, retired_at, checks, after, order_seq, order_reason FROM grid_column
          WHERE project_id = ?1 AND slug = ?2 ORDER BY position, id",
    )?;
    let rows = statement
        .query_map(params![project, slug], |row| {
            Ok(Column {
                id: row.get(0)?,
                name: row.get(1)?,
                proof_rule: row.get(2)?,
                position: row.get(3)?,
                from_template: row.get::<_, i64>(4)? != 0,
                retired_at: row.get(5)?,
                checks: json_column(row, 6)?.and_then(|v| v.as_array().cloned()).unwrap_or_default(),
                after: strings(&json_column(row, 7)?.unwrap_or(Value::Null)),
                order_seq: row.get(8)?,
                order_reason: row.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[derive(Clone, Debug, PartialEq)]
pub struct GridRow {
    pub id: String,
    pub name: String,
    /// `feature`, `combination` or `reference`.
    pub kind: String,
    pub paths: Vec<String>,
    pub of: Vec<String>,
    /// `{grid, row}`, for a reference.
    pub reference: Option<Value>,
    /// `search` or `manual`.
    pub source: String,
    pub added_at: i64,
    pub missing_since: Option<i64>,
    pub removed_at: Option<i64>,
    /// Rows whose cell in the same column must be proved or N/A first.
    pub after: Vec<String>,
    /// Its place in the written order, and why; None until ordered.
    pub order_seq: Option<i64>,
    pub order_reason: Option<String>,
}

impl GridRow {
    /// A feature or combination that is printed (or manual) and not removed:
    /// its cells count.
    pub fn counts(&self) -> bool {
        self.kind != "reference" && self.missing_since.is_none() && self.removed_at.is_none()
    }
}

pub fn rows(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Vec<GridRow>> {
    let mut statement = connection.prepare(
        "SELECT id, name, kind, paths, of, ref, source, added_at, missing_since, removed_at, after, order_seq, order_reason FROM grid_row
          WHERE project_id = ?1 AND slug = ?2 ORDER BY rowid",
    )?;
    let rows = statement
        .query_map(params![project, slug], |row| {
            Ok(GridRow {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                paths: strings(&json_column(row, 3)?.unwrap_or(Value::Null)),
                of: strings(&json_column(row, 4)?.unwrap_or(Value::Null)),
                reference: json_column(row, 5)?,
                source: row.get(6)?,
                added_at: row.get(7)?,
                missing_since: row.get(8)?,
                removed_at: row.get(9)?,
                after: strings(&json_column(row, 10)?.unwrap_or(Value::Null)),
                order_seq: row.get(11)?,
                order_reason: row.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub row: String,
    pub col: String,
    pub state: String,
    pub proof: Option<Value>,
    pub fingerprint: Option<String>,
    pub proved_by: Option<String>,
    pub proved_at: Option<i64>,
    pub last_check: Option<Value>,
    pub claimed_task: Option<i64>,
    pub claimed_from: Option<String>,
    pub reason: Option<String>,
    pub audited_at: Option<i64>,
    pub audited_by: Option<String>,
    /// The cell's own checks, approved with the grid: `{checks, override}`.
    pub own_checks: Option<Value>,
    /// open, red, work, proved or na; set by `refresh_steps` on every save.
    pub step: String,
    /// The one command that moves the cell on from its step.
    pub next: Option<String>,
    /// Cells in any row this one waits for: `[[ROW, COL], …]`.
    pub after: Option<Value>,
    /// The cell's cases, one scenario each, as checks with their case id.
    pub cases: Option<Value>,
    /// Its coverage review: `{rounds: [[{id, scenario}]], answers: {GAP: {case} | {dismissed}}}`.
    pub review: Option<Value>,
    /// Where its cases stand: none (needs cases or answers), `review` (ready
    /// for a review) or `reviewed`.
    pub case_step: Option<String>,
    /// When its cases were reviewed.
    pub cases_approved: Option<i64>,
    /// Its checks changed since it was proved: the proof is stale until it
    /// is proved again or passes a re-check under the new checks.
    pub checks_changed: bool,
}

impl Cell {
    /// The cells this one waits for, as (row, col).
    pub fn waits_on(&self) -> Vec<(String, String)> {
        self.after
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|pair| Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string())))
            .collect()
    }
}

const CELL_COLUMNS: &str = "row, col, state, proof, fingerprint, proved_by, proved_at, last_check, claimed_task, claimed_from,
    reason, audited_at, audited_by, checks, step, next, after, cases, review, case_step, cases_approved, checks_changed";

fn cell_record(row: &Row) -> rusqlite::Result<Cell> {
    cell_record_at(row, 0)
}

/// A cell whose columns start at `at` in the row.
fn cell_record_at(row: &Row, at: usize) -> rusqlite::Result<Cell> {
    Ok(Cell {
        row: row.get(at)?,
        col: row.get(at + 1)?,
        state: row.get(at + 2)?,
        proof: json_column(row, at + 3)?,
        fingerprint: row.get(at + 4)?,
        proved_by: row.get(at + 5)?,
        proved_at: row.get(at + 6)?,
        last_check: json_column(row, at + 7)?,
        claimed_task: row.get(at + 8)?,
        claimed_from: row.get(at + 9)?,
        reason: row.get(at + 10)?,
        audited_at: row.get(at + 11)?,
        audited_by: row.get(at + 12)?,
        own_checks: json_column(row, at + 13)?,
        step: row.get::<_, Option<String>>(at + 14)?.unwrap_or_else(|| "open".into()),
        next: row.get(at + 15)?,
        after: json_column(row, at + 16)?,
        cases: json_column(row, at + 17)?,
        review: json_column(row, at + 18)?,
        case_step: row.get(at + 19)?,
        cases_approved: row.get(at + 20)?,
        checks_changed: row.get::<_, Option<i64>>(at + 21)?.unwrap_or(0) != 0,
    })
}

pub fn cells(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Vec<Cell>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {CELL_COLUMNS} FROM grid_cell WHERE project_id = ?1 AND slug = ?2 ORDER BY row, col"
    ))?;
    let rows = statement.query_map(params![project, slug], cell_record)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_cell(connection: &Connection, project: &str, slug: &str, row: &str, col: &str) -> rusqlite::Result<Option<Cell>> {
    connection
        .query_row(
            &format!("SELECT {CELL_COLUMNS} FROM grid_cell WHERE project_id = ?1 AND slug = ?2 AND row = ?3 AND col = ?4"),
            params![project, slug, row, col],
            cell_record,
        )
        .optional()
}

fn save_cell(connection: &Connection, project: &str, slug: &str, cell: &Cell) -> rusqlite::Result<()> {
    let text = |value: &Option<Value>| value.as_ref().map(Value::to_string);
    connection.execute(
        &format!(
            "INSERT OR REPLACE INTO grid_cell (project_id, slug, {CELL_COLUMNS})
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)"
        ),
        params![
            project, slug, cell.row, cell.col, cell.state, text(&cell.proof), cell.fingerprint, cell.proved_by,
            cell.proved_at, text(&cell.last_check), cell.claimed_task, cell.claimed_from, cell.reason,
            cell.audited_at, cell.audited_by, text(&cell.own_checks), cell.step, cell.next, text(&cell.after),
            text(&cell.cases), text(&cell.review), cell.case_step, cell.cases_approved, cell.checks_changed as i64,
        ],
    )?;
    refresh_steps(connection, "project_id = ?1 AND slug = ?2 AND row = ?3 AND col = ?4", params![project, slug, cell.row, cell.col])
}

/// One grid as stored.
#[derive(Clone, Debug)]
pub struct Loaded {
    pub grid: Grid,
    pub columns: Vec<Column>,
    pub rows: Vec<GridRow>,
    pub cells: Vec<Cell>,
}

impl Loaded {
    pub fn row(&self, id: &str) -> Option<&GridRow> {
        self.rows.iter().find(|row| row.id == id)
    }

    pub fn column(&self, id: &str) -> Option<&Column> {
        self.columns.iter().find(|column| column.id == id)
    }

    pub fn cell(&self, row: &str, col: &str) -> Option<&Cell> {
        self.cells.iter().find(|cell| cell.row == row && cell.col == col)
    }

    /// The paths a row covers: its own, and for a combination those of every
    /// row in its `of`.
    pub fn covered(&self, id: &str) -> Vec<String> {
        let Some(row) = self.row(id) else { return Vec::new() };
        let mut paths = row.paths.clone();
        if row.kind == "combination" {
            for other in &row.of {
                if let Some(other) = self.row(other) {
                    paths.extend(other.paths.iter().cloned());
                }
            }
        }
        // What the row's cells' checks rely on: their files and the paths
        // they watch, so changing a check or a watched file makes the proof stale.
        for column in self.columns.iter().filter(|column| column.retired_at.is_none()) {
            for check in self.cell_checks(id, &column.id) {
                for key in ["files", "watch"] {
                    paths.extend(check[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string));
                }
            }
        }
        paths.sort();
        paths.dedup();
        paths
    }

    /// A cell's checks, resolved: the column's templates with `{row}` made
    /// the row id, then the cell's own; or only the cell's own when it
    /// overrides the column's. Empty: the cell needs a check.
    pub fn cell_checks(&self, row: &str, col: &str) -> Vec<Value> {
        let own = self.cell(row, col).and_then(|cell| cell.own_checks.clone()).unwrap_or(Value::Null);
        let mut checks = Vec::new();
        if own["override"] != true {
            if let Some(column) = self.column(col) {
                checks.extend(column.checks.iter().map(|template| fill_row(template, row)));
            }
        }
        checks.extend(own["checks"].as_array().into_iter().flatten().map(|template| fill_row(template, row)));
        if let Some(cell) = self.cell(row, col) {
            checks.extend(cases::as_checks(cell));
        }
        checks
    }

    /// The names of a cell's checks that are not its cases: the column's
    /// (unless overridden) and its own.
    pub fn plain_check_names(&self, row: &str, col: &str) -> Vec<String> {
        let cases = self.cell(row, col).map(cases::ids).unwrap_or_default();
        self.cell_checks(row, col)
            .iter()
            .filter_map(|check| check["name"].as_str())
            .filter(|name| !cases.iter().any(|id| id == name))
            .map(str::to_string)
            .collect()
    }

    /// Why cell `row`.`col` cannot be worked for want of an order: its row
    /// or column has no place in the written order. None once both do.
    pub fn unordered(&self, row: &str, col: &str) -> Option<String> {
        let slug = &self.grid.slug;
        let missing = if self.row(row).is_some_and(|r| r.order_seq.is_none()) {
            format!("row {row}")
        } else if self.column(col).is_some_and(|c| c.order_seq.is_none()) {
            format!("column {col}")
        } else {
            return None;
        };
        Some(format!(
            "grid {slug} has no order for {missing} yet. Write the order first with `atelier grid order {slug}`: \
             every row and every column, each with what it comes after and a reason"
        ))
    }

    /// Whether every live cell of `row` that is not N/A has its cases
    /// approved by the owner.
    pub fn row_approved(&self, row: &str) -> bool {
        cases::row_waiting(self, row).is_empty()
    }

    /// Every row that has cells, with the paths it covers: what has to be
    /// fingerprinted to tell which proofs are stale.
    pub fn coverage(&self) -> Vec<(String, Vec<String>)> {
        self.rows
            .iter()
            .filter(|row| row.kind != "reference")
            .map(|row| (row.id.clone(), self.covered(&row.id)))
            .collect()
    }
}

/// A check template with `{row}` replaced by the row id, in every text.
pub fn fill_row(template: &Value, row: &str) -> Value {
    match template {
        Value::String(text) => Value::String(text.replace("{row}", row)),
        Value::Array(items) => Value::Array(items.iter().map(|item| fill_row(item, row)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), fill_row(value, row))).collect()),
        other => other.clone(),
    }
}

/// A cell's JSON with its resolved checks and whether it needs one.
pub fn with_checks(loaded: &Loaded, row: &str, col: &str, mut value: Value) -> Value {
    let checks = loaded.cell_checks(row, col);
    value["needsCheck"] = json!(checks.is_empty());
    if let Some(cell) = loaded.cell(row, col) {
        value["needsCases"] = json!(cases::needs_cases(cell));
        value["cases"] = cell.cases.clone().unwrap_or_else(|| json!([]));
        value["review"] = cell.review.clone().unwrap_or(Value::Null);
        value["casesApproved"] = json!(cell.cases_approved);
    }
    value["checks"] = Value::Array(checks);
    value
}

pub fn load(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Option<Loaded>> {
    let Some(grid) = get_grid(connection, project, slug)? else { return Ok(None) };
    Ok(Some(Loaded {
        columns: columns(connection, project, slug)?,
        rows: rows(connection, project, slug)?,
        cells: cells(connection, project, slug)?,
        grid,
    }))
}

/* ----------------------------------------------------- staleness, counts */

/// The fingerprint of each row's covered code now, in the project's folder,
/// by (grid slug, row id). A cell proved in a worktree whose commit the
/// project's folder does not have yet has its own entry, by (grid slug,
/// `cell_key`), taken in that worktree. A row missing here is taken as
/// unchanged.
pub type Prints = HashMap<(String, String), String>;

/// The key of one cell's own print; row ids have no '/'.
pub fn cell_key(row: &str, col: &str) -> String {
    format!("{row}/{col}")
}

/// The print a cell is judged by: its own, else its row's.
pub fn print_for<'a>(slug: &str, row: &str, col: &str, prints: &'a Prints) -> Option<&'a String> {
    prints.get(&(slug.to_string(), cell_key(row, col))).or_else(|| prints.get(&(slug.to_string(), row.to_string())))
}

/// A proved cell is stale when its checks changed since the proof, or its
/// covered code differs from the code it was proved on.
pub fn is_stale(slug: &str, cell: &Cell, prints: &Prints) -> bool {
    cell.state == "proved"
        && (cell.checks_changed
            || match (print_for(slug, &cell.row, &cell.col, prints), &cell.fingerprint) {
                (Some(now), Some(then)) => now != then,
                _ => false,
            })
}

/// The commit a cell's proof was last checked at.
pub fn checked_at(cell: &Cell) -> Option<&str> {
    cell.last_check.as_ref().and_then(|check| check["head"].as_str())
}

/// The prints of every row of these grids in `folder` at its HEAD, and of
/// each proved cell whose commit `folder` lacks, in the worktree that has it.
pub async fn prints_at(folder: &std::path::Path, loaded: &[Loaded]) -> (Prints, Option<String>) {
    let mut prints = Prints::new();
    let Some(head) = proof::head(folder).await else { return (prints, None) };
    // By commit: the other checkout that has it and its HEAD, or None for `folder`.
    let mut elsewhere: HashMap<String, Option<(std::path::PathBuf, String)>> = HashMap::new();
    for grid in loaded.iter().filter(|grid| grid.grid.status == "approved") {
        let slug = &grid.grid.slug;
        let coverage: HashMap<String, Vec<String>> = grid.coverage().into_iter().collect();
        for (row, paths) in &coverage {
            if let Some(print) = proof::fingerprint(folder, &head, paths).await {
                prints.insert((slug.clone(), row.clone()), print);
            }
        }
        for cell in grid.cells.iter().filter(|cell| cell.state == "proved") {
            let (Some(commit), Some(paths)) = (checked_at(cell), coverage.get(&cell.row)) else { continue };
            if !elsewhere.contains_key(commit) {
                let checkout = proof::checkout_for(folder, commit).await;
                let other = match checkout.as_path() == folder {
                    true => None,
                    false => proof::head(&checkout).await.map(|theirs| (checkout, theirs)),
                };
                elsewhere.insert(commit.to_string(), other);
            }
            let Some((checkout, theirs)) = &elsewhere[commit] else { continue };
            if let Some(print) = proof::fingerprint(checkout, theirs, paths).await {
                prints.insert((slug.clone(), cell_key(&cell.row, &cell.col)), print);
            }
        }
    }
    (prints, Some(head))
}

/// The cells that count: those of live feature and combination rows in live
/// columns.
fn live_cells<'a>(loaded: &'a Loaded) -> impl Iterator<Item = &'a Cell> + 'a {
    let rows: HashSet<&str> = loaded.rows.iter().filter(|row| row.counts()).map(|row| row.id.as_str()).collect();
    let cols: HashSet<&str> =
        loaded.columns.iter().filter(|col| col.retired_at.is_none()).map(|col| col.id.as_str()).collect();
    loaded.cells.iter().filter(move |cell| rows.contains(cell.row.as_str()) && cols.contains(cell.col.as_str()))
}

pub fn counts(loaded: &Loaded, prints: &Prints) -> Value {
    let (mut counted, mut proved, mut stale, mut gap, mut unchecked, mut na) = (0, 0, 0, 0, 0, 0);
    for cell in live_cells(loaded) {
        if cell.state == "na" {
            na += 1;
            continue;
        }
        counted += 1;
        match cell.state.as_str() {
            "proved" if is_stale(&loaded.grid.slug, cell, prints) => stale += 1,
            "proved" => proved += 1,
            "gap" => gap += 1,
            "unchecked" => unchecked += 1,
            _ => {}
        }
    }
    json!({"counted": counted, "proved": proved, "stale": stale, "gap": gap, "unchecked": unchecked, "na": na})
}

/// Fresh proof over counted cells, rounded down; only live grids have one.
pub fn percent(loaded: &Loaded, counts: &Value) -> Option<i64> {
    if loaded.grid.status != "approved" {
        return None;
    }
    let counted = counts["counted"].as_i64().unwrap_or(0);
    let proved = counts["proved"].as_i64().unwrap_or(0);
    Some(if counted == 0 { 0 } else { proved * 100 / counted })
}

/// `GridSummary` (docs/grids.md, "HTTP").
pub fn summary(loaded: &Loaded, prints: &Prints) -> Value {
    let grid = &loaded.grid;
    let counts = counts(loaded, prints);
    json!({
        "projectId": grid.project_id, "slug": grid.slug, "title": grid.title, "area": grid.area,
        "status": grid.status, "template": grid.template, "rowSearch": grid.row_search,
        "createdBy": grid.created_by, "draftedBy": grid.drafted_by, "approvedAt": grid.approved_at,
        "updatedAt": grid.updated_at, "discovery": grid.discovery,
        "percent": percent(loaded, &counts), "counts": counts,
    })
}

pub fn column_json(column: &Column) -> Value {
    json!({"id": column.id, "name": column.name, "proofRule": column.proof_rule, "position": column.position,
        "fromTemplate": column.from_template, "retired": column.retired_at.is_some(), "checks": column.checks})
}

pub fn row_json(row: &GridRow) -> Value {
    json!({"id": row.id, "name": row.name, "kind": row.kind, "paths": row.paths, "of": row.of,
        "ref": row.reference, "source": row.source, "missing": row.missing_since.is_some(),
        "removed": row.removed_at.is_some()})
}

/// A cell as the grid lists it; with `full`, its whole proof and last check.
pub fn cell_json(cell: &Cell, stale: bool, full: bool) -> Value {
    let last_check = cell.last_check.as_ref().map(|check| {
        if full {
            check.clone()
        } else {
            json!({"at": check["at"], "passed": check["passed"]})
        }
    });
    let mut value = json!({
        "row": cell.row, "col": cell.col, "state": cell.state, "stale": stale,
        "reason": cell.reason, "provedBy": cell.proved_by,
        "provedAt": cell.proved_at, "auditedAt": cell.audited_at, "lastCheck": last_check,
        "proofSummary": cell.proof.as_ref().and_then(|proof| proof["summary"].as_str()),
        "step": cell.step, "next": cell.next, "checksChanged": cell.checks_changed,
        "after": cell.waits_on().iter().map(|(row, col)| format!("{row}.{col}")).collect::<Vec<_>>(),
    });
    if full {
        value["proof"] = cell.proof.clone().unwrap_or(Value::Null);
        value["fingerprint"] = json!(cell.fingerprint);
        value["auditedBy"] = json!(cell.audited_by);
    }
    value
}

pub fn events(connection: &Connection, project: &str, slug: &str, cell: Option<(&str, &str)>) -> rusqlite::Result<Vec<Value>> {
    let (row, col) = cell.unzip();
    let mut statement = connection.prepare(
        "SELECT seq, at, kind, row, col, session_id, actor, payload FROM grid_event
          WHERE project_id = ?1 AND slug = ?2 AND (?3 IS NULL OR (row = ?3 AND col = ?4)) ORDER BY seq",
    )?;
    let rows = statement
        .query_map(params![project, slug, row, col], |row| {
            Ok(json!({
                "seq": row.get::<_, i64>(0)?,
                "at": row.get::<_, i64>(1)?,
                "kind": row.get::<_, String>(2)?,
                "row": row.get::<_, Option<String>>(3)?,
                "col": row.get::<_, Option<String>>(4)?,
                "sessionId": row.get::<_, Option<String>>(5)?,
                "actor": row.get::<_, String>(6)?,
                "payload": json_column(row, 7)?.unwrap_or(Value::Null),
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[allow(clippy::too_many_arguments)]
fn append_event(
    connection: &Connection,
    project: &str,
    slug: &str,
    at: i64,
    kind: &str,
    cell: Option<(&str, &str)>,
    session: Option<&str>,
    actor: &str,
    payload: &Value,
) -> rusqlite::Result<()> {
    let (row, col) = cell.unzip();
    connection.execute(
        "INSERT INTO grid_event (project_id, slug, seq, at, kind, row, col, session_id, actor, payload)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM grid_event WHERE project_id = ?1 AND slug = ?2),
                 ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![project, slug, at, kind, row, col, session, actor, payload.to_string()],
    )?;
    Ok(())
}

/* ------------------------------------------------------------ templates */

#[derive(Clone, Debug)]
pub struct Template {
    pub name: String,
    /// `[{id, name, proof_rule}]`.
    pub columns: Vec<Value>,
    /// `{columns, by, at}`: left only by older builds; cleared when the app starts.
    pub pending: Option<Value>,
    pub updated_at: i64,
    pub updated_by: Option<String>,
}

fn template_record(row: &Row) -> rusqlite::Result<Template> {
    Ok(Template {
        name: row.get(0)?,
        columns: json_column(row, 1)?.and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        pending: json_column(row, 2)?,
        updated_at: row.get(3)?,
        updated_by: row.get(4)?,
    })
}

pub fn templates(connection: &Connection, project: &str) -> rusqlite::Result<Vec<Template>> {
    let mut statement = connection
        .prepare("SELECT name, columns, pending, updated_at, updated_by FROM grid_template WHERE project_id = ?1 ORDER BY name")?;
    let rows = statement.query_map([project], template_record)?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get_template(connection: &Connection, project: &str, name: &str) -> rusqlite::Result<Option<Template>> {
    connection
        .query_row(
            "SELECT name, columns, pending, updated_at, updated_by FROM grid_template WHERE project_id = ?1 AND name = ?2",
            params![project, name],
            template_record,
        )
        .optional()
}

fn template_columns_json(columns: &[Value]) -> Value {
    Value::Array(
        columns
            .iter()
            .map(|column| json!({"id": column["id"], "name": column["name"], "proofRule": column["proof_rule"],
                "checks": column.get("checks").cloned().unwrap_or_else(|| json!([]))}))
            .collect(),
    )
}

/// `Template` (docs/grids.md, "HTTP").
pub fn template_json(template: &Template) -> Value {
    let pending = template.pending.as_ref().map(|pending| {
        json!({"columns": template_columns_json(pending["columns"].as_array().map(Vec::as_slice).unwrap_or(&[])),
            "by": pending["by"], "at": pending["at"]})
    });
    json!({"name": template.name, "columns": template_columns_json(&template.columns), "pending": pending,
        "updatedAt": template.updated_at})
}

/// What a pending template change does: columns added, removed and changed,
/// the live grids that use it, and grids whose own column already has an
/// id the change adds.
pub fn template_change(connection: &Connection, project: &str, template: &Template) -> rusqlite::Result<Value> {
    let Some(pending) = &template.pending else { return Ok(Value::Null) };
    let new: Vec<Value> = pending["columns"].as_array().cloned().unwrap_or_default();
    let old_ids: Vec<&str> = template.columns.iter().filter_map(|c| c["id"].as_str()).collect();
    let new_ids: Vec<&str> = new.iter().filter_map(|c| c["id"].as_str()).collect();
    let added: Vec<&str> = new_ids.iter().copied().filter(|id| !old_ids.contains(id)).collect();
    let removed: Vec<&str> = old_ids.iter().copied().filter(|id| !new_ids.contains(id)).collect();
    let changed: Vec<&str> = new
        .iter()
        .filter(|column| {
            template.columns.iter().any(|old| {
                old["id"] == column["id"] && (old["name"] != column["name"] || old["proof_rule"] != column["proof_rule"])
            })
        })
        .filter_map(|column| column["id"].as_str())
        .collect();
    let mut affects = Vec::new();
    let mut clashes = Vec::new();
    for grid in list_grids(connection, project)? {
        if grid.status != "approved" || grid.template.as_deref() != Some(&template.name) {
            continue;
        }
        affects.push(grid.slug.clone());
        for column in columns(connection, project, &grid.slug)? {
            if !column.from_template && column.retired_at.is_none() && added.contains(&column.id.as_str()) {
                clashes.push(json!({"grid": grid.slug, "column": column.id}));
            }
        }
    }
    Ok(json!({"added": added, "removed": removed, "changed": changed, "affects": affects, "clashes": clashes}))
}

/* -------------------------------------------------------- the requests */

/// A change, with what the route worked out beforehand.
#[derive(Debug, Default)]
pub struct Request {
    pub action: String,
    /// `agent`, `owner`, or `app` (the watcher).
    pub actor: String,
    pub session: Option<String>,
    pub project: String,
    /// The grid; the template's name for template actions.
    pub slug: Option<String>,
    pub row: Option<String>,
    pub col: Option<String>,
    pub payload: Value,
    /// The row search's run, for `draft` and `discover`.
    pub search: Option<Result<search::Run, String>>,
    /// The checks' results, for `prove` and `verify`.
    pub checks: Vec<proof::CheckResult>,
    /// For `prove`: the row's fingerprint in the proving chat's folder; for
    /// `verify`: in the project's folder.
    pub fingerprint: Option<String>,
    /// The commit the checks ran at.
    pub head: Option<String>,
    /// For `prove`: covered paths with uncommitted changes.
    pub dirty: Vec<String>,
    pub missing_commits: HashSet<String>,
    /// The folder `prove` was given in, for messages.
    pub cwd: Option<String>,
    /// Fingerprints now, in the project's folder.
    pub prints: Prints,
    /// For `draft`, `change` and `checks`: the checks' files hashed in the
    /// chat's folder, `{files: {path: sha}}`. For `prove`: those files now.
    pub hashes: Option<Value>,
    pub now: i64,
}

#[derive(Debug, Default)]
pub struct Outcome {
    /// The grid that changed.
    pub slug: Option<String>,
    pub cell: Option<(String, String)>,
    pub summary: String,
    /// The card's `event`, when the change prints one.
    pub widget: Option<&'static str>,
    /// The change was recorded, but what was asked failed (a row search that
    /// failed, a check that failed on re-check).
    pub failed: Option<String>,
    pub template: Option<Value>,
    pub audit: Option<Value>,
    /// Every grid the change touched (a template change touches several).
    pub grids: Vec<String>,
}

fn payload_text<'a>(payload: &'a Value, key: &str, what: &str, max: usize) -> Result<&'a str, TaskError> {
    match payload.get(key) {
        Some(Value::String(text)) if !text.trim().is_empty() => {
            let count = text.trim().chars().count();
            if count > max {
                return refuse(format!("{key} is {count} characters; at most {max}"));
            }
            Ok(text.trim())
        }
        Some(Value::String(_)) => refuse(format!("{key} is blank: {what}")),
        Some(Value::Null) | None => refuse(format!("{key} is required: {what}")),
        Some(_) => refuse(format!("{key} must be text: {what}")),
    }
}

fn need<'a>(value: &'a Option<String>, what: &str, action: &str) -> Result<&'a str, TaskError> {
    match value.as_deref() {
        Some(id) if valid_id(id) => Ok(id),
        Some(id) => refuse(format!("{what} \"{id}\" is not a valid id ({ID_RULE})")),
        None => refuse(format!("{what} is required for {action}")),
    }
}

/// Apply one change. Runs inside a transaction; nothing is written on refusal.
pub fn apply(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let transaction = connection.unchecked_transaction()?;
    let outcome = apply_in(&transaction, request)?;
    transaction.commit()?;
    Ok(outcome)
}

fn apply_in(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let action = request.action.as_str();
    match request.actor.as_str() {
        "agent" => {
            if !AGENT_ACTIONS.contains(&action) {
                return refuse(format!("{action} is not an agent action (agent actions: {})", AGENT_ACTIONS.join(", ")));
            }
            if request.session.is_none() {
                return refuse("session is required for agent actions");
            }
        }
        "owner" => {
            if !OWNER_ACTIONS.contains(&action) {
                return refuse(format!("{action} is not an owner action (owner actions: {})", OWNER_ACTIONS.join(", ")));
            }
        }
        "app" if action == "discover" => {}
        // The coverage review's answer, recorded by the route after it ran
        // the reviewer (docs/grids.md, "Cases").
        "reviewer" if action == "review" => {}
        other => return refuse(format!("actor must be agent or owner, not \"{other}\"")),
    }
    match action {
        "draft" => draft(connection, request),
        "checks" => add_checks(connection, request),
        "change" => change(connection, request),
        "discover" => discover(connection, request),
        "prove" => prove(connection, request),
        "verify" => verify(connection, request),
        "na" => ask_na(connection, request),
        "reopen" => reopen(connection, request),
        "pass" => pass(connection, request),
        "audit_done" => audit_done(connection, request),
        "template_set" => template_set(connection, request),
        "note" => note(connection, request),
        "order" => order(connection, request),
        "cases" => cases::set(connection, request),
        "review" => cases::record_review(connection, request),
        _ => refuse(format!("{action} is not a grid action")),
    }
}

/* -------------------------------------------------------------- drafts */

fn check_title(text: &str, key: &str, max: usize) -> Result<(), TaskError> {
    if text.contains('\n') {
        return refuse(format!("{key} must be one line"));
    }
    let count = text.chars().count();
    if count > max {
        return refuse(format!("{key} is {count} characters; at most {max}"));
    }
    Ok(())
}

/// A column's or cell's check templates: checks as a task item takes them,
/// with `{row}` allowed anywhere for the row id and no other placeholder: a
/// column check tests the same requirement for every row. With `prefix`
/// (`GRID/{row}/COL`, or `GRID/ROW/COL` for a cell's own), each check gets
/// its case id `PREFIX/NAME`, and its red must contain it (docs/grids.md,
/// "Cases").
fn check_templates(value: &Value, at: &str, prefix: Option<&str>) -> Result<Vec<Value>, TaskError> {
    if let Some(found) = cases::other_placeholder(value) {
        return refuse(format!(
            "{at}: {found} is not allowed; {{row}} is the only placeholder in a column check. A check that needs row-specific scenarios, scenes, budgets or data belongs in the cell's own cases (`atelier grid cases`)"
        ));
    }
    let mut templates = value.as_array().cloned().unwrap_or_default();
    if let Some(prefix) = prefix {
        for template in templates.iter_mut() {
            if let (Some(name), Some(object)) = (template["name"].as_str().map(str::to_string), template.as_object_mut()) {
                object.insert("case".into(), json!(format!("{prefix}/{name}")));
            }
        }
    }
    for (index, template) in templates.iter().enumerate() {
        if let (Some(case), Some(red)) = (template["case"].as_str(), template["red"].as_str()) {
            if !red.contains(case) {
                let name = template["name"].as_str().unwrap_or("");
                return refuse(format!("{at}[{index}] (check \"{name}\").red must contain its case id {case}, as in \"CASE {case} FAIL\""));
            }
        }
    }
    let parsed = crate::workbench::tasks::checks::parse_checks(&fill_row(&Value::Array(templates.clone()), "row"), at)?;
    // The red a case check defaults to.
    for (template, check) in templates.iter_mut().zip(parsed) {
        if template.get("red").is_none_or(Value::is_null) {
            if let (Some(case), Some(_)) = (template["case"].as_str().map(str::to_string), check.red) {
                template["red"] = json!(format!("CASE {case} FAIL"));
            }
        }
    }
    Ok(templates)
}

/// `[{id, name, proof_rule, checks?}]`, checked.
fn check_columns(value: Option<&Value>, at: &str, slug: Option<&str>) -> Result<Vec<Value>, TaskError> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return refuse(format!("{at} must be a list of {{id, name, proof_rule}}")),
    };
    let mut checked: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let here = format!("{at}[{index}]");
        let object = item.as_object().ok_or_else(|| TaskError::Refused(format!("{here} must be an object: {{id, name, proof_rule}}")))?;
        if let Some(unknown) = object.keys().find(|key| !["id", "name", "proof_rule", "checks"].contains(&key.as_str())) {
            return refuse(format!("{here}.{unknown} is not a column field (allowed: id, name, proof_rule, checks)"));
        }
        let id = item["id"].as_str().unwrap_or("");
        if !valid_id(id) {
            return refuse(format!("{here}.id \"{id}\" is not a valid id ({ID_RULE})"));
        }
        if checked.iter().any(|known| known["id"] == id) {
            return refuse(format!("{here}.id \"{id}\" is used twice"));
        }
        let name = payload_text(item, "name", "the requirement in a few words", 120).map_err(|e| at_field(e, &here))?;
        check_title(name, &format!("{here}.name"), 120)?;
        let rule = payload_text(item, "proof_rule", "what counts as proof for this requirement", 1000).map_err(|e| at_field(e, &here))?;
        let mut column = json!({"id": id, "name": name, "proof_rule": rule});
        if let Some(checks) = object.get("checks").filter(|checks| !checks.is_null()) {
            let prefix = slug.map(|slug| format!("{slug}/{{row}}/{id}"));
            column["checks"] = json!(check_templates(checks, &format!("{here}.checks"), prefix.as_deref())?);
        }
        checked.push(column);
    }
    Ok(checked)
}

fn at_field(error: TaskError, at: &str) -> TaskError {
    match error {
        TaskError::Refused(message) => TaskError::Refused(format!("{at}.{message}")),
        other => other,
    }
}

/// A manual row from a draft payload, as stored in `pending.rows`.
fn check_manual_row(item: &Value, index: usize) -> Result<Value, TaskError> {
    let here = format!("rows[{index}]");
    let object = item.as_object().ok_or_else(|| TaskError::Refused(format!("{here} must be an object: {{id, name, kind?, paths?, of?, ref?}}")))?;
    if let Some(unknown) = object.keys().find(|key| !["id", "name", "kind", "paths", "of", "ref"].contains(&key.as_str())) {
        return refuse(format!("{here}.{unknown} is not a row field (allowed: id, name, kind, paths, of, ref)"));
    }
    let id = item["id"].as_str().unwrap_or("");
    if !valid_id(id) {
        return refuse(format!("{here}.id \"{id}\" is not a valid id ({ID_RULE})"));
    }
    let name = payload_text(item, "name", "the feature's name", 120).map_err(|e| at_field(e, &here))?;
    let kind = match item.get("kind").and_then(Value::as_str) {
        None => "feature",
        Some(kind @ ("feature" | "combination" | "reference")) => kind,
        Some(other) => return refuse(format!("{here}.kind \"{other}\" is not feature, combination or reference")),
    };
    let paths: Vec<String> = match item.get("paths") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(paths)) => paths
            .iter()
            .map(|path| match path.as_str().map(str::trim) {
                Some(path) if repo_relative(path) => Ok(path.to_string()),
                _ => refuse(format!("{here}.paths has {path}, which is not a repo-relative path")),
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return refuse(format!("{here}.paths must be a list of repo-relative paths")),
    };
    let of = strings(item.get("of").unwrap_or(&Value::Null));
    let mut reference = Value::Null;
    match kind {
        "combination" if of.len() < 2 => return refuse(format!("{here} is a combination; of must name at least two rows")),
        "feature" if !of.is_empty() => return refuse(format!("{here}.of is only for a combination")),
        "reference" => {
            if !paths.is_empty() || !of.is_empty() {
                return refuse(format!("{here} is a reference; it has no paths or of of its own"));
            }
            let target = item.get("ref").and_then(Value::as_object).ok_or_else(|| {
                TaskError::Refused(format!("{here} is a reference; ref is required: {{grid, row}} of the row it shows"))
            })?;
            let grid = target.get("grid").and_then(Value::as_str).unwrap_or("");
            let row = target.get("row").and_then(Value::as_str).unwrap_or("");
            if !valid_id(grid) || !valid_id(row) {
                return refuse(format!("{here}.ref must be {{grid, row}} with valid ids"));
            }
            reference = json!({"grid": grid, "row": row});
        }
        _ => {}
    }
    if kind != "reference" && item.get("ref").is_some_and(|r| !r.is_null()) {
        return refuse(format!("{here}.ref is only for a reference row"));
    }
    Ok(json!({"id": id, "name": name, "kind": kind, "paths": paths, "of": of, "ref": reference, "source": "manual"}))
}

/// The grid that owns a feature id, other than `except`.
fn owner_of(connection: &Connection, project: &str, id: &str, except: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT slug FROM grid_row WHERE project_id = ?1 AND id = ?2 AND kind <> 'reference'
               AND removed_at IS NULL AND slug <> ?3",
            params![project, id, except],
            |row| row.get(0),
        )
        .optional()
}

/// What makes the rows of a draft acceptable: no id another grid owns, every
/// reference pointing at a row its owner has, every `of` naming a row here.
fn check_rows(connection: &Connection, project: &str, slug: &str, rows: &[Value]) -> Result<(), TaskError> {
    if rows.len() > MAX_ROWS {
        return refuse(format!("the draft has {} rows; a grid has at most {MAX_ROWS}", rows.len()));
    }
    let ids: HashSet<&str> = rows.iter().filter_map(|row| row["id"].as_str()).collect();
    for row in rows {
        let id = row["id"].as_str().unwrap_or("");
        match row["kind"].as_str().unwrap_or("feature") {
            "reference" => {
                let grid = row["ref"]["grid"].as_str().unwrap_or("");
                let target = row["ref"]["row"].as_str().unwrap_or("");
                if grid == slug {
                    return refuse(format!("row \"{id}\" refers to this grid; a reference shows a row another grid owns"));
                }
                let found: Option<String> = connection
                    .query_row(
                        "SELECT kind FROM grid_row WHERE project_id = ?1 AND slug = ?2 AND id = ?3 AND removed_at IS NULL",
                        params![project, grid, target],
                        |r| r.get(0),
                    )
                    .optional()?;
                match found.as_deref() {
                    None => return refuse(format!("row \"{id}\" refers to {grid}.{target}, which is not a row of a live grid")),
                    Some("reference") => {
                        return refuse(format!("row \"{id}\" refers to {grid}.{target}, which is itself a reference; refer to its owner"))
                    }
                    Some(_) => {}
                }
            }
            kind => {
                if let Some(owner) = owner_of(connection, project, id, slug)? {
                    return refuse(format!(
                        "row \"{id}\" belongs to grid \"{owner}\"; a feature has one owner. Add it here as a reference row: \
                         {{\"id\": \"{id}\", \"name\": \"…\", \"kind\": \"reference\", \"ref\": {{\"grid\": \"{owner}\", \"row\": \"{id}\"}}}}"
                    ));
                }
                if kind == "combination" {
                    for other in strings(&row["of"]) {
                        if !ids.contains(other.as_str()) || other == id {
                            return refuse(format!("combination \"{id}\" names \"{other}\" in of, which is not another row of this draft"));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn draft(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let payload = &request.payload;
    let object = payload
        .as_object()
        .ok_or_else(|| TaskError::Refused("the draft payload must be an object: {slug, title, area, template?, row_search, columns, rows}".into()))?;
    const FIELDS: &[&str] = &["slug", "title", "area", "template", "row_search", "columns", "rows", "cells"];
    if let Some(unknown) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return refuse(format!("{unknown} is not a draft field (allowed: {})", FIELDS.join(", ")));
    }
    let slug = payload_text(payload, "slug", "the grid's id", 64)?;
    if !valid_id(slug) {
        return refuse(format!("slug \"{slug}\" is not a valid id ({ID_RULE})"));
    }
    let title = payload_text(payload, "title", "a short title, up to 120 characters", 120)?;
    check_title(title, "title", 120)?;
    let area = payload_text(payload, "area", "one paragraph on what the area is, up to 600 characters", 600)?;
    let row_search = search::check_row_search(object.get("row_search").unwrap_or(&Value::Null))?;
    let template = match object.get("template") {
        None | Some(Value::Null) => None,
        Some(Value::String(name)) => Some(name.trim().to_string()),
        Some(_) => return refuse("template must be a template's name (text)"),
    };
    let own_columns = check_columns(object.get("columns"), "columns", Some(slug))?;

    let existing = get_grid(connection, &request.project, slug)?;
    let edit = existing.as_ref().is_some_and(|grid| grid.status == "approved");

    // The columns: the template's, then the grid's own.
    let mut all_columns: Vec<Value> = Vec::new();
    if let Some(name) = &template {
        let found = get_template(connection, &request.project, name)?
            .ok_or_else(|| TaskError::Refused(format!("template \"{name}\" does not exist; run `atelier grid template list`")))?;
        if found.columns.is_empty() {
            return refuse(format!("template \"{name}\" has no approved columns yet"));
        }
        for column in &found.columns {
            let mut column = column.clone();
            column["from_template"] = json!(true);
            all_columns.push(column);
        }
    }
    for column in own_columns {
        if all_columns.iter().any(|known| known["id"] == column["id"]) {
            return refuse(format!(
                "column \"{}\" is a column of template \"{}\"; a grid's own column may not reuse a template column's id",
                column["id"].as_str().unwrap_or(""),
                template.as_deref().unwrap_or("")
            ));
        }
        let mut column = column;
        column["from_template"] = json!(false);
        all_columns.push(column);
    }
    if all_columns.is_empty() {
        return refuse("the draft has no columns: name a template, or give columns [{id, name, proof_rule}]");
    }
    if all_columns.len() > MAX_COLUMNS {
        return refuse(format!("the draft has {} columns; a grid has at most {MAX_COLUMNS}", all_columns.len()));
    }

    // The rows: what the search printed, then the manual ones.
    let run = match &request.search {
        Some(Ok(run)) => run,
        Some(Err(error)) => return refuse(format!("row_search failed in this chat's folder, so nothing was drafted: {error}")),
        None => return refuse("row_search was not run"),
    };
    let mut all_rows: Vec<Value> = run.rows.iter().map(search::Found::to_json).collect();
    let manual = match object.get("rows") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().enumerate().map(|(i, item)| check_manual_row(item, i)).collect::<Result<Vec<_>, _>>()?,
        Some(_) => return refuse("rows must be a list of manual rows"),
    };
    for row in manual {
        let id = row["id"].as_str().unwrap_or("");
        if run.rows.iter().any(|found| found.id == id) {
            return refuse(format!("rows has \"{id}\", which the row search also prints; leave it to the search"));
        }
        if all_rows.iter().any(|known| known["id"] == id) {
            return refuse(format!("rows has \"{id}\" twice"));
        }
        all_rows.push(row);
    }
    check_rows(connection, &request.project, slug, &all_rows)?;
    let cell_checks = check_cell_checks(object.get("cells"), &all_rows, &all_columns, slug)?;

    let now = request.now;
    let pending = json!({
        "title": title, "area": area, "template": template, "rowSearch": row_search,
        "columns": all_columns.iter().map(|c| json!({"id": c["id"], "name": c["name"], "proofRule": c["proof_rule"],
            "fromTemplate": c["from_template"], "checks": c.get("checks").cloned().unwrap_or_else(|| json!([]))})).collect::<Vec<_>>(),
        "cells": cell_checks,
        "rows": all_rows, "draftedBy": session,
        // Drafting ran the row search: it is the grid's last run.
        "searched": {"at": now, "head": run.head},
    });
    let grid = match existing.filter(|grid| grid.status != "discarded") {
        Some(mut grid) => {
            grid.drafted_by = Some(session.to_string());
            grid.updated_at = now;
            grid
        }
        None => Grid {
            project_id: request.project.clone(),
            slug: slug.into(),
            title: title.into(),
            area: area.into(),
            status: "draft".into(),
            template: template.clone(),
            row_search: row_search.clone(),
            pending: None,
            created_by: Some(session.to_string()),
            drafted_by: Some(session.to_string()),
            created_at: now,
            updated_at: now,
            approved_at: None,
            discovery: None,
            hashes: None,
        },
    };
    // A new grid is saved first so its rows and columns have a grid to join.
    save_grid(connection, &grid)?;
    let (rows_n, cols_n, _) = apply_pending(connection, &request.project, grid, &pending, request.hashes.as_ref(), now)?;
    append_event(connection, &request.project, slug, now, if edit { "edited" } else { "drafted" }, None, Some(session), "agent",
        &json!({"rows": rows_n, "columns": cols_n}))?;
    Ok(Outcome {
        slug: Some(slug.into()),
        summary: format!(
            "{} grid \"{slug}\" ({rows_n} rows × {cols_n} columns); it is live. Next: `atelier grid order {slug}`, then each cell's cases.",
            if edit { "Updated" } else { "Created" }
        ),
        widget: Some("draft"),
        grids: vec![slug.into()],
        ..Default::default()
    })
}

/// A draft's `cells: [{row, col, checks, override?}]`: a cell's own checks,
/// added to its column's or, with `override`, instead of them.
fn check_cell_checks(value: Option<&Value>, rows: &[Value], columns: &[Value], slug: &str) -> Result<Vec<Value>, TaskError> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return refuse("cells must be a list of {row, col, checks, override?}"),
    };
    let mut checked: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let here = format!("cells[{index}]");
        let object = item.as_object().ok_or_else(|| TaskError::Refused(format!("{here} must be an object: {{row, col, checks, override?}}")))?;
        if let Some(unknown) = object.keys().find(|key| !["row", "col", "checks", "override"].contains(&key.as_str())) {
            return refuse(format!("{here}.{unknown} is not a cell field (allowed: row, col, checks, override)"));
        }
        let (row, col) = (item["row"].as_str().unwrap_or(""), item["col"].as_str().unwrap_or(""));
        if !rows.iter().any(|known| known["id"] == row && known["kind"] != "reference") {
            return refuse(format!("{here}.row \"{row}\" is not a row of the draft"));
        }
        if !columns.iter().any(|known| known["id"] == col) {
            return refuse(format!("{here}.col \"{col}\" is not a column of the draft"));
        }
        if checked.iter().any(|known| known["row"] == row && known["col"] == col) {
            return refuse(format!("{here}: cell {row}.{col} is given twice"));
        }
        let over = match item.get("override") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => return refuse(format!("{here}.override must be true or false")),
        };
        let prefix = format!("{slug}/{row}/{col}");
        let checks = check_templates(item.get("checks").unwrap_or(&Value::Null), &format!("{here}.checks"), Some(&prefix))?;
        checked.push(json!({"row": row, "col": col, "checks": checks, "override": over}));
    }
    Ok(checked)
}

fn get_existing(connection: &Connection, project: &str, slug: &str) -> Result<Grid, TaskError> {
    get_grid(connection, project, slug)?
        .filter(|grid| grid.status != "discarded")
        .ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\" in this project")))
}

/// Write a grid's rows, columns and cells' own checks from `pending` (a
/// draft, a re-draft or a `grid change`) into its live tables. Kept cells
/// keep their proofs; a proved cell whose checks changed is marked so, and
/// reads stale until it is proved again. Returns (rows, columns, new cells).
fn apply_pending(connection: &Connection, project: &str, mut grid: Grid, pending: &Value, hashes: Option<&Value>, now: i64)
    -> Result<(usize, usize, usize), TaskError> {
    let slug = grid.slug.clone();
    let slug = slug.as_str();
    let session = pending["draftedBy"].as_str();
    let edit = grid.status == "approved";
    let rows_wanted: Vec<Value> = pending["rows"].as_array().cloned().unwrap_or_default();
    let cols_wanted: Vec<Value> = pending["columns"].as_array().cloned().unwrap_or_default();
    check_rows(connection, project, slug, &rows_wanted)?;
    let loaded = load(connection, project, slug)?.expect("the grid was just read");

    // Columns.
    let mut rechecked = Vec::new();
    for (position, column) in cols_wanted.iter().enumerate() {
        let id = column["id"].as_str().unwrap_or("");
        let added = !loaded.columns.iter().any(|known| known.id == id && known.retired_at.is_none());
        let wanted_checks = column["checks"].as_array().cloned().unwrap_or_default();
        if edit && loaded.columns.iter().any(|known| known.id == id && known.retired_at.is_none() && known.checks != wanted_checks) {
            rechecked.push(id.to_string());
        }
        connection.execute(
            "INSERT INTO grid_column (project_id, slug, id, name, proof_rule, position, from_template, retired_at, checks)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
             ON CONFLICT (project_id, slug, id) DO UPDATE SET name = ?4, proof_rule = ?5, position = ?6,
               from_template = ?7, retired_at = NULL, checks = ?8",
            params![project, slug, id, column["name"].as_str().unwrap_or(""), column["proofRule"].as_str().unwrap_or(""),
                position as i64, column["fromTemplate"].as_bool().unwrap_or(false) as i64,
                column.get("checks").filter(|c| c.as_array().is_some_and(|c| !c.is_empty())).map(Value::to_string)],
        )?;
        if edit && added {
            append_event(connection, project, slug, now, "column_added", None, session, "agent", &json!({"col": id}))?;
        }
    }
    for column in loaded.columns.iter().filter(|c| c.retired_at.is_none()) {
        if !cols_wanted.iter().any(|wanted| wanted["id"] == column.id.as_str()) {
            connection.execute(
                "UPDATE grid_column SET retired_at = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, column.id, now],
            )?;
            append_event(connection, project, slug, now, "column_retired", None, session, "agent", &json!({"col": column.id}))?;
        }
    }

    // Rows.
    for row in &rows_wanted {
        let id = row["id"].as_str().unwrap_or("");
        let known = loaded.row(id);
        let reference = if row["ref"].is_null() { None } else { Some(row["ref"].to_string()) };
        let inserted = connection.execute(
            "INSERT INTO grid_row (project_id, slug, id, name, kind, paths, of, ref, source, added_at, missing_since, removed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL)
             ON CONFLICT (project_id, slug, id) DO UPDATE SET name = ?4, kind = ?5, paths = ?6, of = ?7, ref = ?8,
               source = ?9, missing_since = NULL, removed_at = NULL",
            params![project, slug, id, row["name"].as_str().unwrap_or(""), row["kind"].as_str().unwrap_or("feature"),
                row["paths"].to_string(), row["of"].to_string(), reference, row["source"].as_str().unwrap_or("manual"), now],
        );
        match inserted {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(failure, _)) if failure.code == rusqlite::ErrorCode::ConstraintViolation => {
                return refuse(format!("row \"{id}\" is owned by another grid; use a reference row"));
            }
            Err(error) => return Err(error.into()),
        }
        if edit && known.is_none_or(|known| known.removed_at.is_some()) {
            append_event(connection, project, slug, now, "row_added", None, session, "agent", &json!({"row": id}))?;
        }
    }
    // `grid change` names the rows it removes, search rows too: those are
    // removed for good, not left to come back as missing.
    let removed_by_name = strings(&pending["removeRows"]);
    let removed_by_name: Vec<&str> = removed_by_name.iter().map(String::as_str).collect();
    for row in loaded.rows.iter().filter(|r| r.removed_at.is_none()) {
        if rows_wanted.iter().any(|wanted| wanted["id"] == row.id.as_str()) {
            continue;
        }
        if row.source == "manual" || removed_by_name.contains(&row.id.as_str()) {
            connection.execute(
                "UPDATE grid_row SET removed_at = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, row.id, now],
            )?;
        } else if row.missing_since.is_none() {
            connection.execute(
                "UPDATE grid_row SET missing_since = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, row.id, now],
            )?;
            append_event(connection, project, slug, now, "row_missing", None, session, "agent", &json!({"row": row.id}))?;
        }
    }
    let added = fill_cells(connection, project, slug)?;
    // A cell's own checks: the draft's list is the whole set.
    let mut changed_cells: Vec<(String, String)> = Vec::new();
    if let Some(given) = pending.get("cells").filter(|cells| cells.is_array()) {
        connection.execute("UPDATE grid_cell SET checks = NULL WHERE project_id = ?1 AND slug = ?2", params![project, slug])?;
        for cell in given.as_array().into_iter().flatten() {
            let own = json!({"checks": cell["checks"], "override": cell["override"].as_bool().unwrap_or(false)});
            connection.execute(
                "UPDATE grid_cell SET checks = ?5 WHERE project_id = ?1 AND slug = ?2 AND row = ?3 AND col = ?4",
                params![project, slug, cell["row"].as_str().unwrap_or(""), cell["col"].as_str().unwrap_or(""), own.to_string()],
            )?;
        }
        for cell in &loaded.cells {
            let now_own = given
                .as_array()
                .into_iter()
                .flatten()
                .find(|own| own["row"] == cell.row.as_str() && own["col"] == cell.col.as_str())
                .map(|own| json!({"checks": own["checks"], "override": own["override"].as_bool().unwrap_or(false)}));
            if cell.own_checks != now_own {
                changed_cells.push((cell.row.clone(), cell.col.clone()));
            }
        }
    }
    for cell in &loaded.cells {
        let own_override = cell.own_checks.as_ref().is_some_and(|own| own["override"] == true);
        if !own_override && rechecked.contains(&cell.col) && !changed_cells.iter().any(|(r, c)| *r == cell.row && *c == cell.col) {
            changed_cells.push((cell.row.clone(), cell.col.clone()));
        }
    }
    mark_checks_changed(connection, project, slug, &changed_cells, session, now)?;
    merge_hashes(&mut grid, hashes);

    grid.title = pending["title"].as_str().unwrap_or(&grid.title).to_string();
    grid.area = pending["area"].as_str().unwrap_or(&grid.area).to_string();
    grid.template = pending["template"].as_str().map(str::to_string);
    grid.row_search = pending["rowSearch"].clone();
    grid.status = "approved".into();
    grid.approved_at = grid.approved_at.or(Some(now));
    grid.updated_at = now;
    if pending["searched"].is_object() {
        grid.discovery = Some(json!({"at": pending["searched"]["at"], "head": pending["searched"]["head"], "ok": true,
            "added": [], "missing": [], "back": [], "skipped": []}));
    }
    grid.pending = None;
    save_grid(connection, &grid)?;
    let rows_n = rows_wanted.iter().filter(|row| row["kind"] != "reference").count();
    Ok((rows_n, cols_wanted.len(), added))
}

/// The check files' hashes from the chat's folder join the grid's.
fn merge_hashes(grid: &mut Grid, hashes: Option<&Value>) {
    let Some(source) = hashes.filter(|h| h["files"].is_object()) else { return };
    let mut merged = grid.hashes.clone().unwrap_or_else(|| json!({"files": {}}));
    if !merged["files"].is_object() {
        merged["files"] = json!({});
    }
    for (path, hash) in source["files"].as_object().into_iter().flatten() {
        merged["files"][path] = hash.clone();
    }
    grid.hashes = Some(merged);
}

/// Proved cells whose checks changed keep their proof, marked so: it reads
/// stale until the cell is proved, or re-checked, under the new checks. How
/// many were marked.
fn mark_checks_changed(connection: &Connection, project: &str, slug: &str, cells: &[(String, String)], session: Option<&str>, now: i64)
    -> Result<usize, TaskError> {
    let mut marked = 0;
    for (row, col) in cells {
        let changed = connection.execute(
            "UPDATE grid_cell SET checks_changed = 1
              WHERE project_id = ?1 AND slug = ?2 AND row = ?3 AND col = ?4 AND state = 'proved'",
            params![project, slug, row, col],
        )?;
        if changed > 0 {
            append_event(connection, project, slug, now, "checks_changed", Some((row, col)), session, "agent", &json!({}))?;
            marked += 1;
        }
    }
    Ok(marked)
}

fn stale_note(marked: usize) -> String {
    match marked {
        0 => String::new(),
        1 => " 1 proved cell is stale until it is proved again under the new checks.".into(),
        n => format!(" {n} proved cells are stale until they are proved again under the new checks."),
    }
}

/// `grid checks`: new check templates for some columns, live at once.
fn add_checks(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "checks")?;
    let project = request.project.as_str();
    let session = request.session.as_deref().unwrap_or_default();
    let mut grid = get_existing(connection, project, slug)?;
    let object = request
        .payload
        .as_object()
        .ok_or_else(|| TaskError::Refused("the payload must be an object: {columns: [{id, checks}]}".into()))?;
    if let Some(other) = object.keys().find(|key| key.as_str() != "columns") {
        return refuse(format!("{other} is not allowed: `grid checks` takes only columns[].checks; draft the grid again to change anything else"));
    }
    let given = object.get("columns").and_then(Value::as_array).filter(|items| !items.is_empty())
        .ok_or_else(|| TaskError::Refused("columns is required: [{id, checks}], one or more".into()))?;
    let loaded = load(connection, project, slug)?.expect("the grid was just read");
    let mut changed: Vec<(String, Vec<Value>)> = Vec::new();
    for (index, item) in given.iter().enumerate() {
        let here = format!("columns[{index}]");
        let column = item.as_object().ok_or_else(|| TaskError::Refused(format!("{here} must be an object: {{id, checks}}")))?;
        if let Some(other) = column.keys().find(|key| !["id", "checks"].contains(&key.as_str())) {
            return refuse(format!("{here}.{other} is not allowed: `grid checks` takes only id and checks for each column"));
        }
        let id = column.get("id").and_then(Value::as_str).unwrap_or("");
        if !loaded.columns.iter().any(|known| known.id == id && known.retired_at.is_none()) {
            return refuse(format!("{here}: \"{id}\" is not a column of grid \"{slug}\""));
        }
        if changed.iter().any(|(known, _)| known == id) {
            return refuse(format!("{here}: column \"{id}\" is given twice"));
        }
        let checks = match column.get("checks") {
            Some(Value::Array(items)) if !items.is_empty() => {
                check_templates(&Value::Array(items.clone()), &format!("{here}.checks"), Some(&format!("{slug}/{{row}}/{id}")))?
            }
            _ => return refuse(format!("{here}: column \"{id}\" needs one or more checks")),
        };
        changed.push((id.to_string(), checks));
    }
    let now = request.now;
    let marked = set_column_checks(connection, project, &mut grid, &changed, request.hashes.as_ref(), now)?;
    let ids: Vec<&str> = changed.iter().map(|(id, _)| id.as_str()).collect();
    append_event(connection, project, slug, now, "checks_set", None, Some(session), "agent", &json!({"columns": ids}))?;
    Ok(Outcome {
        slug: Some(slug.into()),
        summary: format!(
            "Set the checks of {} column(s) of grid \"{slug}\" ({}).{} Run `atelier grid next {slug}` for the cells to prove.",
            ids.len(),
            ids.join(", "),
            stale_note(marked)
        ),
        widget: Some("draft"),
        grids: vec![slug.into()],
        ..Default::default()
    })
}

/// New checks for some columns: the columns take them, the proved cells
/// that use them are marked stale, and the files' hashes join the grid's.
/// How many cells were marked.
fn set_column_checks(connection: &Connection, project: &str, grid: &mut Grid, checks: &[(String, Vec<Value>)], hashes: Option<&Value>, now: i64)
    -> Result<usize, TaskError> {
    let slug = grid.slug.clone();
    let loaded = load(connection, project, &slug)?.ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\"")))?;
    let mut rechecked: Vec<&str> = Vec::new();
    for (id, wanted) in checks {
        if loaded.columns.iter().any(|known| known.id == *id && known.checks != *wanted) {
            rechecked.push(id);
        }
        connection.execute(
            "UPDATE grid_column SET checks = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
            params![project, slug, id, Value::Array(wanted.clone()).to_string()],
        )?;
    }
    let cells: Vec<(String, String)> = loaded
        .cells
        .iter()
        .filter(|cell| rechecked.contains(&cell.col.as_str()))
        .filter(|cell| !cell.own_checks.as_ref().is_some_and(|own| own["override"] == true))
        .map(|cell| (cell.row.clone(), cell.col.clone()))
        .collect();
    let marked = mark_checks_changed(connection, project, &slug, &cells, None, now)?;
    merge_hashes(grid, hashes);
    grid.pending = None;
    grid.updated_at = now;
    save_grid(connection, grid)?;
    Ok(marked)
}

/// `grid change`: add or remove a few rows and columns of a grid by naming
/// only the change. Applied at once; kept cells keep their proofs.
fn change(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    const SHAPE: &str = "{addColumns?: [{id, name, proof_rule?, checks?, after?}], removeColumns?: [id], addRows?: [{id, name, paths?}], removeRows?: [id]}";
    let slug = need(&request.slug, "slug", "change")?;
    let project = request.project.as_str();
    let session = request.session.as_deref().unwrap_or_default();
    let grid = get_existing(connection, project, slug)?;
    let object = request.payload.as_object().ok_or_else(|| TaskError::Refused(format!("the payload must be an object: {SHAPE}")))?;
    const FIELDS: &[&str] = &["addColumns", "removeColumns", "addRows", "removeRows"];
    if let Some(other) = object.keys().find(|key| !FIELDS.contains(&key.as_str())) {
        return refuse(format!("{other} is not allowed (allowed: {}): {SHAPE}", FIELDS.join(", ")));
    }
    let list = |key: &str| -> Result<Vec<Value>, TaskError> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => Ok(items.clone()),
            Some(_) => refuse(format!("{key} must be a list: {SHAPE}")),
        }
    };
    let (add_columns, remove_columns, add_rows, remove_rows) = (list("addColumns")?, list("removeColumns")?, list("addRows")?, list("removeRows")?);
    if add_columns.is_empty() && remove_columns.is_empty() && add_rows.is_empty() && remove_rows.is_empty() {
        return refuse(format!("nothing to change: give addColumns, removeColumns, addRows or removeRows: {SHAPE}"));
    }
    let loaded = load(connection, project, slug)?.expect("the grid was just read");

    let mut live: Vec<&Column> = loaded.columns.iter().filter(|c| c.retired_at.is_none()).collect();
    live.sort_by_key(|c| c.position);
    let mut columns: Vec<Value> = live
        .iter()
        .map(|c| json!({"id": c.id, "name": c.name, "proofRule": c.proof_rule, "fromTemplate": c.from_template, "checks": c.checks}))
        .collect();
    for (index, id) in remove_columns.iter().enumerate() {
        let id = id.as_str().unwrap_or("");
        let Some(at) = columns.iter().position(|c| c["id"] == id) else {
            return refuse(format!("removeColumns[{index}]: \"{id}\" is not a column of grid \"{slug}\""));
        };
        columns.remove(at);
    }
    for (index, item) in add_columns.iter().enumerate() {
        let here = format!("addColumns[{index}]");
        let mut item = item.clone();
        let after = match item.as_object_mut().and_then(|o| o.remove("after")) {
            None | Some(Value::Null) => None,
            Some(Value::String(after)) => Some(after),
            Some(_) => return refuse(format!("{here}.after must be a column id")),
        };
        if item.is_object() && item.get("proof_rule").is_none() {
            item["proof_rule"] = json!("its checks pass");
        }
        let checked = check_columns(Some(&json!([item])), &here, Some(slug))?.remove(0);
        let id = checked["id"].as_str().unwrap_or("");
        if columns.iter().any(|c| c["id"] == id) {
            return refuse(format!("{here}: \"{id}\" is already a column of grid \"{slug}\""));
        }
        let at = match &after {
            None => columns.len(),
            Some(after) => columns.iter().position(|c| c["id"] == after.as_str()).map(|at| at + 1).ok_or_else(|| {
                TaskError::Refused(format!("{here}.after: \"{after}\" is not a column of grid \"{slug}\""))
            })?,
        };
        columns.insert(at, json!({"id": id, "name": checked["name"], "proofRule": checked["proof_rule"], "fromTemplate": false,
            "checks": checked.get("checks").cloned().unwrap_or_else(|| json!([]))}));
    }
    if columns.is_empty() {
        return refuse(format!("the change leaves grid \"{slug}\" with no columns"));
    }
    if columns.len() > MAX_COLUMNS {
        return refuse(format!("the change gives grid \"{slug}\" {} columns; a grid has at most {MAX_COLUMNS}", columns.len()));
    }

    let mut rows: Vec<Value> = loaded
        .rows
        .iter()
        .filter(|row| row.removed_at.is_none())
        .map(|row| json!({"id": row.id, "name": row.name, "kind": row.kind, "paths": row.paths, "of": row.of,
            "ref": row.reference.clone().unwrap_or(Value::Null), "source": row.source}))
        .collect();
    let mut removed = Vec::new();
    for (index, id) in remove_rows.iter().enumerate() {
        let id = id.as_str().unwrap_or("");
        let Some(at) = rows.iter().position(|r| r["id"] == id) else {
            return refuse(format!("removeRows[{index}]: \"{id}\" is not a row of grid \"{slug}\""));
        };
        rows.remove(at);
        removed.push(id.to_string());
    }
    for (index, item) in add_rows.iter().enumerate() {
        let row = check_manual_row(item, index).map_err(|e| at_field(e, "addRows"))?;
        let id = row["id"].as_str().unwrap_or("");
        if rows.iter().any(|r| r["id"] == id) {
            return refuse(format!("addRows[{index}]: \"{id}\" is already a row of grid \"{slug}\""));
        }
        rows.push(row);
    }
    check_rows(connection, project, slug, &rows)?;

    let now = request.now;
    let pending = json!({
        "title": grid.title, "area": grid.area, "template": grid.template, "rowSearch": grid.row_search,
        "columns": columns, "rows": rows, "removeRows": removed, "draftedBy": session,
    });
    let (rows_n, cols_n, _) = apply_pending(connection, project, grid, &pending, request.hashes.as_ref(), now)?;
    append_event(connection, project, slug, now, "changed", None, Some(session), "agent", &json!({"rows": rows_n, "columns": cols_n}))?;
    Ok(Outcome {
        slug: Some(slug.into()),
        summary: format!("Changed grid \"{slug}\" (now {rows_n} rows × {cols_n} columns); kept cells keep their proofs."),
        widget: Some("draft"),
        grids: vec![slug.into()],
        ..Default::default()
    })
}

/// Give every pair of a live feature or combination row and a live column an
/// `unchecked` cell, where it has none. How many were added.
fn fill_cells(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<usize> {
    connection.execute(
        "INSERT OR IGNORE INTO grid_cell (project_id, slug, row, col, state)
         SELECT r.project_id, r.slug, r.id, c.id, 'unchecked' FROM grid_row r JOIN grid_column c
           ON c.project_id = r.project_id AND c.slug = r.slug
          WHERE r.project_id = ?1 AND r.slug = ?2 AND r.kind <> 'reference' AND r.removed_at IS NULL
            AND c.retired_at IS NULL",
        params![project, slug],
    )
    .and_then(|added| refresh_steps(connection, "project_id = ?1 AND slug = ?2 AND step IS NULL", params![project, slug]).map(|_| added))
}

/* ----------------------------------------------------------- discovery */

fn discover(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "discover")?;
    let project = request.project.as_str();
    let mut grid = get_existing(connection, project, slug)?;
    let now = request.now;
    let actor = if request.actor == "app" { "owner" } else { request.actor.as_str() };
    let session = request.session.as_deref();
    let run = match &request.search {
        Some(Ok(run)) => run,
        Some(Err(error)) => {
            grid.discovery = Some(json!({"at": now, "head": request.head, "ok": false, "added": [], "missing": [],
                "back": [], "skipped": [], "error": error}));
            grid.updated_at = now;
            save_grid(connection, &grid)?;
            append_event(connection, project, slug, now, "discovered", None, session, actor, &json!({"ok": false, "error": error}))?;
            return Ok(Outcome {
                slug: Some(slug.into()),
                summary: format!("The row search for \"{slug}\" failed; nothing changed: {error}"),
                failed: Some(format!("the row search failed; nothing changed: {error}")),
                widget: Some("discover"),
                grids: vec![slug.into()],
                ..Default::default()
            });
        }
        None => return refuse("the row search was not run"),
    };
    let head = run.head.clone().or_else(|| request.head.clone());

    if grid.status == "draft" {
        let mut pending = grid.pending.clone().unwrap_or_else(|| json!({"rows": []}));
        let manual: Vec<Value> =
            pending["rows"].as_array().into_iter().flatten().filter(|row| row["source"] == "manual").cloned().collect();
        let before: HashSet<String> = pending["rows"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["source"] == "search")
            .filter_map(|row| row["id"].as_str().map(str::to_string))
            .collect();
        let mut rows: Vec<Value> = run.rows.iter().map(search::Found::to_json).collect();
        let clash = manual.iter().find(|row| rows.iter().any(|found| found["id"] == row["id"]));
        let error = clash.map(|row| format!("the search now prints \"{}\", which is also a manual row", row["id"].as_str().unwrap_or("")));
        let checked = match &error {
            Some(_) => Ok(()),
            None => {
                rows.extend(manual.iter().cloned());
                check_rows(connection, project, slug, &rows)
            }
        };
        let error = error.or_else(|| checked.err().map(|e| e.message().to_string()));
        if let Some(error) = error {
            grid.discovery = Some(json!({"at": now, "head": head, "ok": false, "added": [], "missing": [], "back": [], "skipped": [], "error": error}));
            save_grid(connection, &grid)?;
            return Ok(Outcome {
                slug: Some(slug.into()),
                summary: format!("Discovery for \"{slug}\" changed nothing: {error}"),
                failed: Some(error),
                widget: Some("discover"),
                grids: vec![slug.into()],
                ..Default::default()
            });
        }
        let added: Vec<&str> = run.rows.iter().map(|r| r.id.as_str()).filter(|id| !before.contains(*id)).collect();
        let missing: Vec<&String> = before.iter().filter(|id| !run.rows.iter().any(|r| &r.id == *id)).collect();
        pending["rows"] = Value::Array(rows);
        grid.discovery = Some(json!({"at": now, "head": head, "ok": true, "added": added, "missing": missing, "back": [], "skipped": []}));
        grid.pending = Some(pending);
        grid.updated_at = now;
        save_grid(connection, &grid)?;
        append_event(connection, project, slug, now, "discovered", None, session, actor,
            &json!({"ok": true, "added": added.len(), "missing": missing.len()}))?;
        return Ok(Outcome {
            slug: Some(slug.into()),
            summary: format!("Discovery refreshed the draft of \"{slug}\": {} added, {} gone.", added.len(), missing.len()),
            widget: Some("discover"),
            grids: vec![slug.into()],
            ..Default::default()
        });
    }

    let loaded = load(connection, project, slug)?.expect("the grid was just read");
    let (mut added, mut missing, mut back, mut skipped) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for found in &run.rows {
        match loaded.row(&found.id) {
            Some(known) if known.source == "search" && known.removed_at.is_none() => {
                if known.name != found.name || known.paths != found.paths || known.kind != found.kind || known.of != found.of {
                    connection.execute(
                        "UPDATE grid_row SET name = ?4, paths = ?5, kind = ?6, of = ?7 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                        params![project, slug, found.id, found.name, json!(found.paths).to_string(), found.kind, json!(found.of).to_string()],
                    )?;
                }
                if known.missing_since.is_some() {
                    connection.execute(
                        "UPDATE grid_row SET missing_since = NULL WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                        params![project, slug, found.id],
                    )?;
                    append_event(connection, project, slug, now, "row_back", None, session, actor, &json!({"row": found.id}))?;
                    back.push(found.id.clone());
                }
            }
            // Manual and reference rows, and rows an edit removed, are the
            // owner's: the search does not touch them.
            Some(_) => {}
            None => {
                if let Some(owner) = owner_of(connection, project, &found.id, slug)? {
                    skipped.push(json!({"id": found.id, "owner": owner}));
                    continue;
                }
                connection.execute(
                    "INSERT INTO grid_row (project_id, slug, id, name, kind, paths, of, ref, source, added_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 'search', ?8)",
                    params![project, slug, found.id, found.name, found.kind, json!(found.paths).to_string(),
                        json!(found.of).to_string(), now],
                )?;
                append_event(connection, project, slug, now, "row_added", None, session, actor, &json!({"row": found.id}))?;
                added.push(found.id.clone());
            }
        }
    }
    for row in loaded.rows.iter().filter(|r| r.source == "search" && r.removed_at.is_none() && r.missing_since.is_none()) {
        if !run.rows.iter().any(|found| found.id == row.id) {
            connection.execute(
                "UPDATE grid_row SET missing_since = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, row.id, now],
            )?;
            append_event(connection, project, slug, now, "row_missing", None, session, actor, &json!({"row": row.id}))?;
            missing.push(row.id.clone());
        }
    }
    fill_cells(connection, project, slug)?;
    grid.discovery = Some(json!({"at": now, "head": head, "ok": true, "added": added, "missing": missing, "back": back, "skipped": skipped}));
    grid.updated_at = now;
    save_grid(connection, &grid)?;
    append_event(connection, project, slug, now, "discovered", None, session, actor,
        &json!({"ok": true, "added": added.len(), "missing": missing.len(), "back": back.len(), "skipped": skipped.len()}))?;
    let mut summary = format!(
        "Discovery for \"{slug}\": {} added, {} missing, {} back",
        added.len(),
        missing.len(),
        back.len()
    );
    if !skipped.is_empty() {
        summary.push_str(&format!(
            "; skipped {} owned by other grids ({})",
            skipped.len(),
            skipped.iter().map(|s| format!("{} → {}", s["id"].as_str().unwrap_or(""), s["owner"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", ")
        ));
    }
    summary.push('.');
    Ok(Outcome { slug: Some(slug.into()), summary, widget: Some("discover"), grids: vec![slug.into()], ..Default::default() })
}

/* --------------------------------------------------------------- cells */

/// A cell that a proof, a re-check or an answer is about: it must be one of
/// a live row's cells in a live column of the grid.
fn live_cell(connection: &Connection, request: &Request, action: &str) -> Result<(Loaded, Cell), TaskError> {
    let slug = need(&request.slug, "slug", action)?;
    let row = need(&request.row, "row", action)?;
    let col = need(&request.col, "col", action)?;
    find_live_cell(connection, &request.project, slug, row, col)
}

fn find_live_cell(connection: &Connection, project: &str, slug: &str, row: &str, col: &str) -> Result<(Loaded, Cell), TaskError> {
    let loaded = load(connection, project, slug)?
        .filter(|loaded| loaded.grid.status != "discarded")
        .ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\" in this project")))?;
    let at = format!("{slug}.{row}.{col}");
    let found = loaded.row(row).ok_or_else(|| TaskError::Refused(format!("{at}: grid \"{slug}\" has no row \"{row}\"")))?;
    if found.kind == "reference" {
        let owner = &found.reference;
        return refuse(format!(
            "{at}: \"{row}\" is a reference row; its cells belong to {}.{}",
            owner.as_ref().and_then(|r| r["grid"].as_str()).unwrap_or("?"),
            owner.as_ref().and_then(|r| r["row"].as_str()).unwrap_or("?")
        ));
    }
    if found.removed_at.is_some() {
        return refuse(format!("{at}: row \"{row}\" was removed from the grid"));
    }
    if found.missing_since.is_some() {
        return refuse(format!("{at}: row \"{row}\" is missing: the row search no longer prints it"));
    }
    let column = loaded.column(col).ok_or_else(|| TaskError::Refused(format!("{at}: grid \"{slug}\" has no column \"{col}\"")))?;
    if column.retired_at.is_some() {
        return refuse(format!("{at}: column \"{col}\" is retired"));
    }
    let cell = loaded.cell(row, col).cloned().ok_or_else(|| TaskError::Refused(format!("{at} has no cell")))?;
    Ok((loaded, cell))
}

/// What `prove` checks before its checks are run: the cell, its step and
/// checks, and the proof's shape. The paths the row covers. Any chat may
/// prove any cell; no task has to hold it.
pub fn prove_precheck(connection: &Connection, request: &Request) -> Result<(proof::Proof, Vec<String>), TaskError> {
    request.session.as_deref().ok_or_else(|| TaskError::Refused("session is required for prove".into()))?;
    let (loaded, cell) = live_cell(connection, request, "prove")?;
    let at = format!("{}.{}.{}", loaded.grid.slug, cell.row, cell.col);
    if cell.state == "na" {
        return refuse(format!("{at} is N/A; a cell marked N/A is not proved. Reopen it first with `atelier grid reopen`"));
    }
    if matches!(cell.step.as_str(), "order" | "cases") {
        return refuse(format!(
            "{at} is at step {}; prove needs its order and reviewed cases first. Next: `{}`",
            cell.step,
            cell.next.clone().unwrap_or_else(|| format!("atelier grid next {}", loaded.grid.slug))
        ));
    }
    // A cell proved before it had cases keeps that proof, but is proved
    // again only once its cases are reviewed.
    if cases::needs_cases(&cell) {
        return refuse(format!(
            "{at}: Needs cases. It is proved again only after its cases are reviewed. Step {}; next `atelier grid cases {} {} {}`",
            cell.step, loaded.grid.slug, cell.row, cell.col
        ));
    }
    if let Some(why) = unmet_prerequisites(connection, &request.project, &loaded.grid.slug, &cell.row, &cell.col, &Prints::new())? {
        return refuse(why);
    }
    let checks = loaded.cell_checks(&cell.row, &cell.col);
    if checks.is_empty() {
        return refuse(format!("{at} has no checks, so nothing proves it. Add them with `atelier grid checks {}`", loaded.grid.slug));
    }
    if request.payload.get("checks").is_some_and(|checks| !checks.is_null()) {
        return refuse(format!("{at} has its checks, so prove runs those and takes no checks: give {{summary, commits?, tests?, evidence?}}"));
    }
    let mut payload = request.payload.clone();
    if let Some(row) = payload.as_object_mut() {
        row.insert("checks".into(), json!(checks.iter().map(as_proof_check).collect::<Vec<_>>()));
    }
    Ok((proof::check_proof(&payload)?, loaded.covered(&cell.row)))
}

/// An approved cell check in the shape a proof stores: `{name, command, timeout_s}`.
fn as_proof_check(check: &Value) -> Value {
    json!({"name": check["name"], "command": check["command"],
        "timeout_s": check["timeout_s"].as_u64().unwrap_or(proof::CHECK_TIMEOUT_S)})
}

/// The approved checks of the cell a prove or verify request names (none for
/// a cell from before checks), and the grid's locked hashes.
pub fn approved_for(connection: &Connection, request: &Request) -> Result<(Vec<Value>, Option<Value>), TaskError> {
    let (loaded, cell) = live_cell(connection, request, &request.action)?;
    Ok((loaded.cell_checks(&cell.row, &cell.col), loaded.grid.hashes.clone()))
}

/// The check files' hashes, `{files: {path: sha}}`, taken in the folder the
/// grid was just changed from, join the grid's.
pub fn set_hashes(connection: &Connection, project: &str, slug: &str, hashes: &Value) -> Result<(), TaskError> {
    let mut grid = get_existing(connection, project, slug)?;
    merge_hashes(&mut grid, Some(hashes));
    save_grid(connection, &grid)?;
    Ok(())
}

/// Every file a check on the grid names, filled in for its row.
pub fn owned_check_files(loaded: &Loaded) -> Vec<String> {
    let mut owned = Vec::new();
    for row in &loaded.rows {
        for column in &loaded.columns {
            for check in loaded.cell_checks(&row.id, &column.id) {
                for path in check["files"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                    if !owned.iter().any(|known| known == path) {
                        owned.push(path.to_string());
                    }
                }
            }
        }
    }
    owned
}

/// The approved check files of a cell, and the helpers beside them, whose
/// hash in `current` differs from the one stored at approval.
fn changed_check_files(approved: &[Value], owned: &[String], locked: Option<&Value>, current: Option<&Value>) -> Vec<String> {
    let (Some(locked), Some(current)) = (locked, current) else { return Vec::new() };
    use crate::workbench::tasks::checks::test_folder;
    let named: Vec<&str> = approved.iter().flat_map(|check| check["files"].as_array().into_iter().flatten().filter_map(Value::as_str)).collect();
    // A check file in a test folder locks that whole folder: helpers,
    // fixtures and baselines beside it count as its own.
    let roots: Vec<String> = named.iter().filter_map(|path| test_folder(path)).collect();
    let beside = locked["files"].as_object().into_iter().flatten().map(|(path, _)| path.as_str())
        .filter(|path| roots.iter().any(|root| path.starts_with(&format!("{root}/"))))
        // Another check's own file is that check's business.
        .filter(|path| !owned.iter().any(|own| own == path));
    let mut changed = Vec::new();
    {
        for path in named.iter().copied().chain(beside) {
            let Some(then) = locked["files"][path].as_str() else { continue };
            let now = current["files"][path].as_str().unwrap_or(crate::workbench::tasks::checks::MISSING);
            if now != then && !changed.iter().any(|known| known == path) {
                changed.push(path.to_string());
            }
        }
    }
    changed
}

fn prove(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let (checked, _) = prove_precheck(connection, request)?;
    let session = request.session.as_deref().unwrap_or_default();
    let (loaded, mut cell) = live_cell(connection, request, "prove")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    let folder = request.cwd.as_deref().unwrap_or("this chat's folder");
    let approved = loaded.cell_checks(&cell.row, &cell.col);
    let owned = owned_check_files(&loaded);
    // Nothing is locked: a changed check file is recorded on the proof for
    // the owner to review.
    let changed = changed_check_files(&approved, &owned, loaded.grid.hashes.as_ref(), request.hashes.as_ref());
    if !request.dirty.is_empty() {
        return refuse(format!(
            "commit the covered code first: {} uncommitted in {folder}. A proof describes committed code",
            request.dirty.join(", ")
        ));
    }
    if let Some(sha) = checked.commits.iter().find(|sha| request.missing_commits.contains(*sha)) {
        return refuse(format!("commits has \"{sha}\", which is not a commit in this chat's repository ({folder}); commit the work first"));
    }
    if request.checks.len() != checked.checks.len() {
        return refuse("the checks were not run");
    }
    // A case check's output carries exactly one CASE line with its id.
    for check in &approved {
        let Ok(parsed) = crate::workbench::tasks::checks::parse_check(check, "check") else { continue };
        let Some(result) = request.checks.iter().find(|result| result.name == parsed.name) else { continue };
        match crate::workbench::tasks::checks::case_verdict(&parsed, &result.tail) {
            Some(Err(why)) => return refuse(format!("check \"{}\" is {why}. {at} is not proved", parsed.name)),
            Some(Ok(line)) if !line.pass => {
                return refuse(format!("check \"{}\" failed: its CASE line says FAIL {} {}. {at} is not proved", parsed.name, line.measured, line.limit))
            }
            _ => {}
        }
    }
    if let Some(failed) = request.checks.iter().find(|result| !result.passed()) {
        return refuse(format!(
            "check \"{}\" failed (exit {}), so {at} is not proved. Its last lines:\n{}",
            failed.name, failed.exit, failed.tail
        ));
    }
    let fingerprint = request
        .fingerprint
        .clone()
        .ok_or_else(|| TaskError::Refused(format!("git could not fingerprint the covered code in {folder}; is it a repository with a commit?")))?;
    let now = request.now;
    cell.state = "proved".into();
    let mut value = checked.value.clone();
    if !changed.is_empty() {
        value["changedCheckFiles"] = json!(changed);
    }
    cell.proof = Some(value);
    cell.fingerprint = Some(fingerprint);
    cell.proved_by = Some(session.to_string());
    cell.proved_at = Some(now);
    cell.last_check = Some(json!({"at": now, "head": request.head, "passed": true,
        "results": request.checks.iter().map(proof::CheckResult::to_json).collect::<Vec<_>>()}));
    cell.reason = None;
    cell.audited_at = None;
    cell.audited_by = None;
    cell.checks_changed = false;
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, now, "proved", Some((&cell.row, &cell.col)), Some(session), "agent",
        &json!({"summary": checked.value["summary"], "head": request.head}))?;
    let moved = get_cell(connection, &request.project, &slug, &cell.row, &cell.col)?.unwrap_or(cell.clone());
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary: format!(
            "{at} is proved: {} check{} passed.\n{}",
            request.checks.len(),
            if request.checks.len() == 1 { "" } else { "s" },
            step_line(&slug, &moved)
        ),
        widget: Some("prove"),
        grids: vec![slug],
        ..Default::default()
    })
}

/// The cells `verify` runs: one, or every proved cell of the grid (only the
/// stale ones with `stale_only`).
pub fn verify_targets(loaded: &Loaded, prints: &Prints, stale_only: bool) -> Vec<(String, String)> {
    let live: HashSet<(String, String)> = live_cells(loaded).map(|c| (c.row.clone(), c.col.clone())).collect();
    let mut cells: Vec<&Cell> = loaded
        .cells
        .iter()
        .filter(|cell| cell.state == "proved" && cell.proof.is_some() && live.contains(&(cell.row.clone(), cell.col.clone())))
        .filter(|cell| !stale_only || is_stale(&loaded.grid.slug, cell, prints))
        .collect();
    cells.sort_by_key(|cell| !is_stale(&loaded.grid.slug, cell, prints));
    cells.into_iter().map(|cell| (cell.row.clone(), cell.col.clone())).collect()
}

fn verify(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let (loaded, mut cell) = live_cell(connection, request, "verify")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    if cell.state != "proved" || cell.proof.is_none() {
        return refuse(format!("{at} is {}; only a proved cell is re-checked", cell.state.replace('_', " ")));
    }
    let now = request.now;
    let stale = is_stale(&slug, &cell, &request.prints);
    let results: Vec<Value> = request.checks.iter().map(proof::CheckResult::to_json).collect();
    let failed = request.checks.iter().find(|result| !result.passed());
    let passed = failed.is_none() && !request.checks.is_empty();
    cell.last_check = Some(json!({"at": now, "head": request.head, "passed": passed, "results": results}));
    let session = request.session.as_deref();
    let actor = request.actor.as_str();
    let (summary, failure) = if passed {
        // A passing re-check proves the cell under its checks as they are.
        let freshened = stale && (request.fingerprint.is_some() || cell.checks_changed);
        if stale && request.fingerprint.is_some() {
            cell.fingerprint = request.fingerprint.clone();
        }
        cell.checks_changed = false;
        append_event(connection, &request.project, &slug, now, "check_passed", Some((&cell.row, &cell.col)), session, actor,
            &json!({"head": request.head, "freshened": freshened}))?;
        (format!("{at}: every check passed{}.", if freshened { "; the proof is fresh again" } else { "" }), None)
    } else {
        let (name, exit) = failed.map(|f| (f.name.clone(), f.exit)).unwrap_or_else(|| ("(none)".into(), -1));
        let reason = format!("check \"{name}\" failed on re-check (exit {exit})");
        cell.state = "gap".into();
        cell.reason = Some(reason.clone());
        append_event(connection, &request.project, &slug, now, "check_failed", Some((&cell.row, &cell.col)), session, actor,
            &json!({"head": request.head, "check": name, "exit": exit}))?;
        (format!("{at}: {reason}; the cell is a gap again."), Some(reason))
    };
    save_cell(connection, &request.project, &slug, &cell)?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary,
        failed: failure,
        grids: vec![slug],
        ..Default::default()
    })
}

/// `grid na`: the requirement does not apply to this feature. Set at once.
fn ask_na(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let (loaded, mut cell) = live_cell(connection, request, "na")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    if !matches!(cell.state.as_str(), "unchecked" | "gap") {
        return refuse(format!("{at} is {}; only an unchecked or gap cell is marked N/A", cell.state.replace('_', " ")));
    }
    let reason = payload_text(&request.payload, "reason", "why this requirement does not apply to this feature (--reason)", 600)?;
    cell.state = "na".into();
    cell.reason = Some(reason.to_string());
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, request.now, "na_set", Some((&cell.row, &cell.col)), Some(session), "agent",
        &json!({"reason": reason}))?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary: format!("{at} is N/A: {reason}. It no longer counts; `atelier grid reopen` undoes it."),
        widget: Some("na"),
        grids: vec![slug],
        ..Default::default()
    })
}

/// An agent's audit verdict never comes from the chat that proved the cell.
fn audit_gate(session: &str, cell: Option<&Cell>, at: &str) -> Result<(), TaskError> {
    if let Some(cell) = cell {
        if cell.proved_by.as_deref() == Some(session) {
            return refuse(format!("{at} was proved by this chat; an audit verdict must come from a chat that did not prove it"));
        }
    }
    Ok(())
}

fn reopen(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let (loaded, mut cell) = live_cell(connection, request, "reopen")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    let reason = payload_text(&request.payload, "reason", "why the cell is not met (--reason)", 600)?.to_string();
    let agent = request.actor == "agent";
    let session = request.session.as_deref();
    if !matches!(cell.state.as_str(), "proved" | "na") {
        return refuse(format!("{at} is {}; only a proved or N/A cell can be reopened", cell.state.replace('_', " ")));
    }
    let was = cell.state.clone();
    cell.state = "gap".into();
    cell.reason = Some(reason.clone());
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, request.now, "reopened", Some((&cell.row, &cell.col)), session,
        &request.actor, &json!({"reason": reason, "from": was, "audit": agent}))?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary: format!("{at} is reopened as a gap: {reason}"),
        widget: agent.then_some("reopen"),
        grids: vec![slug],
        ..Default::default()
    })
}

fn pass(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let (loaded, mut cell) = live_cell(connection, request, "pass")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    if cell.state != "proved" {
        return refuse(format!("{at} is {}; an audit passes a proved cell", cell.state.replace('_', " ")));
    }
    audit_gate(session, Some(&cell), &at)?;
    if is_stale(&slug, &cell, &request.prints) {
        return refuse(format!("{at} is stale: its covered code changed since it was proved. Re-check or re-prove first"));
    }
    let note = match request.payload.get("note") {
        Some(Value::String(note)) => note.trim().to_string(),
        _ => String::new(),
    };
    cell.audited_at = Some(request.now);
    cell.audited_by = Some(session.to_string());
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, request.now, "audit_passed", Some((&cell.row, &cell.col)), Some(session), "agent",
        &json!({"note": note}))?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary: format!("{at} passed the audit."),
        widget: Some("pass"),
        grids: vec![slug],
        ..Default::default()
    })
}

/// A note on the grid, a row, a column or a cell, from the owner or any
/// agent, at any time. Whoever works on a cell later sees the notes that
/// cover it.
fn note(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "note")?;
    let text = match request.payload.get("text") {
        Some(Value::String(text)) if !text.trim().is_empty() => text.trim().to_string(),
        Some(Value::String(_)) | Some(Value::Null) | None => return refuse("text is required: what the note says"),
        Some(_) => return refuse("text must be text: what the note says"),
    };
    let count = text.chars().count();
    if count > NOTE_MAX {
        return refuse(format!("text is {count} characters; at most {NOTE_MAX}"));
    }
    let loaded = load(connection, &request.project, slug)?
        .filter(|loaded| loaded.grid.status != "discarded")
        .ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\" in this project; run `atelier grid list`")))?;
    if let Some(row) = request.row.as_deref() {
        if loaded.row(row).is_none() {
            return refuse(format!("grid \"{slug}\" has no row \"{row}\"; run `atelier grid show {slug}`"));
        }
    }
    if let Some(col) = request.col.as_deref() {
        if loaded.column(col).is_none() {
            return refuse(format!("grid \"{slug}\" has no column \"{col}\"; run `atelier grid show {slug}`"));
        }
    }
    let (row, col) = (request.row.as_deref(), request.col.as_deref());
    connection.execute(
        "INSERT INTO grid_event (project_id, slug, seq, at, kind, row, col, session_id, actor, payload)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM grid_event WHERE project_id = ?1 AND slug = ?2),
                 ?3, 'note', ?4, ?5, ?6, ?7, ?8)",
        params![request.project, slug, request.now, row, col, request.session, request.actor, json!({"text": text}).to_string()],
    )?;
    let place = match (row, col) {
        (Some(row), Some(col)) => format!("{slug}.{row}.{col}"),
        (Some(row), None) => format!("row {row} of {slug}"),
        (None, Some(col)) => format!("column {col} of {slug}"),
        (None, None) => format!("grid {slug}"),
    };
    Ok(Outcome {
        slug: Some(slug.to_string()),
        cell: row.zip(col).map(|(row, col)| (row.to_string(), col.to_string())),
        summary: format!("Note added to {place}."),
        grids: vec![slug.to_string()],
        ..Default::default()
    })
}

pub const NOTE_MAX: usize = 4000;

/// `atelier grid order`: what rows and columns come after. A column's
/// `after` holds back its cell in each row until that row's cells in the
/// named columns are proved or N/A; a row's `after` does the same down each
/// column. Each id given replaces its list; ids not given keep theirs.
fn order(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "order")?;
    let loaded = live_grid(connection, &request.project, slug)?;
    const SHAPE: &str = "order takes {rows: [{id, after: [ROW…], reason}], columns: [{id, after: [COLUMN…], reason}], \
        cells?: [{row, col, after: [[ROW, COL]…], reason}]}: every row and every column, in the order cells are handed out";
    let object = request.payload.as_object().ok_or(TaskError::Refused(SHAPE.into()))?;
    if let Some(unknown) = object.keys().find(|key| !["rows", "columns", "cells"].contains(&key.as_str())) {
        return refuse(format!("order takes only rows, columns and cells, not \"{unknown}\"; {SHAPE}"));
    }
    // A reason says why: at least three words.
    let reason_of = |item: &Value, what: &str| -> Result<String, TaskError> {
        match item.get("reason").and_then(Value::as_str).map(str::trim) {
            Some(text) if text.split_whitespace().count() >= 3 => Ok(text.to_string()),
            _ => refuse(format!("{what} needs a reason: a sentence of at least three words saying why it comes where it does; nothing changed")),
        }
    };
    let live_rows: Vec<&str> = loaded.rows.iter().filter(|row| row.counts()).map(|row| row.id.as_str()).collect();
    let live_cols: Vec<&str> = loaded.columns.iter().filter(|col| col.retired_at.is_none()).map(|col| col.id.as_str()).collect();
    // Each list in its written order: (id, after, reason).
    let mut written: [Vec<(String, Vec<String>, String)>; 2] = [Vec::new(), Vec::new()];
    for ((key, noun, live), list) in [("rows", "row", &live_rows), ("columns", "column", &live_cols)].into_iter().zip(written.iter_mut()) {
        let items = object.get(key).and_then(Value::as_array)
            .ok_or_else(|| TaskError::Refused(format!("the order must list every {noun} under \"{key}\"; {SHAPE}")))?;
        for item in items {
            let id = item.get("id").and_then(Value::as_str).ok_or_else(|| TaskError::Refused(SHAPE.into()))?;
            if !live.contains(&id) {
                return refuse(format!("grid \"{slug}\" has no {noun} \"{id}\"; run `atelier grid show {slug}`"));
            }
            if list.iter().any(|(seen, _, _)| seen == id) {
                return refuse(format!("{noun} \"{id}\" is listed twice; list each {noun} once; nothing changed"));
            }
            let mut ids: Vec<String> = Vec::new();
            for other in item.get("after").and_then(Value::as_array).into_iter().flatten() {
                let other = other.as_str().ok_or_else(|| TaskError::Refused(format!("{noun} \"{id}\": after must list {noun} ids")))?;
                if !live.contains(&other) {
                    return refuse(format!("{noun} \"{id}\" comes after \"{other}\", but grid \"{slug}\" has no {noun} \"{other}\""));
                }
                if !list.iter().any(|(seen, _, _)| seen == other) {
                    return refuse(format!(
                        "{noun} \"{id}\" comes after \"{other}\", but \"{other}\" is not earlier in the list. \
                         A {noun} may only come after {noun}s listed earlier; move \"{other}\" up; nothing changed"
                    ));
                }
                if !ids.iter().any(|seen| seen == other) {
                    ids.push(other.to_string());
                }
            }
            let reason = reason_of(item, &format!("{noun} \"{id}\""))?;
            list.push((id.to_string(), ids, reason));
        }
        let missing: Vec<&str> = live.iter().copied().filter(|id| !list.iter().any(|(seen, _, _)| seen == id)).collect();
        if !missing.is_empty() {
            return refuse(format!("the order must list every {noun}; missing: {}; nothing changed", missing.join(", ")));
        }
    }
    let [rows_written, cols_written] = written;
    let row_after: BTreeMap<String, Vec<String>> = rows_written.iter().map(|(id, after, _)| (id.clone(), after.clone())).collect();
    let col_after: BTreeMap<String, Vec<String>> = cols_written.iter().map(|(id, after, _)| (id.clone(), after.clone())).collect();
    // A cell may wait for named cells in any row.
    let pairs = live_pairs(&loaded);
    let live: Vec<(String, String)> = pairs.iter().map(|(row, col, _)| (row.id.clone(), col.id.clone())).collect();
    let mut cell_after: BTreeMap<(String, String), Vec<(String, String)>> =
        pairs.iter().map(|(row, col, cell)| ((row.id.clone(), col.id.clone()), cell.waits_on())).collect();
    let mut cell_reason: BTreeMap<(String, String), String> = BTreeMap::new();
    if let Some(items) = object.get("cells") {
        let items = items.as_array().ok_or_else(|| TaskError::Refused(SHAPE.into()))?;
        for item in items {
            let (Some(row), Some(col)) = (item.get("row").and_then(Value::as_str), item.get("col").and_then(Value::as_str)) else {
                return refuse(SHAPE);
            };
            let at = (row.to_string(), col.to_string());
            if !live.contains(&at) {
                return refuse(format!("{row}.{col} is not a cell of {slug}; run `atelier grid show {slug}`"));
            }
            if cell_reason.contains_key(&at) {
                return refuse(format!("cell {row}.{col} is listed twice; list each cell once; nothing changed"));
            }
            let after = item.get("after").and_then(Value::as_array)
                .ok_or_else(|| TaskError::Refused(format!("cell {row}.{col} needs after: a list of [ROW, COL] pairs")))?;
            let mut pairs = Vec::new();
            for other in after {
                let pair = other.as_array().filter(|pair| pair.len() == 2)
                    .and_then(|pair| Some((pair[0].as_str()?.to_string(), pair[1].as_str()?.to_string())))
                    .ok_or_else(|| TaskError::Refused(format!("cell {row}.{col}: after must list [ROW, COL] pairs")))?;
                if !live.contains(&pair) {
                    return refuse(format!("cell {row}.{col} comes after {}.{}, but {}.{} is not a cell of {slug}", pair.0, pair.1, pair.0, pair.1));
                }
                if pair == at {
                    return refuse(format!("cell {row}.{col} cannot come after itself"));
                }
                if !pairs.contains(&pair) {
                    pairs.push(pair);
                }
            }
            cell_reason.insert(at.clone(), reason_of(item, &format!("cell {row}.{col}"))?);
            cell_after.insert(at, pairs);
        }
    }
    // Every cell's prerequisites together, from its column, its row and its own list.
    let mut graph: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (row, col) in &live {
        let mut before: Vec<String> = col_after[col].iter().map(|other| format!("{row}.{other}"))
            .chain(row_after[row].iter().map(|other| format!("{other}.{col}")))
            .chain(cell_after[&(row.clone(), col.clone())].iter().map(|(r, c)| format!("{r}.{c}")))
            .collect();
        before.retain(|name| live.iter().any(|(r, c)| format!("{r}.{c}") == *name));
        graph.insert(format!("{row}.{col}"), before);
    }
    if let Some(cycle) = cycle_in(&graph) {
        return refuse(format!("that order makes a cycle: cells {}; nothing changed", cycle.join(" after ")));
    }
    // Reordering cannot skip a step: a prerequisite the old order set stays
    // until the cell it names is proved or N/A.
    let settled: HashSet<String> = pairs.iter()
        .filter(|(_, _, cell)| matches!(cell.state.as_str(), "proved" | "na"))
        .map(|(row, col, _)| format!("{}.{}", row.id, col.id))
        .collect();
    let mut dropped = Vec::new();
    for (row, col, cell) in &pairs {
        let name = format!("{}.{}", row.id, col.id);
        for (r, c) in prerequisites(row, col, cell) {
            let before = format!("{r}.{c}");
            if live.contains(&(r.clone(), c.clone())) && !settled.contains(&before) && !graph[&name].contains(&before) {
                dropped.push(format!("{name} after {before}"));
            }
        }
    }
    if !dropped.is_empty() {
        return refuse(format!(
            "that order drops prerequisites whose cells are not proved or N/A: {}. Keep them in the new order; nothing changed",
            dropped.join(", ")
        ));
    }
    for (row, col) in cell_reason.keys() {
        let pairs: Vec<Value> = cell_after[&(row.clone(), col.clone())].iter().map(|(r, c)| json!([r, c])).collect();
        connection.execute("UPDATE grid_cell SET after = ?5, after_reason = ?6 WHERE project_id = ?1 AND slug = ?2 AND row = ?3 AND col = ?4",
            params![request.project, slug, row, col, Value::Array(pairs).to_string(), cell_reason[&(row.clone(), col.clone())]])?;
    }
    for (table, list) in [("grid_row", &rows_written), ("grid_column", &cols_written)] {
        for (seq, (id, after, reason)) in list.iter().enumerate() {
            connection.execute(
                &format!("UPDATE {table} SET after = ?4, order_seq = ?5, order_reason = ?6 WHERE project_id = ?1 AND slug = ?2 AND id = ?3"),
                params![request.project, slug, id, json!(after).to_string(), seq as i64, reason],
            )?;
        }
    }
    refresh_steps(connection, "project_id = ?1 AND slug = ?2", params![request.project, slug])?;
    let entries = |list: &[(String, Vec<String>, String)]| -> Vec<Value> {
        list.iter().map(|(id, after, reason)| json!({"id": id, "after": after, "reason": reason})).collect()
    };
    let order = json!({"rows": entries(&rows_written), "columns": entries(&cols_written),
        "cells": cell_reason.iter().map(|((row, col), reason)| json!({"row": row, "col": col, "after": cell_after[&(row.clone(), col.clone())], "reason": reason})).collect::<Vec<_>>()});
    connection.execute(
        "INSERT INTO grid_event (project_id, slug, seq, at, kind, row, col, session_id, actor, payload)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM grid_event WHERE project_id = ?1 AND slug = ?2),
                 ?3, 'order', NULL, NULL, ?4, ?5, ?6)",
        params![request.project, slug, request.now, request.session, request.actor, order.to_string()],
    )?;
    Ok(Outcome {
        slug: Some(slug.to_string()),
        summary: format!(
            "Order of {slug} set: {} row(s), {} column(s) and {} cell(s). Cells are handed out in this order; next `atelier grid next {slug}`.",
            rows_written.len(), cols_written.len(), cell_reason.len()
        ),
        grids: vec![slug.to_string()],
        ..Default::default()
    })
}

/// A cycle in "comes after" lists, as the ids around it, first repeated.
fn cycle_in(lists: &BTreeMap<String, Vec<String>>) -> Option<Vec<String>> {
    fn visit(id: &str, lists: &BTreeMap<String, Vec<String>>, path: &mut Vec<String>, done: &mut HashSet<String>) -> Option<Vec<String>> {
        if let Some(at) = path.iter().position(|seen| seen == id) {
            let mut cycle = path[at..].to_vec();
            cycle.push(id.to_string());
            return Some(cycle);
        }
        if done.contains(id) {
            return None;
        }
        path.push(id.to_string());
        for next in lists.get(id).into_iter().flatten() {
            if let Some(cycle) = visit(next, lists, path, done) {
                return Some(cycle);
            }
        }
        path.pop();
        done.insert(id.to_string());
        None
    }
    let mut done = HashSet::new();
    lists.keys().find_map(|id| visit(id, lists, &mut Vec::new(), &mut done))
}

/// Every note on a grid, oldest first: `{row, col, actor, sessionId, at, text}`.
pub fn notes(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT at, row, col, session_id, actor, payload FROM grid_event
          WHERE project_id = ?1 AND slug = ?2 AND kind = 'note' ORDER BY seq",
    )?;
    let rows = statement
        .query_map(params![project, slug], |row| {
            let payload = json_column(row, 5)?.unwrap_or(Value::Null);
            Ok(json!({
                "at": row.get::<_, i64>(0)?,
                "row": row.get::<_, Option<String>>(1)?,
                "col": row.get::<_, Option<String>>(2)?,
                "sessionId": row.get::<_, Option<String>>(3)?,
                "actor": row.get::<_, String>(4)?,
                "text": payload["text"],
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// The notes that cover one cell, each labelled by where it was left:
/// `cell`, `row`, `column` or `grid`.
pub fn notes_for(all: &[Value], row: &str, col: &str) -> Vec<Value> {
    all.iter()
        .filter_map(|note| {
            let scope = match (note["row"].as_str(), note["col"].as_str()) {
                (Some(r), Some(c)) if r == row && c == col => "cell",
                (Some(r), None) if r == row => "row",
                (None, Some(c)) if c == col => "column",
                (None, None) => "grid",
                _ => return None,
            };
            let mut note = note.clone();
            note["scope"] = json!(scope);
            Some(note)
        })
        .collect()
}

fn audit_done(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let slug = need(&request.slug, "slug", "audit_done")?;
    get_existing(connection, &request.project, slug)?;
    audit_gate(session, None, slug)?;
    let mut passed = 0;
    let mut reopened = Vec::new();
    for event in events(connection, &request.project, slug, None)? {
        if event["sessionId"] != session || event["actor"] != "agent" {
            continue;
        }
        match event["kind"].as_str() {
            Some("audit_passed") => passed += 1,
            Some("reopened") => reopened.push(json!({"row": event["row"], "col": event["col"], "reason": event["payload"]["reason"]})),
            _ => {}
        }
    }
    let audit = json!({"passed": passed, "reopened": reopened.len(), "cells": reopened});
    Ok(Outcome {
        slug: Some(slug.into()),
        summary: format!("Audit of \"{slug}\": {passed} passed, {} reopened.", reopened.len()),
        widget: Some("audit"),
        audit: Some(audit),
        grids: vec![slug.into()],
        ..Default::default()
    })
}

/* ----------------------------------------------------------- templates */

fn template_set(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let name = need(&request.slug, "the template's name", "template set")?;
    let project = request.project.as_str();
    let object = request.payload.as_object().ok_or_else(|| TaskError::Refused("the template payload is {columns: [{id, name, proof_rule}]}".into()))?;
    if let Some(unknown) = object.keys().find(|key| key.as_str() != "columns") {
        return refuse(format!("{unknown} is not a template field (allowed: columns)"));
    }
    let columns = check_columns(object.get("columns"), "columns", None)?;
    if columns.is_empty() {
        return refuse("columns is required: at least one {id, name, proof_rule}");
    }
    if columns.len() > MAX_COLUMNS {
        return refuse(format!("a template has at most {MAX_COLUMNS} columns"));
    }
    let now = request.now;
    let existing = get_template(connection, project, name)?;
    if existing.as_ref().is_some_and(|t| t.columns == columns) {
        return refuse(format!("template \"{name}\" already has exactly these columns"));
    }
    // Written as pending first, so the card can show what changed.
    let pending = json!({"columns": columns, "by": session, "at": now});
    connection.execute(
        "INSERT INTO grid_template (project_id, name, columns, pending, updated_at, updated_by) VALUES (?1, ?2, '[]', ?3, ?4, NULL)
         ON CONFLICT (project_id, name) DO UPDATE SET pending = ?3",
        params![project, name, pending.to_string(), now],
    )?;
    let change = template_change(connection, project, &get_template(connection, project, name)?.expect("the template was just written"))?;
    let touched = set_template(connection, project, name, &columns, Some(session), now)?;
    let mut value = template_json(&get_template(connection, project, name)?.expect("still there"));
    value["change"] = change;
    value["projectId"] = json!(project);
    Ok(Outcome {
        summary: format!(
            "Set the columns of template \"{name}\"{}.{}",
            if touched.is_empty() { String::new() } else { format!("; it now applies to {}", touched.join(", ")) },
            if touched.is_empty() { String::new() } else { format!(" Existing proofs stay; `@audit {}` reviews them against the new rules.", touched.join(", ")) }
        ),
        widget: Some("template"),
        template: Some(value),
        grids: touched,
        ..Default::default()
    })
}

/// A template takes `new` as its columns, and every grid made from it
/// gains, renames or retires its template columns to match. The grids
/// touched.
fn set_template(connection: &Connection, project: &str, name: &str, new: &[Value], by: Option<&str>, now: i64) -> Result<Vec<String>, TaskError> {
    connection.execute(
        "UPDATE grid_template SET columns = ?3, pending = NULL, updated_at = ?4, updated_by = ?5 WHERE project_id = ?1 AND name = ?2",
        params![project, name, Value::Array(new.to_vec()).to_string(), now, by],
    )?;
    let mut touched = Vec::new();
    for grid in list_grids(connection, project)? {
        if grid.status != "approved" || grid.template.as_deref() != Some(name) {
            continue;
        }
        let slug = grid.slug.clone();
        let existing = columns(connection, project, &slug)?;
        let mut position = existing.iter().map(|c| c.position).max().unwrap_or(-1) + 1;
        for column in new {
            let id = column["id"].as_str().unwrap_or("");
            let (title, rule) = (column["name"].as_str().unwrap_or(""), column["proof_rule"].as_str().unwrap_or(""));
            match existing.iter().find(|c| c.id == id) {
                // The grid's own column keeps its place; the card lists the clash.
                Some(own) if !own.from_template && own.retired_at.is_none() => {}
                Some(known) if known.retired_at.is_none() => {
                    if known.name != title || known.proof_rule != rule || !known.from_template {
                        connection.execute(
                            "UPDATE grid_column SET name = ?4, proof_rule = ?5, from_template = 1 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                            params![project, slug, id, title, rule],
                        )?;
                    }
                }
                _ => {
                    connection.execute(
                        "INSERT INTO grid_column (project_id, slug, id, name, proof_rule, position, from_template, retired_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, NULL)
                         ON CONFLICT (project_id, slug, id) DO UPDATE SET name = ?4, proof_rule = ?5, from_template = 1, retired_at = NULL",
                        params![project, slug, id, title, rule, position],
                    )?;
                    position += 1;
                    append_event(connection, project, &slug, now, "column_added", None, by, "agent", &json!({"col": id, "template": name}))?;
                }
            }
        }
        for column in existing.iter().filter(|c| c.from_template && c.retired_at.is_none()) {
            if !new.iter().any(|wanted| wanted["id"] == column.id.as_str()) {
                connection.execute(
                    "UPDATE grid_column SET retired_at = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                    params![project, slug, column.id, now],
                )?;
                append_event(connection, project, &slug, now, "column_retired", None, by, "agent", &json!({"col": column.id, "template": name}))?;
            }
        }
        fill_cells(connection, project, &slug)?;
        grid_touched(connection, project, &slug, now)?;
        touched.push(slug);
    }
    Ok(touched)
}

fn grid_touched(connection: &Connection, project: &str, slug: &str, now: i64) -> rusqlite::Result<()> {
    connection.execute("UPDATE grid SET updated_at = ?3 WHERE project_id = ?1 AND slug = ?2", params![project, slug, now])?;
    Ok(())
}

/* ----------------------------------------------------- work on cells: tasks */

/// A cell named by a task: `{grid, row, col}`, with `reason` in `task done`.
#[derive(Clone, Debug, PartialEq)]
pub struct CellRef {
    pub grid: String,
    pub row: String,
    pub col: String,
    pub reason: Option<String>,
}

impl CellRef {
    pub fn name(&self) -> String {
        format!("{}.{}.{}", self.grid, self.row, self.col)
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({"grid": self.grid, "row": self.row, "col": self.col});
        if let Some(reason) = &self.reason {
            value["reason"] = json!(reason);
        }
        value
    }
}

/// Read a `cells` list; `with_reason` for `task done`'s.
pub fn parse_cells(value: Option<&Value>, with_reason: bool) -> Result<Vec<CellRef>, String> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return Err(format!("cells must be a list of {{grid, row, col{}}}", if with_reason { ", reason" } else { "" })),
    };
    let mut cells: Vec<CellRef> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let allowed: &[&str] = if with_reason { &["grid", "row", "col", "reason"] } else { &["grid", "row", "col"] };
        let object = item.as_object().ok_or_else(|| format!("cells[{index}] must be an object: {{{}}}", allowed.join(", ")))?;
        if let Some(unknown) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(format!("cells[{index}].{unknown} is not a cell field (allowed: {})", allowed.join(", ")));
        }
        let id = |key: &str| -> Result<String, String> {
            let value = item[key].as_str().unwrap_or("");
            if valid_id(value) {
                Ok(value.to_string())
            } else {
                Err(format!("cells[{index}].{key} \"{value}\" is not a valid id ({ID_RULE})"))
            }
        };
        let cell = CellRef {
            grid: id("grid")?,
            row: id("row")?,
            col: id("col")?,
            reason: item.get("reason").and_then(Value::as_str).map(str::trim).filter(|r| !r.is_empty()).map(str::to_string),
        };
        if cells.iter().any(|known| known.name() == cell.name()) {
            return Err(format!("cells[{index}] {} is listed twice", cell.name()));
        }
        cells.push(cell);
    }
    Ok(cells)
}

/// Refused when one of these is not a live cell. A task only references
/// cells: whatever state they are in, nothing about them changes.
pub fn check_cells(connection: &Connection, project: &str, cells: &[CellRef]) -> Result<(), TaskError> {
    for cell in cells {
        find_live_cell(connection, project, &cell.grid, &cell.row, &cell.col)?;
    }
    Ok(())
}

/// Record that task `number` references these cells. The cells do not
/// change; many tasks may reference one cell. The grids named.
pub fn link(connection: &Connection, project: &str, number: i64, cells: &[CellRef]) -> Result<Vec<String>, TaskError> {
    check_cells(connection, project, cells)?;
    let mut grids = Vec::new();
    for cell in cells {
        connection.execute(
            "INSERT OR IGNORE INTO grid_task_cell (project_id, task, slug, row, col) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project, number, cell.grid, cell.row, cell.col],
        )?;
        if !grids.contains(&cell.grid) {
            grids.push(cell.grid.clone());
        }
    }
    Ok(grids)
}

/// What `task done` may say about cells: each entry must be one the task
/// references. None is required.
pub fn check_done_cells(connection: &Connection, project: &str, number: i64, entries: &[CellRef]) -> Result<(), TaskError> {
    let referenced: Vec<(String, String, String)> = connection
        .prepare("SELECT slug, row, col FROM grid_task_cell WHERE project_id = ?1 AND task = ?2")?
        .query_map(params![project, number], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for entry in entries {
        if !referenced.iter().any(|(slug, row, col)| *slug == entry.grid && *row == entry.row && *col == entry.col) {
            return refuse(format!("cells has {}, which #{number} does not reference", entry.name()));
        }
    }
    Ok(())
}

/// The cells a task references, with their states now, for its card.
pub fn task_cells(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT t.slug, t.row, t.col, c.state, c.reason FROM grid_task_cell t
           LEFT JOIN grid_cell c ON c.project_id = t.project_id AND c.slug = t.slug AND c.row = t.row AND c.col = t.col
          WHERE t.project_id = ?1 AND t.task = ?2 ORDER BY t.slug, t.row, t.col",
    )?;
    let rows = statement
        .query_map(params![project, number], |row| {
            Ok(json!({
                "grid": row.get::<_, String>(0)?, "row": row.get::<_, String>(1)?, "col": row.get::<_, String>(2)?,
                "state": row.get::<_, Option<String>>(3)?,
                "reason": row.get::<_, Option<String>>(4)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// A chat as a cell or a task names it: `{id, title}`, the title as the app
/// shows it (its id when the chat is gone).
pub fn chat_json(connection: &Connection, session: &str) -> Value {
    let found = connection
        .query_row("SELECT * FROM session WHERE id = ?1", [session], super::store::session_from_row)
        .optional()
        .ok()
        .flatten();
    let title = found.map(|found| super::chat_name::name_session(&found)).unwrap_or_else(|| session.to_string());
    json!({"id": session, "title": title})
}

/* ---------------------------------------- what to work on next, and picks */

/// Every cell this one comes after: the same row's cells its column comes
/// after, the same column's cells its row comes after, and its own list.
fn prerequisites(row: &GridRow, col: &Column, cell: &Cell) -> Vec<(String, String)> {
    let mut before: Vec<(String, String)> = col.after.iter().map(|other| (row.id.clone(), other.clone()))
        .chain(row.after.iter().map(|other| (other.clone(), col.id.clone())))
        .chain(cell.waits_on())
        .collect();
    before.dedup();
    before
}

/// Why `slug.row.col` cannot be worked yet: the live cells it comes after
/// that are not proved (fresh) or N/A. None when it is ready.
pub fn unmet_prerequisites(connection: &Connection, project: &str, slug: &str, row: &str, col: &str, prints: &Prints) -> Result<Option<String>, TaskError> {
    let Some(loaded) = load(connection, project, slug)? else { return Ok(None) };
    let pairs = live_pairs(&loaded);
    let Some((grid_row, grid_col, cell)) = pairs.iter().find(|(r, c, _)| r.id == row && c.id == col) else { return Ok(None) };
    let unmet: Vec<String> = prerequisites(grid_row, grid_col, cell)
        .into_iter()
        .filter(|(r, c)| {
            pairs.iter().find(|(pr, pc, _)| pr.id == *r && pc.id == *c).is_some_and(|(_, _, other)| {
                !(other.state == "na" || (other.state == "proved" && !is_stale(slug, other, prints)))
            })
        })
        .map(|(r, c)| format!("{slug}.{r}.{c}"))
        .collect();
    Ok((!unmet.is_empty()).then(|| {
        format!(
            "{slug}.{row}.{col} waits for {}, which {} not proved or N/A. Next: `atelier grid next {slug}`",
            unmet.join(", "),
            if unmet.len() == 1 { "is" } else { "are" }
        )
    }))
}

/// Every cell that counts, row by row in the written order, columns in the
/// written order; rows and columns not yet ordered last, as drawn.
fn live_pairs(loaded: &Loaded) -> Vec<(&GridRow, &Column, &Cell)> {
    let mut columns: Vec<&Column> = loaded.columns.iter().filter(|col| col.retired_at.is_none()).collect();
    columns.sort_by_key(|col| (col.order_seq.is_none(), col.order_seq));
    let mut rows: Vec<&GridRow> = loaded.rows.iter().filter(|row| row.counts()).collect();
    rows.sort_by_key(|row| (row.order_seq.is_none(), row.order_seq));
    let mut pairs = Vec::new();
    for row in rows {
        for col in &columns {
            if let Some(cell) = loaded.cell(&row.id, &col.id) {
                pairs.push((row, *col, cell));
            }
        }
    }
    pairs
}

/// What a cell is to someone looking for work.
enum Standing {
    /// Needs work: unchecked, a gap, or a stale proof.
    Free,
    /// Needs work, but has no check, so nothing can prove it yet.
    NeedsCheck,
    /// Needs work, but its row or column has no place in the written order.
    NeedsOrder,
    /// Needs work, but its row's cases are not reviewed yet.
    NeedsCases,
    /// Proved and fresh, or N/A.
    Settled,
}

fn standing(loaded: &Loaded, cell: &Cell, prints: &Prints) -> Standing {
    let free = match cell.state.as_str() {
        "unchecked" | "gap" => true,
        "proved" => is_stale(&loaded.grid.slug, cell, prints),
        _ => false,
    };
    match free {
        true if loaded.unordered(&cell.row, &cell.col).is_some() => Standing::NeedsOrder,
        true if !loaded.row_approved(&cell.row) => Standing::NeedsCases,
        true if loaded.cell_checks(&cell.row, &cell.col).is_empty() => Standing::NeedsCheck,
        true => Standing::Free,
        false => Standing::Settled,
    }
}

/// What a set of picked cells is called in a task's title and in the chat:
/// a row, a column, one cell, or a count.
pub struct Label {
    /// "Glare row", "GPU column", "Glare × GPU"; None for a mixed pick.
    pub name: Option<String>,
    pub count: usize,
    /// "gap" when only gaps were picked, else "cell".
    pub noun: &'static str,
    /// The cells make up a whole row, column or grid (`cell_shape`): the
    /// task's card names the shape and its count, so the title leaves the
    /// count out.
    pub shaped: bool,
}

impl Label {
    fn counted(&self) -> String {
        format!("{} {}{}", self.count, self.noun, if self.count == 1 { "" } else { "s" })
    }

    /// The task's title: "camera: Glare row" for a whole row, column or
    /// grid, "camera: Glare row (5 gaps)" for part of one, "camera: 12 gaps".
    pub fn title(&self, slug: &str) -> String {
        let title = match &self.name {
            Some(name) if self.count == 1 && name.contains('×') => format!("{slug}: {name}"),
            Some(name) if self.shaped => format!("{slug}: {name}"),
            Some(name) => format!("{slug}: {name} ({})", self.counted()),
            None => format!("{slug}: {}", self.counted()),
        };
        clip(&title, 120)
    }

    /// For a sentence: "Glare row, 5 cells", "12 gaps".
    pub fn words(&self) -> String {
        match &self.name {
            Some(name) if self.count == 1 && name.contains('×') => name.clone(),
            Some(name) => format!("{name}, {}", self.counted()),
            None => self.counted(),
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

/// The `atelier task create` payload for these cells of one grid: type
/// `general`, one plan item per cell (id `ROW.COL`, its requirement and proof
/// rule), and the cells it references.
pub fn task_payload(loaded: &Loaded, picked: &[(String, String)], label: &Label) -> Value {
    let slug = &loaded.grid.slug;
    let done_when: Vec<Value> = picked
        .iter()
        .enumerate()
        .map(|(index, (row, col))| {
            let id = format!("{row}.{col}");
            let id = if id.chars().count() > 64 { format!("cell{}", index + 1) } else { id };
            let row_name = loaded.row(row).map(|r| r.name.as_str()).unwrap_or(row);
            let (col_name, rule) = loaded.column(col).map(|c| (c.name.as_str(), c.proof_rule.as_str())).unwrap_or((col, ""));
            let mut item = json!({"id": id, "text": format!("{row_name} × {col_name}: {rule}")});
            let checks = loaded.cell_checks(row, col);
            if !checks.is_empty() {
                item["checks"] = Value::Array(checks);
            }
            item
        })
        .collect();
    json!({
        "type": "general",
        "title": label.title(slug),
        "why": clip(&format!("Close {} of the \"{}\" coverage grid.", label.counted(), loaded.grid.title), 300),
        "plan": {
            "outcome": "Each cell below is proved with `atelier grid prove`, or marked N/A with `atelier grid na`.",
            "done_when": done_when,
        },
        "cells": picked.iter().map(|(row, col)| json!({"grid": slug, "row": row, "col": col})).collect::<Vec<_>>(),
    })
}

fn live_grid(connection: &Connection, project: &str, slug: &str) -> Result<Loaded, TaskError> {
    load(connection, project, slug)?
        .filter(|loaded| loaded.grid.status != "discarded")
        .ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\" in this project; run `atelier grid list`")))
}

/// Which part of a grid `atelier grid next` looks at.
#[derive(Clone, Debug, PartialEq)]
pub enum Scope {
    /// The first row, in drawn order, with a free cell.
    First,
    Row(String),
    Col(String),
}

/// `atelier grid next`: one cell, the first ready one in the grid's order.
pub fn next_cells(connection: &Connection, project: &str, slug: &str, prints: &Prints, scope: &Scope) -> Result<Value, TaskError> {
    next_batch(connection, project, slug, prints, scope, 1)
}

/// `atelier grid next --batch N`: up to `batch` ready cells in the grid's
/// order (rows as drawn, columns by position), over the whole grid or the
/// row or column named. A free cell is ready when every cell its row or
/// column comes after is proved or N/A; otherwise it waits. Also: the cells
/// there that need a check, the waiting cells and what each waits for, and
/// how many free cells the grid has left.
pub fn next_batch(connection: &Connection, project: &str, slug: &str, prints: &Prints, scope: &Scope, batch: usize) -> Result<Value, TaskError> {
    let loaded = live_grid(connection, project, slug)?;
    let batch = batch.max(1);
    let pairs = live_pairs(&loaded);
    let standings: Vec<Standing> = pairs.iter().map(|(_, _, cell)| standing(&loaded, cell, prints)).collect();
    let left = standings.iter().filter(|s| matches!(s, Standing::Free)).count();
    let needs_check_in_grid = standings.iter().filter(|s| matches!(s, Standing::NeedsCheck)).count();
    let needs_cases_in_grid = standings.iter().filter(|s| matches!(s, Standing::NeedsCases)).count();
    // The rows and columns the order has yet to name: nothing in them can be
    // worked until it does.
    let needs_order_in_grid = standings.iter().filter(|s| matches!(s, Standing::NeedsOrder)).count();
    let unordered = |ids: Vec<(&String, Option<i64>)>| ids.into_iter().filter(|(_, seq)| seq.is_none()).map(|(id, _)| id.clone()).collect::<Vec<_>>();
    let needs_order = json!({
        "rows": unordered(loaded.rows.iter().filter(|row| row.counts()).map(|row| (&row.id, row.order_seq)).collect()),
        "columns": unordered(loaded.columns.iter().filter(|col| col.retired_at.is_none()).map(|col| (&col.id, col.order_seq)).collect()),
    });
    // The rows to give cases first: each row with a cell that needs work and
    // cases, with the cells of it not yet reviewed, step and next command.
    let mut needs_cases: Vec<Value> = Vec::new();
    for ((row, _, _), standing) in pairs.iter().zip(&standings) {
        if matches!(standing, Standing::NeedsCases) && !needs_cases.iter().any(|known| known["row"] == row.id.as_str()) {
            let cells: Vec<Value> = cases::row_waiting(&loaded, &row.id)
                .iter()
                .map(|cell| json!({"col": cell.col, "step": cell.step, "next": cell.next}))
                .collect();
            needs_cases.push(json!({"row": row.id, "rowName": row.name, "cells": cells}));
        }
    }
    // A cell is done for whoever comes after it when it is N/A or proved and fresh.
    let done: HashSet<(&str, &str)> = pairs
        .iter()
        .filter(|(_, _, cell)| cell.state == "na" || (cell.state == "proved" && !is_stale(slug, cell, prints)))
        .map(|(row, col, _)| (row.id.as_str(), col.id.as_str()))
        .collect();
    let live: HashSet<(&str, &str)> = pairs.iter().map(|(row, col, _)| (row.id.as_str(), col.id.as_str())).collect();
    let waits_for = |row: &GridRow, col: &Column, cell: &Cell| -> Vec<String> {
        prerequisites(row, col, cell)
            .into_iter()
            .filter(|(r, c)| live.contains(&(r.as_str(), c.as_str())) && !done.contains(&(r.as_str(), c.as_str())))
            .map(|(r, c)| format!("{r}.{c}"))
            .collect()
    };
    let inside = |row: &GridRow, col: &Column| match scope {
        Scope::First => true,
        Scope::Row(id) => row.id == *id,
        Scope::Col(id) => col.id == *id,
    };
    match scope {
        Scope::Row(id) if !loaded.row(id).is_some_and(GridRow::counts) => {
            return refuse(format!("grid \"{slug}\" has no row \"{id}\" with cells; run `atelier grid show {slug}`"));
        }
        Scope::Col(id) if !loaded.column(id).is_some_and(|col| col.retired_at.is_none()) => {
            return refuse(format!("grid \"{slug}\" has no column \"{id}\"; run `atelier grid show {slug}`"));
        }
        _ => {}
    }
    let all_notes = notes(connection, project, slug)?;
    let (mut picked, mut ready, mut waiting) = (Vec::new(), Vec::new(), Vec::new());
    let mut waiting_in_grid = 0;
    for ((row, col, cell), standing) in pairs.iter().zip(&standings) {
        if !matches!(standing, Standing::Free) {
            continue;
        }
        let before = waits_for(row, col, cell);
        if !before.is_empty() {
            waiting_in_grid += 1;
            if inside(row, col) {
                waiting.push(json!({"row": row.id, "col": col.id, "rowName": row.name, "colName": col.name, "after": before}));
            }
            continue;
        }
        if inside(row, col) && picked.len() < batch {
            ready.push(json!({
                "row": row.id, "col": col.id, "rowName": row.name, "colName": col.name,
                "state": cell.state, "stale": is_stale(slug, cell, prints), "proofRule": col.proof_rule,
                "notes": notes_for(&all_notes, &row.id, &col.id),
                "next": format!("atelier grid prove {slug} {} {}", row.id, col.id),
            }));
            picked.push((row.id.clone(), col.id.clone()));
        }
    }
    // What the cells handed out sit in: the named row or column, or the
    // row of the first cell.
    let chosen: Option<(&str, String, String)> = match scope {
        Scope::Row(id) => loaded.row(id).map(|row| ("row", row.id.clone(), row.name.clone())),
        Scope::Col(id) => loaded.column(id).map(|col| ("col", col.id.clone(), col.name.clone())),
        Scope::First => picked.first().and_then(|(row, _)| loaded.row(row)).map(|row| ("row", row.id.clone(), row.name.clone())),
    };
    let mut needs_check = Vec::new();
    if let Some((kind, id, _)) = &chosen {
        for ((row, col, cell), standing) in pairs.iter().zip(&standings) {
            let here = if *kind == "row" { row.id == *id } else { col.id == *id };
            if here && matches!(standing, Standing::NeedsCheck) {
                needs_check.push(json!({
                    "row": row.id, "col": col.id, "rowName": row.name, "colName": col.name,
                    "state": cell.state, "proofRule": col.proof_rule,
                }));
            }
        }
    }
    Ok(json!({
        "grid": slug, "title": loaded.grid.title,
        "scope": chosen.as_ref().map(|(kind, id, name)| json!({"kind": kind, "id": id, "name": name})),
        "cells": ready, "left": left,
        "needsCheck": needs_check, "needsCheckInGrid": needs_check_in_grid,
        "waiting": waiting, "waitingInGrid": waiting_in_grid,
        "needsCases": needs_cases, "needsCasesInGrid": needs_cases_in_grid,
        "needsOrder": needs_order, "needsOrderInGrid": needs_order_in_grid,
        // Finished only when every cell is proved or N/A.
        "finished": left == 0 && needs_check_in_grid == 0 && needs_cases_in_grid == 0 && needs_order_in_grid == 0,
    }))
}

/// Cells the owner picked on the Grids screen: `rows` and `cols` are lists of
/// ids or `"*"`, as in `@grid:SLUG.ROWS.COLS`; `onlyGaps` keeps only cells
/// with no proof (unchecked or gap), leaving out stale proofs.
#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    pub slug: String,
    pub rows: Option<Vec<String>>,
    pub cols: Option<Vec<String>>,
    pub only_gaps: bool,
}

impl Pick {
    pub fn parse(value: &Value) -> Result<Pick, String> {
        const SHAPE: &str = "grid must be {slug, rows, cols, onlyGaps}, with rows and cols a list of ids or \"*\"";
        let object = value.as_object().ok_or(SHAPE)?;
        let slug = object.get("slug").and_then(Value::as_str).unwrap_or("");
        if !valid_id(slug) {
            return Err(format!("grid.slug \"{slug}\" is not a valid id ({ID_RULE})"));
        }
        let ids = |key: &str| -> Result<Option<Vec<String>>, String> {
            match object.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(all)) if all == "*" => Ok(None),
                Some(Value::Array(items)) => {
                    let ids: Vec<String> = items.iter().filter_map(Value::as_str).map(str::to_string).collect();
                    if ids.len() != items.len() || ids.is_empty() {
                        return Err(format!("grid.{key} must be a non-empty list of ids, or \"*\""));
                    }
                    if let Some(bad) = ids.iter().find(|id| !valid_id(id)) {
                        return Err(format!("grid.{key} has \"{bad}\", which is not a valid id ({ID_RULE})"));
                    }
                    Ok(Some(ids))
                }
                Some(_) => Err(SHAPE.into()),
            }
        };
        Ok(Pick {
            slug: slug.to_string(),
            rows: ids("rows")?,
            cols: ids("cols")?,
            only_gaps: object.get("onlyGaps").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// The cells of a pick that need work, in drawn order, with the task payload
/// for them. Refused when none does.
pub fn picked_task(connection: &Connection, project: &str, pick: &Pick, prints: &Prints) -> Result<(Value, Label), TaskError> {
    let slug = pick.slug.as_str();
    let loaded = live_grid(connection, project, slug)?;
    for id in pick.rows.iter().flatten() {
        if !loaded.row(id).is_some_and(GridRow::counts) {
            return refuse(format!("grid \"{slug}\" has no row \"{id}\" with cells"));
        }
    }
    for id in pick.cols.iter().flatten() {
        if !loaded.column(id).is_some_and(|col| col.retired_at.is_none()) {
            return refuse(format!("grid \"{slug}\" has no column \"{id}\""));
        }
    }
    let (mut picked, mut needing) = (Vec::new(), Vec::new());
    for (row, col, cell) in live_pairs(&loaded) {
        if pick.rows.as_ref().is_some_and(|ids| !ids.contains(&row.id)) || pick.cols.as_ref().is_some_and(|ids| !ids.contains(&col.id)) {
            continue;
        }
        if pick.only_gaps && !matches!(cell.state.as_str(), "unchecked" | "gap") {
            continue;
        }
        match standing(&loaded, cell, prints) {
            Standing::Free => picked.push((row.id.clone(), col.id.clone())),
            Standing::NeedsCheck => needing.push(format!("{slug}.{}.{}", row.id, col.id)),
            _ => {}
        }
    }
    if picked.is_empty() && !needing.is_empty() {
        return refuse(format!(
            "{} has no check. Add one to the column (`atelier grid checks`) or to the cell",
            if needing.len() == 1 { needing[0].clone() } else { format!("{} and {} more cells", needing[0], needing.len() - 1) }
        ));
    }
    if picked.is_empty() {
        return refuse(format!(
            "none of the selected cells needs work: each is proved or N/A{}. Select other cells",
            if pick.only_gaps { ", or not a gap" } else { "" }
        ));
    }
    let one = |ids: &Option<Vec<String>>| ids.as_ref().filter(|ids| ids.len() == 1).map(|ids| ids[0].clone());
    let name = if picked.len() == 1 {
        let (row, col) = &picked[0];
        Some(format!("{} × {}", loaded.row(row).map(|r| r.name.as_str()).unwrap_or(row), loaded.column(col).map(|c| c.name.as_str()).unwrap_or(col)))
    } else {
        match (one(&pick.rows), one(&pick.cols), &pick.rows, &pick.cols) {
            (Some(row), None, _, None) => loaded.row(&row).map(|r| format!("{} row", r.name)),
            (None, Some(col), None, _) => loaded.column(&col).map(|c| format!("{} column", c.name)),
            _ => None,
        }
    };
    let shape = (picked.len() > 1).then(|| shape_named(&loaded, &picked)).flatten();
    let label = Label {
        shaped: shape.is_some(),
        name: shape.or(name),
        count: picked.len(),
        noun: if pick.only_gaps { "gap" } else { "cell" },
    };
    Ok((task_payload(&loaded, &picked, &label), label))
}

/// What a task's cells make up, for its card: one whole row, one whole column
/// or the whole grid, where "whole" means every other cell there is already
/// proved or N/A. `{grid, kind, id, name, count}`, or null.
pub fn cell_shape(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Value> {
    let mut statement =
        connection.prepare("SELECT slug, row, col FROM grid_task_cell WHERE project_id = ?1 AND task = ?2")?;
    let named: Vec<(String, String, String)> = statement
        .query_map(params![project, number], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let Some((slug, _, _)) = named.first() else { return Ok(Value::Null) };
    if named.iter().any(|(other, _, _)| other != slug) {
        return Ok(Value::Null);
    }
    let Some(loaded) = load(connection, project, slug)? else { return Ok(Value::Null) };
    let mine: HashSet<(&str, &str)> = named.iter().map(|(_, row, col)| (row.as_str(), col.as_str())).collect();
    Ok(shape_of(&loaded, &mine).map_or(Value::Null, |(kind, id, name)| {
        json!({"grid": slug, "kind": kind, "id": id, "name": name, "count": mine.len()})
    }))
}

/// What picked cells make up, in a title's words: "Glare
/// row", "GPU column", "whole grid"; None when they are no such shape.
fn shape_named(loaded: &Loaded, picked: &[(String, String)]) -> Option<String> {
    let mine: HashSet<(&str, &str)> = picked.iter().map(|(row, col)| (row.as_str(), col.as_str())).collect();
    shape_of(loaded, &mine).map(|(kind, _, name)| match kind {
        "row" => format!("{name} row"),
        "col" => format!("{name} column"),
        _ => "whole grid".to_string(),
    })
}

/// The row, column or grid `mine` makes up whole, every other cell there
/// being proved or N/A: `(kind, id, name)`.
fn shape_of(loaded: &Loaded, mine: &HashSet<(&str, &str)>) -> Option<(&'static str, String, String)> {
    let pairs = live_pairs(loaded);
    let whole = |inside: &dyn Fn(&GridRow, &Column) -> bool| {
        mine.iter().all(|(row, col)| pairs.iter().any(|(r, c, _)| r.id == *row && c.id == *col && inside(r, c)))
            && pairs.iter().filter(|(r, c, _)| inside(r, c)).all(|(r, c, cell)| {
                mine.contains(&(r.id.as_str(), c.id.as_str())) || matches!(cell.state.as_str(), "proved" | "na")
            })
    };
    let rows: HashSet<&str> = mine.iter().map(|(row, _)| *row).collect();
    let cols: HashSet<&str> = mine.iter().map(|(_, col)| *col).collect();
    if rows.len() == 1 && whole(&|r, _| rows.contains(r.id.as_str())) {
        let row = loaded.row(rows.iter().next().unwrap()).unwrap();
        Some(("row", row.id.clone(), row.name.clone()))
    } else if cols.len() == 1 && whole(&|_, c| cols.contains(c.id.as_str())) {
        let col = loaded.column(cols.iter().next().unwrap()).unwrap();
        Some(("col", col.id.clone(), col.name.clone()))
    } else if rows.len() > 1 && cols.len() > 1 && whole(&|_, _| true) {
        Some(("grid", loaded.grid.slug.clone(), loaded.grid.title.clone()))
    } else {
        None
    }
}

/* ------------------------------------------------------------- reconnect */

/// What a reconnected chat is told of its grid work: the cells its open
/// tasks reference that still need work. Empty when none.
pub fn open_lines(connection: &Connection, session: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT t.number, c.slug, c.row, c.col, c.state FROM task t
           JOIN grid_task_cell l ON l.project_id = t.project_id AND l.task = t.number
           JOIN grid_cell c ON c.project_id = l.project_id AND c.slug = l.slug AND c.row = l.row AND c.col = l.col
          WHERE t.session_id = ?1 AND t.status NOT IN ('done', 'cancelled') AND c.state IN ('unchecked', 'gap')
          ORDER BY t.number, c.slug, c.row, c.col",
    )?;
    let mut by_task: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for found in statement.query_map([session], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))
    })? {
        let (number, slug, row, col, state) = found?;
        by_task.entry(number).or_default().push(format!("{slug}.{row}.{col} [{state}]"));
    }
    if by_task.is_empty() {
        return Ok(Vec::new());
    }
    let cells: Vec<String> = by_task.into_iter().map(|(number, cells)| format!("#{number} → {}", cells.join(", "))).collect();
    Ok(vec![format!("Cells your tasks reference that are not proved yet: {}", cells.join("; "))])
}

/* ------------------------------------------------------- selection (@grid) */

/// `@grid:SLUG` or `@grid:SLUG.ROWS.COLS`, where ROWS and COLS are `*` or
/// ids joined by `+`. None for rows or columns means all of them.
#[derive(Clone, Debug, PartialEq)]
pub struct Selection {
    pub slug: String,
    pub cells: Option<(Option<Vec<String>>, Option<Vec<String>>)>,
}

fn id_set(text: &str) -> Option<Option<Vec<String>>> {
    if text == "*" {
        return Some(None);
    }
    let ids: Vec<String> = text.split('+').map(str::to_string).collect();
    ids.iter().all(|id| valid_id(id)).then_some(Some(ids))
}

impl Selection {
    pub fn parse(id: &str) -> Option<Selection> {
        let parts: Vec<&str> = id.split('.').collect();
        match parts.as_slice() {
            [slug] if valid_id(slug) => Some(Selection { slug: slug.to_string(), cells: None }),
            [slug, rows, cols] if valid_id(slug) => {
                Some(Selection { slug: slug.to_string(), cells: Some((id_set(rows)?, id_set(cols)?)) })
            }
            _ => None,
        }
    }
}

/// What the agent is told about a `@grid:` reference: the grid, or each
/// selected cell with its requirement, state, reason and proof.
pub fn describe(id: &str, loaded: Option<&Loaded>, prints: &Prints, with_task: bool) -> String {
    let Some(selection) = Selection::parse(id) else {
        return format!("@grid:{id} does not name a grid or cells.");
    };
    let Some(loaded) = loaded.filter(|l| l.grid.status != "discarded") else {
        return format!("@grid:{id} — there is no grid \"{}\" in this project.", selection.slug);
    };
    let grid = &loaded.grid;
    let counts = counts(loaded, prints);
    let mut lines = vec![format!(
        "@grid:{id} — coverage grid \"{}\" ({}{}): {}",
        grid.title,
        grid.status,
        percent(loaded, &counts).map(|p| format!(", {p}% proved")).unwrap_or_default(),
        grid.area
    )];
    let Some((rows, cols)) = &selection.cells else {
        lines.push(format!(
            "Open cells: {} gap, {} stale, {} unchecked. Run `atelier grid show {}` for the matrix.",
            counts["gap"], counts["stale"], counts["unchecked"], grid.slug
        ));
        return lines.join("\n");
    };
    let chosen_rows: Vec<&GridRow> = loaded
        .rows
        .iter()
        .filter(|row| row.removed_at.is_none())
        .filter(|row| rows.as_ref().is_none_or(|ids| ids.contains(&row.id)))
        .collect();
    let chosen_cols: Vec<&Column> = loaded
        .columns
        .iter()
        .filter(|col| col.retired_at.is_none())
        .filter(|col| cols.as_ref().is_none_or(|ids| ids.contains(&col.id)))
        .collect();
    for missing in rows.iter().flatten().filter(|id| !chosen_rows.iter().any(|r| &r.id == *id)) {
        lines.push(format!("{}.{missing}: no such row.", grid.slug));
    }
    for missing in cols.iter().flatten().filter(|id| !chosen_cols.iter().any(|c| &c.id == *id)) {
        lines.push(format!("{}.*.{missing}: no such column.", grid.slug));
    }
    let mut listed = 0;
    for row in &chosen_rows {
        if row.kind == "reference" {
            lines.push(format!(
                "{}.{}: a reference row; its cells belong to {}.{}.",
                grid.slug,
                row.id,
                row.reference.as_ref().and_then(|r| r["grid"].as_str()).unwrap_or("?"),
                row.reference.as_ref().and_then(|r| r["row"].as_str()).unwrap_or("?")
            ));
            continue;
        }
        for col in &chosen_cols {
            let Some(cell) = loaded.cell(&row.id, &col.id) else { continue };
            listed += 1;
            if listed > 200 {
                continue;
            }
            let stale = is_stale(&grid.slug, cell, prints);
            let mut line = format!(
                "- {}.{}.{} — {} × {}; proof rule: {}; state {}{}",
                grid.slug, row.id, col.id, row.name, col.name, col.proof_rule, cell.state, if stale { " (stale)" } else { "" }
            );
            if row.missing_since.is_some() {
                line.push_str("; row missing from the search");
            }
            if let Some(reason) = &cell.reason {
                line.push_str(&format!("; reason: {reason}"));
            }
            if let Some(summary) = cell.proof.as_ref().and_then(|p| p["summary"].as_str()) {
                line.push_str(&format!("; proof: {summary}"));
            }
            lines.push(line);
        }
    }
    if listed > 200 {
        lines.push(format!("… and {} more; run `atelier grid show {}`.", listed - 200, grid.slug));
    }
    if listed == 0 {
        lines.push("No cells are selected.".into());
    }
    if with_task {
        lines.push("Create one task for these cells and give them as `cells` in the create payload.".into());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod unlocked_tests;
#[cfg(test)]
mod note_tests;
#[cfg(test)]
mod step_tests;
#[cfg(test)]
mod case_tests;
#[cfg(test)]
mod order_tests;
