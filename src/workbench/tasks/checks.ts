/**
 * A plan's checks and what the server measured of them (docs/tasks.md,
 * "Checks").
 *
 * Each plan item may carry `checks`: commands the owner approves with the
 * plan, run by the server and never by the agent's word. `bug`, `plan` and
 * `review` keep theirs in the plan's own `checks`, recorded under the item id
 * `plan`. The task carries what the server ran (`checkRuns`), which items its
 * checks tick (`checkMet`), each benchmark's start-of-task baseline
 * (`checkBaseline`), and what it found suspicious (`checkFlags`). Read loosely,
 * like the rest of the card.
 */

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(rec) : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export type CheckKind = 'test' | 'benchmark' | 'structure' | 'characterisation';

export interface CheckBudget { max?: number; improve_pct?: number; unit?: string }

export interface Check {
  name: string;
  command: string;
  kind: CheckKind | string;
  given: string;
  when: string;
  then: string;
  red?: string;
  timeout_s?: number;
  files: string[];
  bench?: { value?: string; runs?: number; warmup?: number; budget?: CheckBudget };
}

/** One run of a check, as the server recorded it. */
export interface CheckRun {
  command: string;
  exit: number | null;
  passed: boolean;
  outputTail: string;
  commit?: string;
  at?: number;
  ms?: number;
  samples?: number[];
  value?: number;
  reason?: string;
  /** `start` is the red run at task start; `check`, `done` and `amend` are later. */
  phase?: 'start' | 'check' | 'done' | 'amend' | string;
  name?: string;
}

export type CheckFlagKind = 'weak' | 'proves-nothing' | 'skip-added' | 'exit-in-test' | 'test-deleted' | 'hash-changed' | string;

/** Something about a check worth the owner's eye. It informs and never refuses. */
export interface CheckFlag { kind: CheckFlagKind; text: string; item?: string; check?: string }

export type CheckRuns = Record<string, Record<string, CheckRun>>;
export type CheckBaseline = Record<string, Record<string, { p50: number; samples?: number[] }>>;

/** The item id the plan's own `checks` are recorded under. */
export const PLAN_ITEM = 'plan';

export function readCheck(value: unknown): Check {
  const c = rec(value);
  const bench = rec(c.bench);
  const budget = rec(bench.budget);
  return {
    name: str(c.name),
    command: str(c.command),
    kind: str(c.kind) || 'test',
    given: str(c.given),
    when: str(c.when),
    then: str(c.then),
    red: str(c.red) || undefined,
    timeout_s: num(c.timeout_s) ?? undefined,
    files: strings(c.files),
    bench: c.bench ? {
      value: str(bench.value) || undefined,
      runs: num(bench.runs) ?? undefined,
      warmup: num(bench.warmup) ?? undefined,
      budget: c.bench && bench.budget ? { max: num(budget.max) ?? undefined, improve_pct: num(budget.improve_pct) ?? undefined, unit: str(budget.unit) || undefined } : undefined,
    } : undefined,
  };
}

/** A plan item's checks (or the plan's own, given the plan). */
export function itemChecks(item: unknown): Check[] {
  return list(rec(item).checks).map(readCheck);
}

/** Every item's checks in a plan, by item id, the plan's own under `plan`. */
export function planChecks(plan: unknown, listKey: string | undefined): Map<string, Check[]> {
  const found = new Map<string, Check[]>();
  const p = rec(plan);
  if (listKey) {
    for (const item of list(p[listKey])) {
      const checks = itemChecks(item);
      if (checks.length) found.set(str(item.id), checks);
    }
  }
  const own = itemChecks(p);
  if (own.length) found.set(PLAN_ITEM, own);
  return found;
}

/** Whether any item of a plan carries checks. */
export function planHasChecks(plan: unknown, listKey: string | undefined): boolean {
  return planChecks(plan, listKey).size > 0;
}

const KIND_LABEL: Record<string, string> = {
  test: 'Test', benchmark: 'Benchmark', structure: 'Structure', characterisation: 'Characterisation',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? (kind ? `${kind[0]!.toUpperCase()}${kind.slice(1)}` : 'Test');
}

