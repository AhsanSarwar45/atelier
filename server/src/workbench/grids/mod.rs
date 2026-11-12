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
    Ok(())
}

pub const AGENT_ACTIONS: &[&str] = &["draft", "discover", "prove", "verify", "na", "audit_done", "pass", "reopen", "template_set"];
pub const OWNER_ACTIONS: &[&str] = &[
    "approve", "discard", "approve_na", "reject_na", "reopen", "verify", "discover", "approve_template", "reject_template",
];
/// What a `grid` widget's `event` may be.
pub const WIDGET_EVENTS: &[&str] = &["draft", "template", "prove", "na", "audit", "reopen", "pass", "discover"];
pub const STATUSES: &[&str] = &["draft", "approved", "discarded"];
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
}

const GRID_COLUMNS: &str = "project_id, slug, title, area, status, template, row_search, pending, created_by, drafted_by,
    created_at, updated_at, approved_at, discovery";

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

/// The projects that have an approved grid, for the watcher.
pub fn projects_with_grids(connection: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = connection.prepare("SELECT DISTINCT project_id FROM grid WHERE status = 'approved' ORDER BY project_id")?;
    let rows = statement.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn save_grid(connection: &Connection, grid: &Grid) -> rusqlite::Result<()> {
    let text = |value: &Option<Value>| value.as_ref().map(Value::to_string);
    connection.execute(
        &format!("INSERT OR REPLACE INTO grid ({GRID_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"),
        params![
            grid.project_id, grid.slug, grid.title, grid.area, grid.status, grid.template,
            grid.row_search.to_string(), text(&grid.pending), grid.created_by, grid.drafted_by,
            grid.created_at, grid.updated_at, grid.approved_at, text(&grid.discovery),
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
}

pub fn columns(connection: &Connection, project: &str, slug: &str) -> rusqlite::Result<Vec<Column>> {
    let mut statement = connection.prepare(
        "SELECT id, name, proof_rule, position, from_template, retired_at FROM grid_column
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
        "SELECT id, name, kind, paths, of, ref, source, added_at, missing_since, removed_at FROM grid_row
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
}

const CELL_COLUMNS: &str = "row, col, state, proof, fingerprint, proved_by, proved_at, last_check, claimed_task, claimed_from,
    reason, audited_at, audited_by";

fn cell_record(row: &Row) -> rusqlite::Result<Cell> {
    Ok(Cell {
        row: row.get(0)?,
        col: row.get(1)?,
        state: row.get(2)?,
        proof: json_column(row, 3)?,
        fingerprint: row.get(4)?,
        proved_by: row.get(5)?,
        proved_at: row.get(6)?,
        last_check: json_column(row, 7)?,
        claimed_task: row.get(8)?,
        claimed_from: row.get(9)?,
        reason: row.get(10)?,
        audited_at: row.get(11)?,
        audited_by: row.get(12)?,
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
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)"
        ),
        params![
            project, slug, cell.row, cell.col, cell.state, text(&cell.proof), cell.fingerprint, cell.proved_by,
            cell.proved_at, text(&cell.last_check), cell.claimed_task, cell.claimed_from, cell.reason,
            cell.audited_at, cell.audited_by,
        ],
    )?;
    Ok(())
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
        paths.sort();
        paths.dedup();
        paths
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
/// by (grid slug, row id). A row missing here is taken as unchanged.
pub type Prints = HashMap<(String, String), String>;

pub fn is_stale(slug: &str, cell: &Cell, prints: &Prints) -> bool {
    cell.state == "proved"
        && match (prints.get(&(slug.to_string(), cell.row.clone())), &cell.fingerprint) {
            (Some(now), Some(then)) => now != then,
            _ => false,
        }
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
    let (mut counted, mut proved, mut stale, mut gap, mut unchecked, mut in_progress, mut na_pending, mut na) =
        (0, 0, 0, 0, 0, 0, 0, 0);
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
            "in_progress" => in_progress += 1,
            "na_pending" => na_pending += 1,
            _ => {}
        }
    }
    json!({"counted": counted, "proved": proved, "stale": stale, "gap": gap, "unchecked": unchecked,
        "inProgress": in_progress, "naPending": na_pending, "na": na})
}

/// Fresh proof over counted cells, rounded down; only approved grids have one.
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
        "updatedAt": grid.updated_at, "pending": grid.pending, "discovery": grid.discovery,
        "percent": percent(loaded, &counts), "counts": counts,
    })
}

pub fn column_json(column: &Column) -> Value {
    json!({"id": column.id, "name": column.name, "proofRule": column.proof_rule, "position": column.position,
        "fromTemplate": column.from_template, "retired": column.retired_at.is_some()})
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
        "claimedTask": cell.claimed_task, "reason": cell.reason, "provedBy": cell.proved_by,
        "provedAt": cell.proved_at, "auditedAt": cell.audited_at, "lastCheck": last_check,
        "proofSummary": cell.proof.as_ref().and_then(|proof| proof["summary"].as_str()),
    });
    if full {
        value["proof"] = cell.proof.clone().unwrap_or(Value::Null);
        value["fingerprint"] = json!(cell.fingerprint);
        value["claimedFrom"] = json!(cell.claimed_from);
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
    /// `{columns, by, at}`: a change waiting for the owner.
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
            .map(|column| json!({"id": column["id"], "name": column["name"], "proofRule": column["proof_rule"]}))
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
/// the approved grids that use it, and grids whose own column already has an
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

/* ----------------------------------------------------------- the owner */

/// The words of the owner's latest message in a chat, without what Atelier
/// added after them.
fn latest_owner_words(connection: &Connection, session: &str) -> rusqlite::Result<Option<String>> {
    let latest: Option<String> = connection
        .query_row(
            "SELECT text FROM message WHERE session_id = ?1 AND role = 'user' ORDER BY at DESC, rowid DESC LIMIT 1",
            [session],
            |row| row.get(0),
        )
        .optional()?;
    Ok(latest.map(|text| super::metadata::persons_words(&text)))
}

/// Whether the owner's latest message in this chat has `@audit SLUG` for this grid.
pub fn owner_asked_for_an_audit(connection: &Connection, session: &str, slug: &str) -> rusqlite::Result<bool> {
    Ok(latest_owner_words(connection, session)?
        .is_some_and(|words| super::references::audit_slugs(&words).iter().any(|named| named == slug)))
}

/// A chat's name for a refusal: its title, else its id.
fn chat_name(connection: &Connection, session: &str) -> String {
    connection
        .query_row("SELECT title FROM session WHERE id = ?1", [session], |row| row.get::<_, Option<String>>(0))
        .optional()
        .ok()
        .flatten()
        .flatten()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| session.to_string())
}

