import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { checkDiff, checkSentence, benchLine, flagTitle, readCheck, tally, tallyLine, itemRuns } from '@/workbench/tasks/checks';
import { eventText } from '@/workbench/tasks/task-event-row';
import { itemProgress, withCheckedEntries } from '@/workbench/tasks/progress';
import { AmendDiff, ProposalCard, TaskCard } from '@/workbench/tasks/task-card';
import type { Task, TaskProposal } from '@/workbench/tasks/types';

vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: {
    act: vi.fn(), list: vi.fn(async () => []), get: vi.fn(),
    proposal: vi.fn(() => new Promise(() => {})), answerProposal: vi.fn(),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', state: 'idle', cwd: '/repo' }],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const check = (name: string, over: Record<string, unknown> = {}) => ({
  name, command: `sh tests/${name}.sh`, kind: 'test', given: 'calc.sh is loaded', when: `${name} runs`, then: 'it prints the answer',
  red: `${name}: expected`, files: [`tests/${name}.sh`], ...over,
});

const plan = {
  outcome: 'calc.sh offers sub, mul and div.',
  criteria: [
    { id: 'ops', text: 'sub, mul and div give the right answers', checks: [check('sub'), check('mul'), check('div')] },
    { id: 'speed', text: 'add stays under 5 ms', checks: [check('add-time', {
      kind: 'benchmark', command: 'sh bench.sh', bench: { value: 'ms=([0-9.]+)', runs: 10, warmup: 1, budget: { max: 5, unit: 'ms' } },
    })] },
  ],
};

const run = (passed: boolean, over: Record<string, unknown> = {}) => ({
  command: 'sh x', exit: passed ? 0 : 1, passed, outputTail: passed ? 'ok' : "div: expected 3 from div 12 4, got 'command not found'",
  commit: 'abc', at: 1, ms: 1, phase: 'check', ...(passed ? {} : { reason: 'fails (exit 1): div: expected 3' }), ...over,
});

const inProgress = makeTask({
  status: 'in_progress', plan, checked: true,
  checks: { criteria: [{ id: 'speed', met: true, checks: ['add-time'] }] },
  checkRuns: {
    ops: { sub: run(true), mul: run(true), div: run(false) },
    speed: { 'add-time': run(true, { value: 3, samples: [3, 3] }) },
  },
  checkMet: { ops: false, speed: true },
  checkBaseline: { speed: { 'add-time': { p50: 12, samples: [12] } } },
});

describe('checks logic', () => {
  it('reads a check as one Given/When/Then sentence', () => {
    expect(checkSentence(readCheck(check('sub', { when: 'Sub 7 4 runs.' })))).toBe('Given calc.sh is loaded, when sub 7 4 runs, then it prints the answer.');
  });

  it('counts only the runs since start, so the red run at start is not a failure', () => {
    const checks = plan.criteria[0]!.checks.map(readCheck);
    expect(tallyLine(tally(checks, itemRuns({ ops: { sub: run(false, { phase: 'start' }) } }, 'ops')))).toBe('3 checks');
    expect(tallyLine(tally(checks, itemRuns(inProgress.checkRuns, 'ops')))).toBe('2 of 3 checks pass');
  });

  it('puts a benchmark against its budget and baseline', () => {
    const bench = readCheck(plan.criteria[1]!.checks[0]);
    expect(benchLine(bench, itemRuns(inProgress.checkRuns, 'speed').get('add-time'), { p50: 12 })).toBe('3 ms · budget at most 5 ms · baseline p50 12 ms');
  });

  it('names a flag by kind and where', () => {
    expect(flagTitle({ kind: 'proves-nothing', text: '', item: 'export', check: 'b' })).toBe('Proves nothing: export/b');
    expect(flagTitle({ kind: 'skip-added', text: 'tests/x.rs adds a skip' })).toBe('Skip added');
  });

  it('ticks a checked item only by checkMet, with its tally', () => {
    const items = itemProgress(inProgress);
    expect(items.map((i) => [i.id, i.state])).toEqual([['ops', 'open'], ['speed', 'met']]);
    expect(items[0]!.checks).toEqual({ passed: 2, total: 3, ran: true });
  });

  it('gives a checked done result an entry for each met item', () => {
    const done = { ...inProgress, type: 'chore', plan: { steps: [{ id: 'a', text: 'A', checks: [check('a')] }] }, checkMet: { a: true }, result: { summary: 'x' } };
    expect(withCheckedEntries(done)).toMatchObject({ steps: [{ id: 'a', done: true }] });
  });
});