const clause = (text: string): string => text.trim().replace(/[.\s]+$/, '');
const lower = (text: string): string => (text ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text);

/** "Given calc.sh is loaded, when sub 7 4 runs, then it prints 3." */
export function checkSentence(check: Pick<Check, 'given' | 'when' | 'then'>): string {
  const parts = [
    check.given && `Given ${lower(clause(check.given))}`,
    check.when && `when ${lower(clause(check.when))}`,
    check.then && `then ${lower(clause(check.then))}`,
  ].filter(Boolean);
  if (!parts.length) return '';
  const said = parts.join(', ');
  return `${said[0]!.toUpperCase()}${said.slice(1)}.`;
}

export function readRun(value: unknown): CheckRun | null {
  const r = rec(value);
  if (!Object.keys(r).length) return null;
  return {
    command: str(r.command),
    exit: num(r.exit),
    passed: r.passed === true,
    outputTail: str(r.outputTail),
    commit: str(r.commit) || undefined,
    at: num(r.at) ?? undefined,
    ms: num(r.ms) ?? undefined,
    samples: Array.isArray(r.samples) ? r.samples.filter((s): s is number => typeof s === 'number') : undefined,
    value: num(r.value) ?? undefined,
    reason: str(r.reason) || undefined,
    phase: str(r.phase) || undefined,
    name: str(r.name) || undefined,
  };
}

/** One item's runs, by check name. */
export function itemRuns(runs: unknown, itemId: string): Map<string, CheckRun> {
  const found = new Map<string, CheckRun>();
  for (const [name, value] of Object.entries(rec(rec(runs)[itemId]))) {
    const run = readRun(value);
    if (run) found.set(name, run);
  }
  return found;
}

/**
 * A run that says how the check stands on the work: not the red run at the
 * start, which fails on purpose.
 */
export function measured(run: CheckRun | undefined): run is CheckRun {
  return !!run && run.phase !== 'start';
}

export interface CheckTally {
  passed: number;
  total: number;
  /** Whether any check has run on the work yet (the red runs at start do not count). */
  ran: boolean;
}

/** How many of an item's checks pass, from the runs since start. */
export function tally(checks: readonly Check[], runs: ReadonlyMap<string, CheckRun>): CheckTally {
  let passed = 0;
  let ran = false;
  for (const check of checks) {
    const run = runs.get(check.name);
    if (!measured(run)) continue;
    ran = true;
    if (run.passed) passed += 1;
  }
  return { passed, total: checks.length, ran };
}

/** "2 of 3 checks pass", "1 of 1 check passes", or "3 checks" before any ran. */
export function tallyLine({ passed, total, ran }: CheckTally): string {
  if (!ran) return `${total} ${total === 1 ? 'check' : 'checks'}`;
  return `${passed} of ${total} ${total === 1 ? 'check passes' : 'checks pass'}`;
}

export function readFlags(value: unknown): CheckFlag[] {
  return list(value).map((f) => ({
    kind: str(f.kind),
    text: str(f.text),
    item: str(f.item) || undefined,
    check: str(f.check) || undefined,
  })).filter((f) => f.kind || f.text);
}

/** The flags about one item; `undefined` for the ones about the task as a whole. */
export function flagsFor(flags: readonly CheckFlag[], itemId: string | undefined): CheckFlag[] {
  return flags.filter((flag) => flag.item === itemId);
}

const FLAG_LABEL: Record<string, string> = {
  'weak': 'Weak check',
  'proves-nothing': 'Proves nothing',
  'skip-added': 'Skip added',
  'exit-in-test': 'Exit call in a test',
  'test-deleted': 'Test deleted',
  'hash-changed': 'Approved check file changed',
};

/** A flag's short name: "Proves nothing: export/b", "Skip added". */
export function flagTitle(flag: CheckFlag): string {
  const label = FLAG_LABEL[flag.kind] ?? (flag.kind || 'Flag');
  const where = flag.item && flag.check ? `${flag.item}/${flag.check}` : flag.check || '';
  return where ? `${label}: ${where}` : label;
}

/** The flags that say the work may not prove what it claims, before the lint's notes on how the checks were written. */
export function sortedFlags(flags: readonly CheckFlag[]): CheckFlag[] {
  return [...flags.filter((f) => f.kind !== 'weak'), ...flags.filter((f) => f.kind === 'weak')];
}