/// The task holding a claim: (status, holding session).
fn task_holder(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Option<(String, Option<String>)>> {
    connection
        .query_row(
            "SELECT status, session_id FROM task WHERE project_id = ?1 AND number = ?2",
            params![project, number],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
}

fn open_status(status: &str) -> bool {
    !matches!(status, "done" | "cancelled")
}

/// The open task claiming this cell, if any: (number, holding session).
fn open_claim(connection: &Connection, project: &str, cell: &Cell) -> rusqlite::Result<Option<(i64, Option<String>)>> {
    let Some(number) = cell.claimed_task else { return Ok(None) };
    Ok(task_holder(connection, project, number)?
        .filter(|(status, _)| open_status(status))
        .map(|(_, session)| (number, session)))
}

fn claim_words(connection: &Connection, number: i64, session: Option<&str>) -> String {
    match session {
        Some(session) => format!("#{number} in chat \"{}\"", chat_name(connection, session)),
        None => format!("#{number} (unassigned)"),
    }
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
    /// A line for a chat waiting on the owner: (session, text).
    pub tell: Vec<(String, String)>,
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
        other => return refuse(format!("actor must be agent or owner, not \"{other}\"")),
    }
    match action {
        "draft" => draft(connection, request),
        "approve" => approve(connection, request),
        "discard" => discard(connection, request),
        "discover" => discover(connection, request),
        "prove" => prove(connection, request),
        "verify" => verify(connection, request),
        "na" => ask_na(connection, request),
        "approve_na" | "reject_na" => answer_na(connection, request),
        "reopen" => reopen(connection, request),
        "pass" => pass(connection, request),
        "audit_done" => audit_done(connection, request),
        "template_set" => template_set(connection, request),
        "approve_template" | "reject_template" => answer_template(connection, request),
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

/// `[{id, name, proof_rule}]`, checked.
fn check_columns(value: Option<&Value>, at: &str) -> Result<Vec<Value>, TaskError> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(items)) => items,
        Some(_) => return refuse(format!("{at} must be a list of {{id, name, proof_rule}}")),
    };
    let mut checked: Vec<Value> = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let here = format!("{at}[{index}]");
        let object = item.as_object().ok_or_else(|| TaskError::Refused(format!("{here} must be an object: {{id, name, proof_rule}}")))?;
        if let Some(unknown) = object.keys().find(|key| !["id", "name", "proof_rule"].contains(&key.as_str())) {
            return refuse(format!("{here}.{unknown} is not a column field (allowed: id, name, proof_rule)"));
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
        checked.push(json!({"id": id, "name": name, "proof_rule": rule}));
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
                    None => return refuse(format!("row \"{id}\" refers to {grid}.{target}, which is not a row of an approved grid")),
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

/// Rows and columns an edit adds, removes or retires.
fn edit_diff(loaded: &Loaded, pending_rows: &[Value], pending_cols: &[Value]) -> Value {
    let new_rows: HashSet<&str> = pending_rows.iter().filter_map(|r| r["id"].as_str()).collect();
    let new_cols: HashSet<&str> = pending_cols.iter().filter_map(|c| c["id"].as_str()).collect();
    let live_rows: Vec<&GridRow> = loaded.rows.iter().filter(|r| r.removed_at.is_none()).collect();
    let rows_added: Vec<&str> =
        pending_rows.iter().filter_map(|r| r["id"].as_str()).filter(|id| !live_rows.iter().any(|r| r.id == *id)).collect();
    let rows_removed: Vec<&str> =
        live_rows.iter().filter(|r| r.source == "manual" && !new_rows.contains(r.id.as_str())).map(|r| r.id.as_str()).collect();
    let rows_missing: Vec<&str> = live_rows
        .iter()
        .filter(|r| r.source == "search" && r.missing_since.is_none() && !new_rows.contains(r.id.as_str()))
        .map(|r| r.id.as_str())
        .collect();
    let live_cols: Vec<&Column> = loaded.columns.iter().filter(|c| c.retired_at.is_none()).collect();
    let columns_added: Vec<&str> =
        pending_cols.iter().filter_map(|c| c["id"].as_str()).filter(|id| !live_cols.iter().any(|c| c.id == *id)).collect();
    let columns_retired: Vec<&str> =
        live_cols.iter().filter(|c| !new_cols.contains(c.id.as_str())).map(|c| c.id.as_str()).collect();
    json!({"rowsAdded": rows_added, "rowsRemoved": rows_removed, "rowsMissing": rows_missing,
        "columnsAdded": columns_added, "columnsRetired": columns_retired})
}

/// Whether this chat may draft grid `slug`: a new (or discarded) slug is
/// free to draft; another chat's draft is not this chat's to replace; an
/// approved grid may be edited (the owner approves the edit). Checked before
/// the row search runs, and again on the writer.
pub fn may_draft(connection: &Connection, project: &str, session: &str, slug: &str) -> Result<(), TaskError> {
    if let Some(grid) = get_grid(connection, project, slug)? {
        if grid.status == "draft" && grid.created_by.as_deref() != Some(session) {
            return refuse(format!(
                "grid \"{slug}\" is a draft by another chat ({}), still waiting for the owner. Pick another slug, \
                 or ask the owner to approve or discard that draft first",
                grid.created_by.as_deref().map(|s| chat_name(connection, s)).unwrap_or_else(|| "unknown".into())
            ));
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
    const FIELDS: &[&str] = &["slug", "title", "area", "template", "row_search", "columns", "rows"];
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
    let own_columns = check_columns(object.get("columns"), "columns")?;

    let existing = get_grid(connection, &request.project, slug)?;
    let edit = existing.as_ref().is_some_and(|grid| grid.status == "approved");
    may_draft(connection, &request.project, session, slug)?;

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

    let now = request.now;
    let mut pending = json!({
        "title": title, "area": area, "template": template, "rowSearch": row_search,
        "columns": all_columns.iter().map(|c| json!({"id": c["id"], "name": c["name"], "proofRule": c["proof_rule"],
            "fromTemplate": c["from_template"]})).collect::<Vec<_>>(),
        "rows": all_rows, "draftedBy": session, "draftedAt": now, "edit": edit, "diff": Value::Null,
    });
    let (rows_n, cols_n) = (all_rows.len(), all_columns.len());
    let grid = match existing.filter(|grid| grid.status != "discarded") {
        Some(mut grid) => {
            if edit {
                let loaded = load(connection, &request.project, slug)?.expect("the grid was just read");
                pending["diff"] = edit_diff(&loaded, &all_rows, &all_columns);
            } else {
                grid.title = title.into();
                grid.area = area.into();
                grid.template = template.clone();
                grid.row_search = row_search.clone();
            }
            grid.pending = Some(pending);
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
            pending: Some(pending),
            created_by: Some(session.to_string()),
            drafted_by: Some(session.to_string()),
            created_at: now,
            updated_at: now,
            approved_at: None,
            discovery: None,
        },
    };
    save_grid(connection, &grid)?;
    append_event(connection, &request.project, slug, now, if edit { "edit_drafted" } else { "drafted" }, None, Some(session), "agent",
        &json!({"rows": rows_n, "columns": cols_n}))?;
    Ok(Outcome {
        slug: Some(slug.into()),
        summary: format!(
            "Drafted {}grid \"{slug}\" ({rows_n} rows × {cols_n} columns); the owner approves or discards it on the card. \
             Stop here and end your turn. If the owner asks for changes, draft again with the same slug; their answer \
             arrives as your next message.",
            if edit { "an edit to " } else { "" }
        ),
        widget: Some("draft"),
        grids: vec![slug.into()],
        ..Default::default()
    })
}

fn get_existing(connection: &Connection, project: &str, slug: &str) -> Result<Grid, TaskError> {
    get_grid(connection, project, slug)?
        .filter(|grid| grid.status != "discarded")
        .ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\" in this project")))
}

/// Write a pending draft's rows and columns into the grid's live tables.
fn approve(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "approve")?;
    let project = request.project.as_str();
    let mut grid = get_existing(connection, project, slug)?;
    let pending = grid.pending.clone().ok_or_else(|| TaskError::Refused(format!("grid \"{slug}\" has no draft waiting")))?;
    let edit = grid.status == "approved";
    let now = request.now;
    let rows_wanted: Vec<Value> = pending["rows"].as_array().cloned().unwrap_or_default();
    let cols_wanted: Vec<Value> = pending["columns"].as_array().cloned().unwrap_or_default();
    // Another grid may have taken an id since the draft was made.
    check_rows(connection, project, slug, &rows_wanted)?;
    let loaded = load(connection, project, slug)?.expect("the grid was just read");

    // Columns.
    for (position, column) in cols_wanted.iter().enumerate() {
        let id = column["id"].as_str().unwrap_or("");
        let added = !loaded.columns.iter().any(|known| known.id == id && known.retired_at.is_none());
        connection.execute(
            "INSERT INTO grid_column (project_id, slug, id, name, proof_rule, position, from_template, retired_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)
             ON CONFLICT (project_id, slug, id) DO UPDATE SET name = ?4, proof_rule = ?5, position = ?6,
               from_template = ?7, retired_at = NULL",
            params![project, slug, id, column["name"].as_str().unwrap_or(""), column["proofRule"].as_str().unwrap_or(""),
                position as i64, column["fromTemplate"].as_bool().unwrap_or(false) as i64],
        )?;
        if edit && added {
            append_event(connection, project, slug, now, "column_added", None, None, "owner", &json!({"col": id}))?;
        }
    }
    for column in loaded.columns.iter().filter(|c| c.retired_at.is_none()) {
        if !cols_wanted.iter().any(|wanted| wanted["id"] == column.id.as_str()) {
            connection.execute(
                "UPDATE grid_column SET retired_at = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, column.id, now],
            )?;
            append_event(connection, project, slug, now, "column_retired", None, None, "owner", &json!({"col": column.id}))?;
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
            append_event(connection, project, slug, now, "row_added", None, None, "owner",
                &json!({"row": id}))?;
        }
    }
    for row in loaded.rows.iter().filter(|r| r.removed_at.is_none()) {
        if rows_wanted.iter().any(|wanted| wanted["id"] == row.id.as_str()) {
            continue;
        }
        if row.source == "manual" {
            connection.execute(
                "UPDATE grid_row SET removed_at = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, row.id, now],
            )?;
        } else if row.missing_since.is_none() {
            connection.execute(
                "UPDATE grid_row SET missing_since = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                params![project, slug, row.id, now],
            )?;
            append_event(connection, project, slug, now, "row_missing", None, None, "owner", &json!({"row": row.id}))?;
        }
    }
    let added = fill_cells(connection, project, slug)?;

    grid.title = pending["title"].as_str().unwrap_or(&grid.title).to_string();
    grid.area = pending["area"].as_str().unwrap_or(&grid.area).to_string();
    grid.template = pending["template"].as_str().map(str::to_string);
    grid.row_search = pending["rowSearch"].clone();
    grid.status = "approved".into();
    grid.approved_at = Some(now);
    grid.updated_at = now;
    grid.pending = None;
    save_grid(connection, &grid)?;
    let rows_n = rows_wanted.iter().filter(|row| row["kind"] != "reference").count();
    let cols_n = cols_wanted.len();
    append_event(connection, project, slug, now, if edit { "edit_approved" } else { "approved" }, None, None, "owner",
        &json!({"rows": rows_n, "columns": cols_n, "cells": added}))?;
    let summary = format!(
        "Owner approved {}grid \"{slug}\" ({rows_n} rows × {cols_n} columns). Run `atelier grid next {slug}` to pick the \
         next gaps, then create a task for them with those cells; or the owner can select cells and press Create task.",
        if edit { "the edit to " } else { "" }
    );
    let tell = pending["draftedBy"].as_str().map(|session| (session.to_string(), summary.clone())).into_iter().collect();
    Ok(Outcome { slug: Some(slug.into()), summary, tell, grids: vec![slug.into()], ..Default::default() })
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
}