describe('screen 1: plan items fold their checks', () => {
  const proposal: TaskProposal = {
    projectId: 'p1', id: 5, sessionId: 's1', type: 'feature', title: 'Calculator gains mod', why: 'Scripts need it',
    plan: { outcome: 'mod', criteria: [{ id: 'mod', text: 'mod gives the remainder', checks: [check('mod'), check('mod-defined', { red: '.*' })] }] },
    status: 'pending', taskNumber: null, createdAt: 1, decidedAt: null,
    checkFlags: [{ kind: 'weak', item: 'mod', check: 'mod-defined', text: '"mod-defined" has red /.*/, which matches any output' }],
  };

  it('shows "2 checks" folded, a weak flag beside the item, and one Create task', () => {
    render(<ProposalCard proposal={proposal} />);
    const item = screen.getByTestId('task-plan-item');
    expect(within(item).getByTestId('item-checks-tally')).toHaveTextContent('2 checks');
    expect(within(item).queryByTestId('check')).toBeNull();
    expect(within(item).getByTestId('check-flag')).toHaveTextContent('matches any output');
    expect(screen.getAllByRole('button', { name: 'Create task' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('unfolds to each check: name, kind, sentence, command and files', () => {
    render(<ProposalCard proposal={proposal} />);
    fireEvent.click(screen.getByTestId('item-checks-toggle'));
    const first = screen.getAllByTestId('check')[0]!;
    expect(first).toHaveTextContent('mod');
    expect(first).toHaveTextContent('Test');
    expect(first).toHaveTextContent('Given calc.sh is loaded, when mod runs, then it prints the answer.');
    expect(within(first).getByTestId('check-command')).toHaveTextContent('sh tests/mod.sh');
    expect(first).toHaveTextContent('Files: tests/mod.sh');
  });

  it('draws the plan’s own checks for a bug', () => {
    render(<TaskCard task={makeTask({ type: 'bug', plan: { symptom: 's', repro_steps: [], expected: 'e', actual: 'a', checks: [check('repro')] } })} />);
    expect(screen.getByTestId('plan-checks')).toHaveTextContent('1 check');
  });
});

describe('screen 2: an in-progress task shows how many checks pass', () => {
  it('tallies each item with a dot per check, ticks only the met one', () => {
    render(<TaskCard task={inProgress} />);
    const [ops, speed] = screen.getAllByTestId('task-plan-item');
    expect(ops).toHaveAttribute('data-met', 'pending');
    expect(within(ops!).getByTestId('item-checks-tally')).toHaveTextContent('2 of 3 checks pass');
    expect(within(ops!).getAllByTestId('check-dot').map((d) => d.getAttribute('data-state'))).toEqual(['pass', 'pass', 'fail']);
    expect(speed).toHaveAttribute('data-met', 'yes');
  });

  it('unfolds a failed check to its reason and output', () => {
    render(<TaskCard task={inProgress} />);
    fireEvent.click(screen.getAllByTestId('item-checks-toggle')[0]!);
    const div = screen.getAllByTestId('check').find((c) => c.getAttribute('data-check') === 'div')!;
    expect(within(div).getByTestId('check-reason')).toHaveTextContent('fails (exit 1)');
    expect(within(div).getByTestId('check-output')).toHaveTextContent('command not found');
  });

  it('shows a benchmark against its budget and the baseline p50', () => {
    render(<TaskCard task={inProgress} />);
    fireEvent.click(screen.getAllByTestId('item-checks-toggle')[1]!);
    expect(screen.getByTestId('check-bench')).toHaveTextContent('3 ms · budget at most 5 ms · baseline p50 12 ms');
  });

  it('says the tally on a check line in a chat', () => {
    expect(eventText('check', inProgress, { item: 'ops', met: false, passed: 2, total: 3, reason: '"div" fails' }))
      .toBe('Checked “sub, mul and div give the right answers” — 2 of 3 checks pass: "div" fails');
  });
});

describe('screen 3: the review card lists the flags before its buttons', () => {
  const review: Task = makeTask({
    status: 'review', type: 'feature', plan: { outcome: 'o', criteria: [{ id: 'export', text: 'Export', checks: [check('b')] }] },
    checked: true, checkMet: { export: true },
    result: { summary: 'done' },
    checkFlags: [
      { kind: 'weak', item: 'export', check: 'b', text: 'no red pattern' },
      { kind: 'proves-nothing', item: 'export', check: 'b', text: '"b" still passes with the task\'s changes undone' },
      { kind: 'skip-added', text: 'tests/x.rs adds a skip' },
    ],
    testCommandRun: { name: 'test_command', command: 'cargo test', exit: 0, passed: true, outputTail: 'ok', phase: 'done' },
  });

  it('lists every flag, the serious ones first, and the test command, before Approve', () => {
    render(<TaskCard task={review} />);
    const panel = screen.getByTestId('task-check-flags');
    expect(within(panel).getAllByTestId('task-check-flag').map((f) => f.getAttribute('data-kind'))).toEqual(['proves-nothing', 'skip-added', 'weak']);
    expect(panel).toHaveTextContent('Proves nothing: export/b');
    expect(within(panel).getByTestId('test-command-run')).toHaveTextContent('Test command passed');
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(panel.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('counts the met items from the checks, not from missing entries', () => {
    render(<TaskCard task={review} />);
    expect(screen.getByTestId('task-done-counts')).toHaveTextContent('1 of 1 met');
  });
});

describe('screen 4: a plan change shows its reason and the checks it changes', () => {
  const before = { outcome: 'o', criteria: [{ id: 'mod', text: 'mod', checks: [check('mod')] }, { id: 'div', text: 'div', checks: [check('div')] }] };
  const after = {
    outcome: 'o',
    criteria: [
      { id: 'mod', text: 'mod', checks: [check('mod', { command: 'sh tests/mod.sh 7 3' }), check('mod-negative')] },
      { id: 'div', text: 'div', checks: [check('div-exact')] },
    ],
  };

  it('diffs checks by name, item by item', () => {
    const diff = checkDiff(before, after, 'criteria');
    expect(diff.map((d) => [d.id, d.added.map((c) => c.name), d.removed.map((c) => c.name), d.changed.map((c) => `${c.name}:${c.fields}`)]))
      .toEqual([['mod', ['mod-negative'], [], ['mod:command']], ['div', ['div-exact'], ['div'], []]]);
  });

  it('draws the reason and each added, removed and changed check, not the raw checks field', () => {
    render(<AmendDiff type="feature" plan={before} amend={after} reason="mod of a negative was not covered" />);
    expect(screen.getByTestId('task-amend-reason')).toHaveTextContent('mod of a negative was not covered');
    expect(screen.getAllByTestId('amend-check').map((c) => c.getAttribute('data-change'))).toEqual(['added', 'changed', 'added', 'removed']);
    expect(screen.queryByText(/Changed: checks/)).toBeNull();
    expect(screen.getByText('sh tests/mod.sh 7 3')).toBeInTheDocument();
  });
});