const round = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, ''));

/** A benchmark's budget in words: "at most 5 ms", "20% under the baseline". */
export function budgetText(check: Check): string {
  const budget = check.bench?.budget;
  if (!budget) return '';
  const unit = budget.unit ? ` ${budget.unit}` : '';
  if (budget.max !== undefined) return `at most ${round(budget.max)}${unit}`;
  if (budget.improve_pct !== undefined) return `${round(budget.improve_pct)}% under the baseline`;
  return '';
}

/**
 * A benchmark against its budget: "3 ms · budget at most 5 ms · baseline p50
 * 12 ms". Empty for a check that is not a benchmark.
 */
export function benchLine(check: Check, run: CheckRun | undefined, baseline: { p50: number } | undefined): string {
  if (check.kind !== 'benchmark') return '';
  const unit = check.bench?.budget?.unit ? ` ${check.bench.budget.unit}` : '';
  const parts: string[] = [];
  if (measured(run) && run.value !== undefined) parts.push(`${round(run.value)}${unit}`);
  const budget = budgetText(check);
  if (budget) parts.push(`budget ${budget}`);
  if (baseline && Number.isFinite(baseline.p50)) parts.push(`baseline p50 ${round(baseline.p50)}${unit}`);
  return parts.join(' · ');
}

export function baselineFor(baseline: unknown, itemId: string, check: string): { p50: number } | undefined {
  const found = rec(rec(rec(baseline)[itemId])[check]);
  const p50 = num(found.p50);
  return p50 === null ? undefined : { p50 };
}

/* ------------------------------------------------------------------ amend */

const CHECK_FIELDS: Array<keyof Check> = ['command', 'kind', 'given', 'when', 'then', 'red', 'files', 'timeout_s', 'bench'];

export interface CheckChange { name: string; fields: string[]; before: Check; after: Check }

export interface ItemCheckDiff {
  id: string;
  added: Check[];
  removed: Check[];
  changed: CheckChange[];
}

const FIELD_NAME: Record<string, string> = {
  command: 'command', kind: 'kind', given: 'given', when: 'when', then: 'then', red: 'red pattern',
  files: 'files', timeout_s: 'timeout', bench: 'benchmark',
};

export function checkFieldName(key: string): string {
  return FIELD_NAME[key] ?? key;
}

/**
 * The checks an amend adds, removes and changes, item by item, matched by
 * name. Items with no change to their checks are left out.
 */
export function checkDiff(plan: unknown, amend: unknown, listKey: string | undefined): ItemCheckDiff[] {
  const before = planChecks(plan, listKey);
  const after = planChecks(amend, listKey);
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const diffs: ItemCheckDiff[] = [];
  for (const id of ids) {
    const was = new Map((before.get(id) ?? []).map((c) => [c.name, c]));
    const now = new Map((after.get(id) ?? []).map((c) => [c.name, c]));
    const diff: ItemCheckDiff = { id, added: [], removed: [], changed: [] };
    for (const [name, check] of now) {
      const old = was.get(name);
      if (!old) { diff.added.push(check); continue; }
      const fields = CHECK_FIELDS.filter((key) => JSON.stringify(old[key] ?? null) !== JSON.stringify(check[key] ?? null)).map(String);
      if (fields.length) diff.changed.push({ name, fields, before: old, after: check });
    }
    for (const [name, check] of was) if (!now.has(name)) diff.removed.push(check);
    if (diff.added.length || diff.removed.length || diff.changed.length) diffs.push(diff);
  }
  return diffs;
}

/** A plan with every item's checks taken out, to compare what else changed. */
export function withoutChecks(plan: unknown, listKey: string | undefined): unknown {
  const p = rec(plan);
  if (!Object.keys(p).length) return plan;
  const copy: Loose = { ...p };
  delete copy.checks;
  if (listKey && Array.isArray(p[listKey])) {
    copy[listKey] = (p[listKey] as unknown[]).map((item) => {
      const i = rec(item);
      if (!('checks' in i)) return item;
      const { checks: _checks, ...rest } = i;
      return rest;
    });
  }
  return copy;
}