fn discard(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let slug = need(&request.slug, "slug", "discard")?;
    let project = request.project.as_str();
    let mut grid = get_existing(connection, project, slug)?;
    let pending = grid.pending.take().ok_or_else(|| TaskError::Refused(format!("grid \"{slug}\" has no draft waiting")))?;
    let edit = grid.status == "approved";
    if !edit {
        grid.status = "discarded".into();
    }
    grid.updated_at = request.now;
    save_grid(connection, &grid)?;
    append_event(connection, project, slug, request.now, if edit { "edit_discarded" } else { "discarded" }, None, None, "owner",
        &json!({}))?;
    let summary = format!(
        "Owner discarded the {} grid \"{slug}\". Don't draft it again unless the owner asks.",
        if edit { "edit to" } else { "draft of" }
    );
    let tell = pending["draftedBy"].as_str().map(|session| (session.to_string(), summary.clone())).into_iter().collect();
    Ok(Outcome { slug: Some(slug.into()), summary, tell, grids: vec![slug.into()], ..Default::default() })
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

/// A cell that work, proof or an answer is about: it must be one of a live
/// row's cells in a live column of an approved grid.
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
    if loaded.grid.status != "approved" {
        return refuse(format!("grid \"{slug}\" is a draft; its cells exist once the owner approves it"));
    }
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

/// Refused when the cell's open claim belongs to a task another chat holds.
fn claim_is_this_chats(connection: &Connection, project: &str, cell: &Cell, session: &str, at: &str, doing: &str) -> Result<(), TaskError> {
    if let Some((number, holder)) = open_claim(connection, project, cell)? {
        if holder.as_deref() != Some(session) {
            return refuse(format!(
                "{at} is claimed by {}; only the chat holding that task may {doing} it. Work on another cell \
                 (`atelier grid next {}` lists free ones), or move the task here with `atelier task take {number}`",
                claim_words(connection, number, holder.as_deref()),
                at.split('.').next().unwrap_or_default()
            ));
        }
    }
    Ok(())
}

/// What `prove` checks before its checks are run: the cell, its state and
/// claim, and the proof's shape. The paths the row covers.
pub fn prove_precheck(connection: &Connection, request: &Request) -> Result<(proof::Proof, Vec<String>), TaskError> {
    let session = request.session.as_deref().ok_or_else(|| TaskError::Refused("session is required for prove".into()))?;
    let (loaded, cell) = live_cell(connection, request, "prove")?;
    let at = format!("{}.{}.{}", loaded.grid.slug, cell.row, cell.col);
    if matches!(cell.state.as_str(), "na" | "na_pending") {
        return refuse(format!("{at} is {}; a cell the owner is asked to mark N/A is not proved", cell.state.replace('_', " ")));
    }
    claim_is_this_chats(connection, &request.project, &cell, session, &at, "prove")?;
    let proof = proof::check_proof(&request.payload)?;
    Ok((proof, loaded.covered(&cell.row)))
}

fn prove(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let (checked, _) = prove_precheck(connection, request)?;
    let session = request.session.as_deref().unwrap_or_default();
    let (loaded, mut cell) = live_cell(connection, request, "prove")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    let folder = request.cwd.as_deref().unwrap_or("this chat's folder");
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
    cell.proof = Some(checked.value.clone());
    cell.fingerprint = Some(fingerprint);
    cell.proved_by = Some(session.to_string());
    cell.proved_at = Some(now);
    cell.last_check = Some(json!({"at": now, "head": request.head, "passed": true,
        "results": request.checks.iter().map(proof::CheckResult::to_json).collect::<Vec<_>>()}));
    cell.reason = None;
    cell.audited_at = None;
    cell.audited_by = None;
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, now, "proved", Some((&cell.row, &cell.col)), Some(session), "agent",
        &json!({"summary": checked.value["summary"], "head": request.head, "task": cell.claimed_task}))?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary: format!("{at} is proved: {} check{} passed.", request.checks.len(), if request.checks.len() == 1 { "" } else { "s" }),
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
        let freshened = stale && request.fingerprint.is_some();
        if freshened {
            cell.fingerprint = request.fingerprint.clone();
        }
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

/// The chat that last asked for N/A on a cell.
fn na_asker(connection: &Connection, project: &str, slug: &str, row: &str, col: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT session_id FROM grid_event WHERE project_id = ?1 AND slug = ?2 AND row = ?3 AND col = ?4
               AND kind = 'na_asked' ORDER BY seq DESC LIMIT 1",
            params![project, slug, row, col],
            |r| r.get(0),
        )
        .optional()
        .map(Option::flatten)
}

