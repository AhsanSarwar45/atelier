import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TodoPanel } from '@/workbench/chat-tab';
import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { checklistForTasks } from '@/workbench/tasks/checklist';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { itemProgress } from '@/workbench/tasks/progress';
import { TaskCard } from '@/workbench/tasks/task-card';
import TasksTab from '@/workbench/tasks/tasks-tab';
import type { Task } from '@/workbench/tasks/types';

const list = vi.fn();
const get = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
    act: vi.fn(),
  },
}));
vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [{ id: 's1', state: 'idle', cwd: '/repo', name: 'Chat one' }],
}));
const feed: Array<{ frame: (data: string) => void }> = [];
vi.mock('@/workbench/live-wire', async (original) => ({
  ...(await original<typeof import('@/workbench/live-wire')>()),
  onWorkbench: (listener: { frame: (data: string) => void }) => {
    feed.push(listener);
    return () => { feed.splice(feed.indexOf(listener), 1); };
  },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const three = (extra: (id: string) => Record<string, unknown> = (id) => ({ text: `Item ${id}` })) =>
  ['a', 'b', 'c'].map((id) => ({ id, ...extra(id) }));

/**
 * One in-progress task per type with plan items: item "a" checked and met,
 * "b" checked and missed (where the type can miss), "c" still open.
 */
const CASES: Array<{ type: string; plan: Record<string, unknown>; checks: Record<string, unknown>; missed: string | null }> = [
  {
    type: 'feature',
    plan: { outcome: 'Export', criteria: three() },
    checks: { criteria: [{ id: 'a', met: true, evidence: 'clicked it' }, { id: 'b', met: false, reason: 'No printer' }] },
    missed: 'No printer',
  },
  {
    type: 'general',
    plan: { outcome: 'Tidy', done_when: three() },
    checks: { done_when: [{ id: 'a', met: true, evidence: 'ok' }, { id: 'b', met: false, reason: 'Out of scope' }] },
    missed: 'Out of scope',
  },
  {
    type: 'ui_change',
    plan: { screens: three((id) => ({ name: `Screen ${id}`, how_to_reach: 'Open it', change: 'Bigger' })) },
    checks: { screens: [{ id: 'a', before: '.atelier/a-before.png', after: '.atelier/a-after.png' }] },
    missed: null,
  },
  {
    type: 'visual_bug',
    plan: { symptom: 'Blurry', repro_steps: ['Open it'], expected: 'Sharp', actual: 'Blurry', screens: three((id) => ({ name: `Screen ${id}`, how_to_reach: 'Open it' })) },
    checks: { screens: [{ id: 'a', before: '.atelier/a-before.png', after: '.atelier/a-after.png' }] },
    missed: null,
  },
  {
    type: 'render_change',
    plan: { scenes: three((id) => ({ scene: `Scene ${id}`, camera: 'front', change: 'Softer shadows' })) },
    checks: { scenes: [{ id: 'a', before: '.atelier/a-before.png', after: '.atelier/a-after.png' }] },
    missed: null,
  },
  {
    type: 'investigation',
    plan: { questions: three() },
    checks: { answers: [{ id: 'a', answer: 'Because of the cache' }] },
    missed: null,
  },
  {
    type: 'refactor',
    plan: { invariants: three(), scope: 'src' },
    checks: { invariants: [{ id: 'a', how_verified: 'tests pass' }] },
    missed: null,
  },
  {
    type: 'tests',
    plan: { behaviors: three() },
    checks: { behaviors: [
      { id: 'a', test_path: 't.ts', test_name: 'a', fails_without_code: true },
      { id: 'b', test_path: 't.ts', test_name: 'b', fails_without_code: false, reason: 'Already covered' },
    ] },
    missed: 'Already covered',
  },
  {
    type: 'qa',
    plan: { scenarios: three((id) => ({ steps: ['Go'], expected: `Works ${id}` })) },
    checks: { scenarios: [{ id: 'a', passed: true, evidence: 'seen' }, { id: 'b', passed: false, notes: 'Crashes on save' }] },
    missed: 'Crashes on save',
  },
  {
    type: 'docs',
    plan: { pages: three((id) => ({ path: `docs/${id}.md`, change: 'Explain' })) },
    checks: { pages: [{ id: 'a', what_changed: 'Wrote it' }] },
    missed: null,
  },
  {
    type: 'chore',
    plan: { steps: three() },
    checks: { steps: [{ id: 'a', done: true, output: 'done' }, { id: 'b', done: false, reason: 'No access' }] },
    missed: 'No access',
  },
];

const working = (over: Partial<Task>) => makeTask({ status: 'in_progress', sessionId: 's1', ...over });
const states = (root: HTMLElement) =>
  Object.fromEntries(within(root).getAllByTestId('task-plan-item').map((row) => [row.getAttribute('data-item'), row.getAttribute('data-met')]));

beforeEach(() => {
  list.mockReset();
  get.mockReset();
  feed.length = 0;
});

describe('plan items ticked while a task is in progress', () => {
  it.each(CASES)('$type: checked items are ticked or missed, the rest open', ({ type, plan, checks, missed }) => {
    render(<TaskCard task={working({ type: type as Task['type'], plan, checks })} />);
    const card = screen.getByTestId('task-card');
    expect(states(card)).toEqual({ a: 'yes', b: missed ? 'no' : 'pending', c: 'pending' });
    if (missed) expect(within(card).getByText(missed)).toBeVisible();
    expect(itemProgress({ type, plan, result: null, checks }).map((i) => i.state)).toEqual(['met', missed ? 'missed' : 'open', 'open']);
  });

  it('optimization: measured targets read as the before and after table', () => {
    const plan = { targets: [
      { id: 'load', name: 'Load', metric: 'ms', unit: 'ms', baseline: 900, target: 300, higher_is_better: false },
      { id: 'size', name: 'Size', metric: 'kB', unit: 'kB', baseline: 500, target: 200, higher_is_better: false },
      { id: 'fps', name: 'FPS', metric: 'fps', unit: 'fps', baseline: 30, target: 60, higher_is_better: true },
    ] };
    const checks = { targets: [
      { id: 'load', before: 900, after: 250, runs: 5 },
      { id: 'size', before: 500, after: 420, runs: 3, failure_reason: 'Fonts are the bulk' },
    ] };
    render(<TaskCard task={working({ type: 'optimization', plan, checks })} />);
    const rows = screen.getAllByTestId('optimization-row');
    expect(rows.map((r) => r.getAttribute('data-met'))).toEqual(['yes', 'no', 'pending']);
    expect(screen.getByText('Fonts are the bulk')).toBeVisible();
  });

  it.each(['ui_change', 'visual_bug', 'render_change'])('%s: a checked item shows its before and after behind a toggle', (type) => {
    const { plan, checks } = CASES.find((c) => c.type === type)!;
    render(<TaskCard task={working({ type, plan, checks })} />);
    const a = screen.getAllByTestId('task-plan-item').find((row) => row.getAttribute('data-item') === 'a')!;
    expect(within(a).queryByTestId('image-comparison')).toBeNull();
    fireEvent.click(within(a).getByTestId('task-images-toggle'));
    expect(within(a).getByTestId('image-comparison')).toBeInTheDocument();
    expect(within(a).getByAltText(/before$/)).toHaveAttribute('src', '/api/fs/media?path=%2Frepo%2F.atelier%2Fa-before.png');
  });

  it('a card follows a new check without being read again', () => {
    const { plan, checks } = CASES[0]!;
    const { rerender } = render(<TaskCard task={working({ plan, checks })} />);
    expect(states(screen.getByTestId('task-card')).c).toBe('pending');
    const more = { criteria: [...(checks.criteria as unknown[]), { id: 'c', met: true, evidence: 'done' }] };
    rerender(<TaskCard task={working({ plan, checks: more })} />);
    expect(states(screen.getByTestId('task-card')).c).toBe('yes');
  });

  it("a check is one line in a chat, naming the item and how it came out", () => {
    const { plan, checks } = CASES[0]!;
    const task = working({ title: 'Export', plan, checks });
    const { unmount } = render(<ChatWidgetView widget={{ type: 'task', event: 'check', task, detail: { item: 'b', met: false, reason: 'No printer' } }} />);
    expect(screen.queryByTestId('task-card')).toBeNull();
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Checked “Item b” — missed: No printer');
    expect(screen.queryByTestId('task-plan-item')).toBeNull();
    unmount();
    // A card printed before the change carried what it recorded.
    render(<ChatWidgetView widget={{ type: 'task', event: 'check', task }} />);
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Checked a plan item');
  });

  it('the Tasks tab detail ticks a new check live, and its history says which item', async () => {
    const { plan, checks } = CASES[0]!;
    const before = working({ number: 2, title: 'Export', plan, checks });
    const after = working({ number: 2, title: 'Export', plan, checks: { criteria: [...(checks.criteria as unknown[]), { id: 'c', met: true }] }, updatedAt: 2 });
    list.mockResolvedValue([before]);
    get.mockResolvedValue({ task: before, events: [
      { seq: 1, at: 1_700_000_000_000, kind: 'checked', sessionId: 's1', actor: 'agent', payload: { item: 'b', met: false, reason: 'No printer' } },
    ] });
    render(<TasksTab projectId="p1" />);
    fireEvent.click(await screen.findByText('Export'));
    const detail = await screen.findByTestId('task-detail');
    expect(states(detail)).toEqual({ a: 'yes', b: 'no', c: 'pending' });
    // The chat row's words, with the item's text rather than its id.
    await waitFor(() => expect(within(detail).getByTestId('task-history')).toHaveTextContent('Checked “Item b” — missed: No printer'));

    list.mockResolvedValue([after]);
    get.mockResolvedValue({ task: after, events: [] });
    feed.forEach((l) => l.frame(JSON.stringify({ type: 'tasks.changed', projectId: 'p1', number: 2 })));
    await waitFor(() => expect(states(screen.getByTestId('task-detail')).c).toBe('yes'));
  });
});

describe("the chat's checklist", () => {
  const { plan, checks } = CASES[0]!;

  it('lists the plan items of the task being worked on, ticked, missed or open', () => {
    const items = checklistForTasks([
      working({ number: 1, title: 'Export', plan, checks }),
      makeTask({ number: 2, title: 'Later', status: 'todo', plan }),
    ], 's1', 'idle', 1);
    expect(items[0]!.items).toEqual([
      { id: 'a', text: 'Item a', state: 'met', note: '' },
      { id: 'b', text: 'Item b', state: 'missed', note: 'No printer' },
      { id: 'c', text: 'Item c', state: 'open', note: '' },
    ]);
    expect(items[1]!.items).toBeUndefined();
    // Every task with plan items shows how far it has come.
    expect(items.map((item) => item.progress)).toEqual([{ met: 1, total: 3 }, { met: 0, total: 3 }]);

    render(<TodoPanel items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }));
    const rows = screen.getAllByTestId('todo-plan-item');
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['met', 'missed', 'open']);
    expect(within(rows[1]!).getByTestId('todo-plan-item-note')).toHaveTextContent('No printer');
    expect(screen.getAllByTestId('todo-progress').map((count) => count.textContent)).toEqual(['1/3', '0/3']);
  });

  it('opens a task from its row, by click or keyboard', () => {
    const onOpen = vi.fn();
    const items = checklistForTasks([working({ number: 4, title: 'Export', plan, checks })], 's1', 'idle', 1);
    render(<TodoPanel items={items} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }));
    const open = screen.getByRole('button', { name: /#4 Export/ });
    expect(open.tagName).toBe('BUTTON');
    expect(open.className).toContain('cursor-pointer');
    open.focus();
    expect(open).toHaveFocus();
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith(4);
  });
});
