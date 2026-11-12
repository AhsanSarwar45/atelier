/**
 * Checks for critical API responses.
 * Only covers endpoints where malformed data causes silent runtime errors.
 *
 * Written out by hand. These were zod schemas, and zod was 56 KB of every
 * screen's first download — the home screen and settings included — to check
 * a handful of answers (bw-fbzd.9). A bad answer still throws, naming where it went wrong.
 */

type Check = (value: unknown, at: string) => void;

/** A check with the `parse` the callers use: it throws, or hands the value back. */
export interface Schema {
  parse<T>(value: T): T;
}

function fail(at: string, expected: string, value: unknown): never {
  const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  throw new TypeError(`Invalid API response at ${at || '(root)'}: expected ${expected}, got ${got}`);
}

const string: Check = (value, at) => { if (typeof value !== 'string') fail(at, 'string', value); };
const number: Check = (value, at) => { if (typeof value !== 'number' || Number.isNaN(value)) fail(at, 'number', value); };
const boolean: Check = (value, at) => { if (typeof value !== 'boolean') fail(at, 'boolean', value); };

/** Absent, null or the thing itself. */
const nullish = (check: Check): Check => (value, at) => { if (value != null) check(value, at); };
/** Absent or the thing itself; null is refused. */
const optional = (check: Check): Check => (value, at) => { if (value !== undefined) check(value, at); };
/** Null or the thing itself; absent is refused. */
const nullable = (check: Check): Check => (value, at) => { if (value !== null) check(value, at); };

const array = (check: Check): Check => (value, at) => {
  if (!Array.isArray(value)) fail(at, 'array', value);
  for (let i = 0; i < value.length; i += 1) check(value[i], `${at}[${i}]`);
};

const either = (checks: Check[], expected: string): Check => (value, at) => {
  for (const check of checks) {
    try { check(value, at); return; } catch { /* the next one may fit */ }
  }
  fail(at, expected, value);
};

/** An object with these fields; fields not named are let through. */
const object = (fields: Record<string, Check>): Check => {
  const entries = Object.entries(fields);
  return (value, at) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(at, 'object', value);
    const record = value as Record<string, unknown>;
    for (const [name, check] of entries) check(record[name], at ? `${at}.${name}` : name);
  };
};

const schema = (check: Check): Schema => ({
  parse<T>(value: T): T {
    check(value, '');
    return value;
  },
});

/** A task (docs/tasks.md, "HTTP"): the fields every screen that draws one reads. */
const task = object({
  projectId: string,
  number: number,
  type: string,
  title: string,
  status: string,
  sessionId: nullish(string),
  plan: nullish(object({})),
  result: nullish(object({})),
});

export const TasksResponseSchema = schema(object({ tasks: array(task) }));

export const TaskDetailSchema = schema(object({
  task,
  events: array(object({ seq: number, at: number, kind: string, actor: string })),
}));

export const TaskActionResponseSchema = schema(object({ task, widget: nullish(string) }));

/** A proposal (docs/tasks.md, "Proposals"). */
const proposal = object({
  projectId: string,
  id: number,
  sessionId: string,
  type: string,
  title: string,
  status: string,
  taskNumber: nullish(number),
  plan: nullish(object({})),
});

export const ProposalResponseSchema = schema(object({ proposal }));

export const ProposalAnswerSchema = schema(object({ proposal, task: nullish(task) }));

/** A grid's summary (docs/grids.md, "HTTP"): the fields every screen that draws one reads. */
const grid = object({
  projectId: string,
  slug: string,
  title: string,
  status: string,
  percent: nullish(number),
  counts: nullish(object({})),
  pending: nullish(object({})),
});

export const GridsResponseSchema = schema(object({
  grids: array(grid),
  templates: nullish(array(object({ name: string, columns: nullish(array(object({}))) }))),
}));

const gridCell = object({ row: string, col: string, state: string });

export const GridDetailSchema = schema(object({
  grid,
  columns: array(object({ id: string, name: string })),
  rows: array(object({ id: string, name: string, kind: string })),
  cells: array(gridCell),
}));

export const CellDetailSchema = schema(object({
  cell: gridCell,
  events: array(object({ seq: number, at: number, kind: string })),
}));