fn ask_na(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let (loaded, mut cell) = live_cell(connection, request, "na")?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    if !matches!(cell.state.as_str(), "unchecked" | "gap" | "in_progress") {
        return refuse(format!("{at} is {}; N/A is asked for an unchecked, gap or in-progress cell", cell.state.replace('_', " ")));
    }
    claim_is_this_chats(connection, &request.project, &cell, session, &at, "ask N/A for")?;
    let reason = payload_text(&request.payload, "reason", "why this requirement does not apply to this feature (--reason)", 600)?;
    cell.state = "na_pending".into();
    cell.reason = Some(reason.to_string());
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, request.now, "na_asked", Some((&cell.row, &cell.col)), Some(session), "agent",
        &json!({"reason": reason}))?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        summary: format!("Asked the owner to mark {at} N/A; they approve or reject it on the card. Their answer arrives as a message."),
        widget: Some("na"),
        grids: vec![slug],
        ..Default::default()
    })
}

fn answer_na(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let (loaded, mut cell) = live_cell(connection, request, &request.action)?;
    let slug = loaded.grid.slug.clone();
    let at = format!("{slug}.{}.{}", cell.row, cell.col);
    if cell.state != "na_pending" {
        return refuse(format!("{at} is {}; there is no N/A request waiting", cell.state.replace('_', " ")));
    }
    let asker = na_asker(connection, &request.project, &slug, &cell.row, &cell.col)?;
    let (kind, payload, summary) = if request.action == "approve_na" {
        cell.state = "na".into();
        ("na_approved", json!({}), format!("Owner approved N/A for {at}; it no longer counts."))
    } else {
        let note = payload_text(&request.payload, "note", "why it does apply", 600)?;
        let claimed = open_claim(connection, &request.project, &cell)?.is_some();
        cell.state = if claimed { "in_progress" } else { "gap" }.into();
        cell.reason = Some(note.to_string());
        ("na_rejected", json!({"note": note}), format!("Owner rejected N/A for {at}: {note}. The cell is {} again.", cell.state.replace('_', " ")))
    };
    save_cell(connection, &request.project, &slug, &cell)?;
    append_event(connection, &request.project, &slug, request.now, kind, Some((&cell.row, &cell.col)), None, "owner", &payload)?;
    Ok(Outcome {
        slug: Some(slug.clone()),
        cell: Some((cell.row.clone(), cell.col.clone())),
        tell: asker.map(|session| (session, summary.clone())).into_iter().collect(),
        summary,
        grids: vec![slug],
        ..Default::default()
    })
}

