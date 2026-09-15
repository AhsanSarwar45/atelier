/**
 * Checks for critical API responses.
 * Only covers endpoints where malformed data causes silent runtime errors.
 *
 * Written out by hand. These were zod schemas, and zod was 56 KB of every
 * screen's first download — the home screen and settings included — to check
 * four answers, and it walked every field of every card on each board poll
 * (bw-fbzd.9). A bad answer still throws, naming where it went wrong.
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

const comment = object({
  id: either([number, string], 'number or string'),
  issue_id: string,
  author: string,
  text: string,
  created_at: string,
});

const strings = array(string);

const bead = object({
  id: string,
  title: string,
  description: nullish(string),
  status: string,
  priority: nullish(number),
  issue_type: nullish(string),
  owner: nullish(string),
  created_at: nullish(string),
  updated_at: nullish(string),
  comments: nullish(array(comment)),
  // A brief board read carries how many comments a card has instead of them (bw-fbzd.7).
  comment_count: nullish(number),
  parent_id: nullish(string),
  children: nullish(strings),
  design: nullish(string),
  notes: nullish(string),
  deps: nullish(strings),
  blockers: nullish(strings),
  relates_to: nullish(strings),
  labels: nullish(strings),
  _originalStatus: nullish(string),
  close_reason: nullish(string),
  closed_at: nullish(string),
  created_by: nullish(string),
});

export const CommentSchema = schema(comment);

export const BeadSchema = schema(bead);

export const BeadsResponseSchema = schema(object({
  beads: array(bead),
  source: optional(string),
}));

export const CardStatusesResponseSchema = schema(object({
  beads: array(object({
    id: string,
    status: string,
    updated_at: nullish(string),
    dropped: optional(boolean),
  })),
  source: optional(string),
}));

export const CardResponseSchema = schema(object({
  bead,
  source: optional(string),
}));

export const WorktreeStatusSchema = schema(object({
  exists: boolean,
  worktree_path: nullable(string),
  branch: nullable(string),
  ahead: number,
  behind: number,
  dirty: boolean,
  last_modified: nullable(string),
}));