/// An agent's audit verdict is allowed only in a chat the owner asked to
/// audit this grid, and never on a cell this chat proved.
fn audit_gate(connection: &Connection, session: &str, slug: &str, cell: Option<&Cell>, at: &str) -> Result<(), TaskError> {
    if !owner_asked_for_an_audit(connection, session, slug)? {
        return refuse(format!(
            "the owner has not asked this chat to audit \"{slug}\": their latest message has no @audit {slug}. \
             Never pass or reopen cells outside an @audit request"
        ));
    }
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
    if agent {
        if cell.state != "proved" {
            return refuse(format!("{at} is {}; an audit reopens a proved cell", cell.state.replace('_', " ")));
        }
        audit_gate(connection, session.unwrap_or_default(), &slug, Some(&cell), &at)?;
    } else if !matches!(cell.state.as_str(), "proved" | "na") {
        return refuse(format!("{at} is {}; the owner reopens a proved or N/A cell", cell.state.replace('_', " ")));
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
    audit_gate(connection, session, &slug, Some(&cell), &at)?;
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

fn audit_done(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let session = request.session.as_deref().unwrap_or_default();
    let slug = need(&request.slug, "slug", "audit_done")?;
    get_existing(connection, &request.project, slug)?;
    audit_gate(connection, session, slug, None, slug)?;
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
    let object = request.payload.as_object().ok_or_else(|| TaskError::Refused("the template payload is {columns: [{id, name, proof_rule}]}".into()))?;
    if let Some(unknown) = object.keys().find(|key| key.as_str() != "columns") {
        return refuse(format!("{unknown} is not a template field (allowed: columns)"));
    }
    let columns = check_columns(object.get("columns"), "columns")?;
    if columns.is_empty() {
        return refuse("columns is required: at least one {id, name, proof_rule}");
    }
    if columns.len() > MAX_COLUMNS {
        return refuse(format!("a template has at most {MAX_COLUMNS} columns"));
    }
    let now = request.now;
    let existing = get_template(connection, &request.project, name)?;
    if existing.as_ref().is_some_and(|t| t.columns == columns && t.pending.is_none()) {
        return refuse(format!("template \"{name}\" already has exactly these columns"));
    }
    let pending = json!({"columns": columns, "by": session, "at": now});
    connection.execute(
        "INSERT INTO grid_template (project_id, name, columns, pending, updated_at, updated_by) VALUES (?1, ?2, '[]', ?3, ?4, NULL)
         ON CONFLICT (project_id, name) DO UPDATE SET pending = ?3",
        params![request.project, name, pending.to_string(), now],
    )?;
    let template = get_template(connection, &request.project, name)?.expect("the template was just written");
    let mut value = template_json(&template);
    value["change"] = template_change(connection, &request.project, &template)?;
    value["projectId"] = json!(request.project);
    Ok(Outcome {
        summary: format!(
            "Proposed a change to template \"{name}\"; the owner approves or rejects it on the card. Stop here; their answer \
             arrives as your next message."
        ),
        widget: Some("template"),
        template: Some(value),
        ..Default::default()
    })
}

fn answer_template(connection: &Connection, request: &Request) -> Result<Outcome, TaskError> {
    let name = need(&request.slug, "the template's name", &request.action)?;
    let project = request.project.as_str();
    let template = get_template(connection, project, name)?
        .ok_or_else(|| TaskError::Refused(format!("there is no template \"{name}\"")))?;
    let pending = template.pending.clone().ok_or_else(|| TaskError::Refused(format!("template \"{name}\" has no change waiting")))?;
    let by = pending["by"].as_str().map(str::to_string);
    let now = request.now;
    let change = template_change(connection, project, &template)?;
    if request.action == "reject_template" {
        connection.execute("UPDATE grid_template SET pending = NULL WHERE project_id = ?1 AND name = ?2", params![project, name])?;
        let summary = format!("Owner rejected the change to template \"{name}\".");
        let mut value = template_json(&get_template(connection, project, name)?.expect("still there"));
        value["change"] = change;
    value["projectId"] = json!(project);
        return Ok(Outcome { tell: by.map(|s| (s, summary.clone())).into_iter().collect(), summary, template: Some(value), ..Default::default() });
    }
    let new: Vec<Value> = pending["columns"].as_array().cloned().unwrap_or_default();
    connection.execute(
        "UPDATE grid_template SET columns = ?3, pending = NULL, updated_at = ?4, updated_by = ?5 WHERE project_id = ?1 AND name = ?2",
        params![project, name, Value::Array(new.clone()).to_string(), now, by],
    )?;
    let mut touched = Vec::new();
    for grid in list_grids(connection, project)? {
        if grid.status != "approved" || grid.template.as_deref() != Some(name) {
            continue;
        }
        let slug = grid.slug.clone();
        let existing = columns(connection, project, &slug)?;
        let mut position = existing.iter().map(|c| c.position).max().unwrap_or(-1) + 1;
        for column in &new {
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
                    append_event(connection, project, &slug, now, "column_added", None, None, "owner", &json!({"col": id, "template": name}))?;
                }
            }
        }
        for column in existing.iter().filter(|c| c.from_template && c.retired_at.is_none()) {
            if !new.iter().any(|wanted| wanted["id"] == column.id.as_str()) {
                connection.execute(
                    "UPDATE grid_column SET retired_at = ?4 WHERE project_id = ?1 AND slug = ?2 AND id = ?3",
                    params![project, slug, column.id, now],
                )?;
                append_event(connection, project, &slug, now, "column_retired", None, None, "owner", &json!({"col": column.id, "template": name}))?;
            }
        }
        fill_cells(connection, project, &slug)?;
        grid_touched(connection, project, &slug, now)?;
        touched.push(slug);
    }
    let summary = format!(
        "Owner approved the change to template \"{name}\"{}.{}",
        if touched.is_empty() { String::new() } else { format!("; it now applies to {}", touched.join(", ")) },
        if touched.is_empty() { String::new() } else { format!(" Existing proofs were not reopened; @audit {} to review them against the new rules.", touched.join(", ")) }
    );
    let mut value = template_json(&get_template(connection, project, name)?.expect("still there"));
    value["change"] = change;
    value["projectId"] = json!(project);
    Ok(Outcome { tell: by.map(|s| (s, summary.clone())).into_iter().collect(), summary, template: Some(value), grids: touched, ..Default::default() })
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

/// Why a task cannot claim this cell, or None when it can.
pub fn unclaimable(connection: &Connection, project: &str, cell: &CellRef, prints: &Prints) -> Result<Option<String>, TaskError> {
    let found = match find_live_cell(connection, project, &cell.grid, &cell.row, &cell.col) {
        Ok((_, found)) => found,
        Err(TaskError::Refused(message)) => return Ok(Some(message)),
        Err(other) => return Err(other),
    };
    let at = cell.name();
    if let Some((number, holder)) = open_claim(connection, project, &found)? {
        return Ok(Some(format!(
            "{at} is claimed by {}: pick another cell, or run `atelier grid next {}` for free ones",
            claim_words(connection, number, holder.as_deref()),
            cell.grid
        )));
    }
    Ok(match found.state.as_str() {
        "unchecked" | "gap" | "in_progress" => None,
        "proved" if is_stale(&cell.grid, &found, prints) => None,
        "proved" => Some(format!(
            "{at} is proved and its proof is fresh; there is nothing to do. Run `atelier grid next {}` for cells that need work",
            cell.grid
        )),
        "na" => Some(format!("{at} is N/A; leave it out")),
        "na_pending" => Some(format!("{at} is waiting for the owner's N/A answer; leave it out until they answer")),
        other => Some(format!("{at} is {other}")),
    })
}

/// The first cell of these a task cannot claim, as a refusal.
pub fn check_claimable(connection: &Connection, project: &str, cells: &[CellRef], prints: &Prints) -> Result<(), TaskError> {
    for cell in cells {
        if let Some(why) = unclaimable(connection, project, cell, prints)? {
            return refuse(why);
        }
    }
    Ok(())
}

/// Claim cells for task `number`: each must be claimable, or nothing is
/// claimed. Inside the task's own transaction. The grids touched.
pub fn claim(
    connection: &Connection,
    project: &str,
    number: i64,
    cells: &[CellRef],
    prints: &Prints,
    session: Option<&str>,
    actor: &str,
    now: i64,
) -> Result<Vec<String>, TaskError> {
    check_claimable(connection, project, cells, prints)?;
    let mut grids = Vec::new();
    for cell in cells {
        let mut found = get_cell(connection, project, &cell.grid, &cell.row, &cell.col)?.expect("checked above");
        found.claimed_from = Some(found.state.clone());
        found.claimed_task = Some(number);
        found.state = "in_progress".into();
        save_cell(connection, project, &cell.grid, &found)?;
        connection.execute(
            "INSERT OR IGNORE INTO grid_task_cell (project_id, task, slug, row, col) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project, number, cell.grid, cell.row, cell.col],
        )?;
        append_event(connection, project, &cell.grid, now, "claimed", Some((&cell.row, &cell.col)), session, actor, &json!({"task": number}))?;
        if !grids.contains(&cell.grid) {
            grids.push(cell.grid.clone());
        }
    }
    Ok(grids)
}

/// The cells task `number` holds a claim on now.
fn claimed_by(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Vec<(String, Cell)>> {
    let mut statement = connection.prepare(&format!(
        "SELECT slug, {CELL_COLUMNS} FROM grid_cell WHERE project_id = ?1 AND claimed_task = ?2 ORDER BY slug, row, col"
    ))?;
    let rows = statement
        .query_map(params![project, number], |row| {
            let slug: String = row.get(0)?;
            // The cell's columns follow the slug.
            Ok((slug, Cell {
                row: row.get(1)?,
                col: row.get(2)?,
                state: row.get(3)?,
                proof: json_column(row, 4)?,
                fingerprint: row.get(5)?,
                proved_by: row.get(6)?,
                proved_at: row.get(7)?,
                last_check: json_column(row, 8)?,
                claimed_task: row.get(9)?,
                claimed_from: row.get(10)?,
                reason: row.get(11)?,
                audited_at: row.get(12)?,
                audited_by: row.get(13)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// What `task done` must say about its cells: every claimed cell still in
/// progress needs an entry with a reason, and every entry must be one of the
/// task's cells.
pub fn check_done_cells(connection: &Connection, project: &str, number: i64, entries: &[CellRef]) -> Result<(), TaskError> {
    let claimed = claimed_by(connection, project, number)?;
    for entry in entries {
        if !claimed.iter().any(|(slug, cell)| *slug == entry.grid && cell.row == entry.row && cell.col == entry.col) {
            return refuse(format!("cells has {}, which #{number} does not claim", entry.name()));
        }
    }
    for (slug, cell) in &claimed {
        if cell.state != "in_progress" {
            continue;
        }
        let at = format!("{slug}.{}.{}", cell.row, cell.col);
        match entries.iter().find(|e| e.grid == *slug && e.row == cell.row && e.col == cell.col) {
            Some(entry) if entry.reason.is_some() => {}
            Some(_) => return refuse(format!("cells entry {at} needs a reason: why it has no proof")),
            None => {
                return refuse(format!(
                    "{at} is still in progress: prove it (`atelier grid prove {slug} {} {}`), ask for N/A, or list it in \
                     cells with a reason why it has no proof",
                    cell.row, cell.col
                ))
            }
        }
    }
    Ok(())
}

/// A finished task (done, or submitted for review): its in-progress cells
/// listed with a reason become gaps, and every claim is released.
pub fn finish(connection: &Connection, project: &str, number: i64, entries: &[CellRef], session: Option<&str>, actor: &str, now: i64) -> Result<Vec<String>, TaskError> {
    let mut grids = Vec::new();
    for (slug, mut cell) in claimed_by(connection, project, number)? {
        if cell.state == "in_progress" {
            if let Some(entry) = entries.iter().find(|e| e.grid == slug && e.row == cell.row && e.col == cell.col) {
                cell.state = "gap".into();
                cell.reason = entry.reason.clone();
                append_event(connection, project, &slug, now, "gap", Some((&cell.row, &cell.col)), session, actor,
                    &json!({"task": number, "reason": entry.reason}))?;
            }
        }
        cell.claimed_task = None;
        cell.claimed_from = None;
        save_cell(connection, project, &slug, &cell)?;
        append_event(connection, project, &slug, now, "released", Some((&cell.row, &cell.col)), session, actor, &json!({"task": number}))?;
        if !grids.contains(&slug) {
            grids.push(slug);
        }
    }
    Ok(grids)
}

/// A cancelled task: its claims are released and each in-progress cell goes
/// back to the state it had before the claim.
pub fn cancel(connection: &Connection, project: &str, number: i64, session: Option<&str>, actor: &str, now: i64) -> Result<Vec<String>, TaskError> {
    let mut grids = Vec::new();
    for (slug, mut cell) in claimed_by(connection, project, number)? {
        let restored = if cell.state == "in_progress" {
            cell.state = cell.claimed_from.clone().unwrap_or_else(|| "unchecked".into());
            Some(cell.state.clone())
        } else {
            None
        };
        cell.claimed_task = None;
        cell.claimed_from = None;
        save_cell(connection, project, &slug, &cell)?;
        append_event(connection, project, &slug, now, "released", Some((&cell.row, &cell.col)), session, actor,
            &json!({"task": number, "restored": restored}))?;
        if !grids.contains(&slug) {
            grids.push(slug);
        }
    }
    Ok(grids)
}

/// The cells a task claimed, with their states now, for its card.
pub fn task_cells(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT t.slug, t.row, t.col, c.state, c.claimed_task, c.reason FROM grid_task_cell t
           LEFT JOIN grid_cell c ON c.project_id = t.project_id AND c.slug = t.slug AND c.row = t.row AND c.col = t.col
          WHERE t.project_id = ?1 AND t.task = ?2 ORDER BY t.slug, t.row, t.col",
    )?;
    let rows = statement
        .query_map(params![project, number], |row| {
            Ok(json!({
                "grid": row.get::<_, String>(0)?, "row": row.get::<_, String>(1)?, "col": row.get::<_, String>(2)?,
                "state": row.get::<_, Option<String>>(3)?,
                "claimed": row.get::<_, Option<i64>>(4)? == Some(number),
                "reason": row.get::<_, Option<String>>(5)?,
            }))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/* ---------------------------------------- what to work on next, and picks */

/// Whether every one of these cells is in an approved grid, and there is at
/// least one: an agent may then create a task for them without `@task`.
pub fn all_in_approved(connection: &Connection, project: &str, cells: &[CellRef]) -> rusqlite::Result<bool> {
    if cells.is_empty() {
        return Ok(false);
    }
    let mut known: HashMap<String, bool> = HashMap::new();
    for cell in cells {
        let approved = match known.get(&cell.grid) {
            Some(approved) => *approved,
            None => {
                let approved = get_grid(connection, project, &cell.grid)?.is_some_and(|grid| grid.status == "approved");
                known.insert(cell.grid.clone(), approved);
                approved
            }
        };
        if !approved {
            return Ok(false);
        }
    }
    Ok(true)
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

/// Set `claimedChat` on each claimed cell: the chat holding the open task
/// that claims it, or null when that task has no chat.
pub fn with_claim_chats(connection: &Connection, project: &str, cells: &mut [Value]) -> rusqlite::Result<()> {
    let mut holders: HashMap<i64, Value> = HashMap::new();
    for cell in cells.iter_mut() {
        let Some(number) = cell["claimedTask"].as_i64() else { continue };
        if !holders.contains_key(&number) {
            let chat = task_holder(connection, project, number)?
                .filter(|(status, _)| open_status(status))
                .and_then(|(_, session)| session)
                .map(|session| chat_json(connection, &session))
                .unwrap_or(Value::Null);
            holders.insert(number, chat);
        }
        cell["claimedChat"] = holders[&number].clone();
    }
    Ok(())
}

/// Every cell that counts, row by row in drawn order, columns in place order.
fn live_pairs(loaded: &Loaded) -> Vec<(&GridRow, &Column, &Cell)> {
    let columns: Vec<&Column> = loaded.columns.iter().filter(|col| col.retired_at.is_none()).collect();
    let mut pairs = Vec::new();
    for row in loaded.rows.iter().filter(|row| row.counts()) {
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
    /// No open task claims it and it needs work: unchecked, a gap, or a stale proof.
    Free,
    /// An open task claims it: (task, holding chat).
    Taken(i64, Option<String>),
    /// Proved and fresh, N/A, or waiting for the owner's N/A answer.
    Settled,
}

fn standing(connection: &Connection, project: &str, slug: &str, cell: &Cell, prints: &Prints) -> rusqlite::Result<Standing> {
    if let Some((number, holder)) = open_claim(connection, project, cell)? {
        return Ok(Standing::Taken(number, holder));
    }
    Ok(match cell.state.as_str() {
        "unchecked" | "gap" | "in_progress" => Standing::Free,
        "proved" if is_stale(slug, cell, prints) => Standing::Free,
        _ => Standing::Settled,
    })
}

/// What a set of picked cells is called in a task's title and in the chat:
/// a row, a column, one cell, or a count.
pub struct Label {
    /// "Glare row", "GPU column", "Glare × GPU"; None for a mixed pick.
    pub name: Option<String>,
    pub count: usize,
    /// "gap" when only gaps were picked, else "cell".
    pub noun: &'static str,
}

impl Label {
    fn counted(&self) -> String {
        format!("{} {}{}", self.count, self.noun, if self.count == 1 { "" } else { "s" })
    }

    /// The task's title: "camera: Glare row (5 cells)", "camera: 12 gaps".
    pub fn title(&self, slug: &str) -> String {
        let title = match &self.name {
            Some(name) if self.count == 1 && name.contains('×') => format!("{slug}: {name}"),
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
/// rule), and the cells to claim.
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
            json!({"id": id, "text": format!("{row_name} × {col_name}: {rule}")})
        })
        .collect();
    json!({
        "type": "general",
        "title": label.title(slug),
        "why": clip(&format!("Close {} of the \"{}\" coverage grid.", label.counted(), loaded.grid.title), 300),
        "plan": {
            "outcome": "Each cell below is proved with `atelier grid prove`, asked to be N/A, or left as a gap with a reason at done.",
            "done_when": done_when,
        },
        "cells": picked.iter().map(|(row, col)| json!({"grid": slug, "row": row, "col": col})).collect::<Vec<_>>(),
    })
}

fn approved_grid(connection: &Connection, project: &str, slug: &str) -> Result<Loaded, TaskError> {
    let loaded = load(connection, project, slug)?
        .filter(|loaded| loaded.grid.status != "discarded")
        .ok_or_else(|| TaskError::Refused(format!("there is no grid \"{slug}\" in this project; run `atelier grid list`")))?;
    if loaded.grid.status != "approved" {
        return refuse(format!(
            "grid \"{slug}\" is a draft waiting for the owner; its cells exist once the owner approves it"
        ));
    }
    Ok(loaded)
}

/// Which part of a grid `atelier grid next` looks at.
#[derive(Clone, Debug, PartialEq)]
pub enum Scope {
    /// The first row, in drawn order, with a free cell.
    First,
    Row(String),
    Col(String),
}

/// `atelier grid next`: the free cells of one row (the first with any, or
/// the one named) or one column, the cells there other tasks hold, how many
/// free cells the whole grid has left, and a ready `task create` payload.
pub fn next_cells(connection: &Connection, project: &str, slug: &str, prints: &Prints, scope: &Scope) -> Result<Value, TaskError> {
    let loaded = approved_grid(connection, project, slug)?;
    let pairs = live_pairs(&loaded);
    let mut standings = Vec::with_capacity(pairs.len());
    for (_, _, cell) in &pairs {
        standings.push(standing(connection, project, slug, cell, prints)?);
    }
    let left = standings.iter().filter(|s| matches!(s, Standing::Free)).count();
    let taken_in_grid = standings.iter().filter(|s| matches!(s, Standing::Taken(..))).count();
    let na_pending = pairs.iter().filter(|(_, _, cell)| cell.state == "na_pending").count();
    let chosen: Option<(&str, String, String)> = match scope {
        Scope::Row(id) => {
            let row = loaded.row(id).filter(|row| row.counts()).ok_or_else(|| {
                TaskError::Refused(format!("grid \"{slug}\" has no row \"{id}\" with cells; run `atelier grid show {slug}`"))
            })?;
            Some(("row", row.id.clone(), row.name.clone()))
        }
        Scope::Col(id) => {
            let col = loaded.column(id).filter(|col| col.retired_at.is_none()).ok_or_else(|| {
                TaskError::Refused(format!("grid \"{slug}\" has no column \"{id}\"; run `atelier grid show {slug}`"))
            })?;
            Some(("col", col.id.clone(), col.name.clone()))
        }
        Scope::First => pairs
            .iter()
            .zip(&standings)
            .find(|(_, standing)| matches!(standing, Standing::Free))
            .map(|((row, _, _), _)| ("row", row.id.clone(), row.name.clone())),
    };
    let (mut claimable, mut taken, mut picked) = (Vec::new(), Vec::new(), Vec::new());
    if let Some((kind, id, _)) = &chosen {
        for ((row, col, cell), standing) in pairs.iter().zip(&standings) {
            let inside = if *kind == "row" { row.id == *id } else { col.id == *id };
            if !inside {
                continue;
            }
            match standing {
                Standing::Free => {
                    claimable.push(json!({
                        "row": row.id, "col": col.id, "rowName": row.name, "colName": col.name,
                        "state": cell.state, "stale": is_stale(slug, cell, prints), "proofRule": col.proof_rule,
                    }));
                    picked.push((row.id.clone(), col.id.clone()));
                }
                Standing::Taken(number, holder) => taken.push(json!({
                    "row": row.id, "col": col.id, "task": number,
                    "chat": holder.as_deref().map(|session| chat_json(connection, session)),
                })),
                Standing::Settled => {}
            }
        }
    }
    let create = chosen.as_ref().filter(|_| !picked.is_empty()).map(|(kind, _, name)| {
        let name = if *kind == "row" { format!("{name} row") } else { format!("{name} column") };
        task_payload(&loaded, &picked, &Label { name: Some(name), count: picked.len(), noun: "cell" })
    });
    Ok(json!({
        "grid": slug, "title": loaded.grid.title,
        "scope": chosen.as_ref().map(|(kind, id, name)| json!({"kind": kind, "id": id, "name": name})),
        "claimable": claimable, "taken": taken, "left": left, "takenInGrid": taken_in_grid, "naPending": na_pending,
        "create": create,
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

/// The cells of a pick that a new task can claim, in drawn order, with the
/// task payload for them. Refused when none can be claimed.
pub fn picked_task(connection: &Connection, project: &str, pick: &Pick, prints: &Prints) -> Result<(Value, Label), TaskError> {
    let slug = pick.slug.as_str();
    let loaded = approved_grid(connection, project, slug)?;
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
    let mut picked = Vec::new();
    for (row, col, cell) in live_pairs(&loaded) {
        if pick.rows.as_ref().is_some_and(|ids| !ids.contains(&row.id)) || pick.cols.as_ref().is_some_and(|ids| !ids.contains(&col.id)) {
            continue;
        }
        if pick.only_gaps && !matches!(cell.state.as_str(), "unchecked" | "gap") {
            continue;
        }
        if matches!(standing(connection, project, slug, cell, prints)?, Standing::Free) {
            picked.push((row.id.clone(), col.id.clone()));
        }
    }
    if picked.is_empty() {
        return refuse(format!(
            "none of the selected cells needs a task: each is proved, N/A, waiting for an N/A answer, or claimed by another \
             task{}. Select other cells",
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
    let label = Label { name, count: picked.len(), noun: if pick.only_gaps { "gap" } else { "cell" } };
    Ok((task_payload(&loaded, &picked, &label), label))
}

/// What a task's cells make up, for its card: one whole row, one whole column
/// or the whole grid, where "whole" means every other cell there is already
/// proved or N/A. `{grid, kind, id, name, count}`, or null.
pub fn claim_shape(connection: &Connection, project: &str, number: i64) -> rusqlite::Result<Value> {
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
    let pairs = live_pairs(&loaded);
    let whole = |inside: &dyn Fn(&GridRow, &Column) -> bool| {
        mine.iter().all(|(row, col)| pairs.iter().any(|(r, c, _)| r.id == *row && c.id == *col && inside(r, c)))
            && pairs.iter().filter(|(r, c, _)| inside(r, c)).all(|(r, c, cell)| {
                mine.contains(&(r.id.as_str(), c.id.as_str())) || matches!(cell.state.as_str(), "proved" | "na" | "na_pending")
            })
    };
    let rows: HashSet<&str> = mine.iter().map(|(row, _)| *row).collect();
    let cols: HashSet<&str> = mine.iter().map(|(_, col)| *col).collect();
    let shape = if rows.len() == 1 && whole(&|r, _| rows.contains(r.id.as_str())) {
        let row = loaded.row(rows.iter().next().unwrap()).unwrap();
        Some(("row", row.id.clone(), row.name.clone()))
    } else if cols.len() == 1 && whole(&|_, c| cols.contains(c.id.as_str())) {
        let col = loaded.column(cols.iter().next().unwrap()).unwrap();
        Some(("col", col.id.clone(), col.name.clone()))
    } else if rows.len() > 1 && cols.len() > 1 && whole(&|_, _| true) {
        Some(("grid", loaded.grid.slug.clone(), loaded.grid.title.clone()))
    } else {
        None
    };
    Ok(shape.map_or(Value::Null, |(kind, id, name)| {
        json!({"grid": slug, "kind": kind, "id": id, "name": name, "count": mine.len()})
    }))
}

/* ------------------------------------------------------------- reconnect */

/// What a reconnected chat is told of its grid work: drafts it is waiting
/// on, cells its open tasks claim, N/A requests it made. Empty when none.
pub fn open_lines(connection: &Connection, session: &str) -> rusqlite::Result<Vec<String>> {
    let mut lines = Vec::new();
    let mut statement = connection.prepare(
        "SELECT slug, title, pending FROM grid WHERE pending IS NOT NULL AND status <> 'discarded' ORDER BY slug",
    )?;
    let drafts: Vec<String> = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, json_column(row, 2)?)))?
        .filter_map(Result::ok)
        .filter(|(_, _, pending)| pending.as_ref().is_some_and(|p| p["draftedBy"] == session))
        .map(|(slug, title, pending)| {
            let title = pending.as_ref().and_then(|p| p["title"].as_str()).map(str::to_string).unwrap_or(title);
            format!("{slug} ({title})")
        })
        .collect();
    if !drafts.is_empty() {
        lines.push(format!("Grid drafts awaiting the owner: {}", drafts.join(", ")));
    }
    let mut statement = connection.prepare(
        "SELECT t.number, c.slug, c.row, c.col, c.state FROM task t
           JOIN grid_cell c ON c.project_id = t.project_id AND c.claimed_task = t.number
          WHERE t.session_id = ?1 AND t.status NOT IN ('done', 'cancelled') ORDER BY t.number, c.slug, c.row, c.col",
    )?;
    let mut by_task: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for found in statement.query_map([session], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?))
    })? {
        let (number, slug, row, col, state) = found?;
        by_task.entry(number).or_default().push(format!("{slug}.{row}.{col} [{state}]"));
    }
    if !by_task.is_empty() {
        let claims: Vec<String> = by_task.into_iter().map(|(number, cells)| format!("#{number} → {}", cells.join(", "))).collect();
        lines.push(format!("Cells claimed by your tasks: {}", claims.join("; ")));
    }
    let mut statement = connection.prepare(
        "SELECT c.slug, c.row, c.col FROM grid_cell c WHERE c.state = 'na_pending'
            AND (SELECT e.session_id FROM grid_event e WHERE e.project_id = c.project_id AND e.slug = c.slug
                   AND e.row = c.row AND e.col = c.col AND e.kind = 'na_asked' ORDER BY e.seq DESC LIMIT 1) = ?1
          ORDER BY c.slug, c.row, c.col",
    )?;
    let asked: Vec<String> = statement
        .query_map([session], |row| Ok(format!("{}.{}.{}", row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if !asked.is_empty() {
        lines.push(format!("N/A awaiting the owner: {}", asked.join(", ")));
    }
    Ok(lines)
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
/// selected cell with its requirement, state, reason, proof and claim.
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
            "Open cells: {} gap, {} stale, {} unchecked, {} in progress, {} N/A pending. Run `atelier grid show {}` for the matrix.",
            counts["gap"], counts["stale"], counts["unchecked"], counts["inProgress"], counts["naPending"], grid.slug
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
            if let Some(number) = cell.claimed_task {
                line.push_str(&format!("; claimed by #{number}"));
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
