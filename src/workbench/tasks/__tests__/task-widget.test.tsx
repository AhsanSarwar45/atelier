import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { presentableWidget, widget, widgetSpecs, type ChatWidget } from '@/workbench/chat-widgets';
import type { TranscriptTool } from '@/workbench/fold';
import { ranThePresenter, withPresented } from '@/workbench/presented';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { ComposerPrefillContext } from '@/workbench/tasks/composer-prefill';
import { TaskCard } from '@/workbench/tasks/task-card';
import type { Task, TaskWidget } from '@/workbench/tasks/types';
import { LiveTasksContext, byNumber } from '@/workbench/tasks/use-tasks';

const act = vi.fn();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  tasks: { act: (...args: unknown[]) => act(...args), list: vi.fn(async () => []), get: vi.fn() },
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

beforeEach(() => act.mockReset());

const card = (task: Partial<Task>, event = 'create'): TaskWidget => ({ type: 'task', event, task: makeTask(task) });

const optimization = card({
  number: 4,
  type: 'optimization',
  title: 'Faster board load',
  status: 'done',
  shortfalls: true,
  plan: {
    targets: [
      { id: 'load', name: 'Board load', metric: 'p50', unit: 'ms', baseline: 900, target: 400, how_measured: 'bench', environment: 'laptop' },
      { id: 'fps', name: 'Scroll', metric: 'fps', unit: 'fps', baseline: 30, target: 60, how_measured: 'trace', environment: 'laptop', higher_is_better: true },
    ],
  },
  result: {
    summary: 'Cached the index.',
    method: 'Ran the bench ten times',
    targets: [
      { id: 'load', before: 900, after: 350, runs: 10, why_faster: 'The index is cached' },
      { id: 'fps', before: 30, after: 48, runs: 5, failure_reason: 'Layout still thrashes' },
    ],
    commits: ['abcdef1234567890'],
    followups: [{ type: 'bug', title: 'Fix the layout thrash', why: 'Scroll is still slow' }],
  },
});

const uiChange = card({
  number: 5,
  type: 'ui_change',
  title: 'New header',
  status: 'review',
  plan: { screens: [{ id: 'home', name: 'Home', how_to_reach: 'Open the app', change: 'Taller header' }] },
  result: { summary: 'Done', screens: [{ id: 'home', before: 'shots/before.png', after: `/api/presentation-assets/${'c'.repeat(64)}.png` }] },
});

const plan = card({
  number: 6,
  type: 'plan',
  title: 'Plan tasks',
  status: 'review',
  plan: { question: 'How should tasks work?', scope: 'App only', constraints: ['No new dependencies'] },
  result: {
    summary: 'Wrote it',
    document: '# The design\n\nTasks live in the app.',
    decisions: ['Store in workbench.db'],
    open_questions: ['Import old cards?'],
    proposed_tasks: [{ type: 'feature', title: 'Tasks tab', why: 'Owners need to see tasks' }],
  },
});

const feature = card({
  number: 7,
  type: 'feature',
  title: 'Export chats',
  status: 'done',
  shortfalls: true,
  plan: { outcome: 'Chats export', criteria: [{ id: 'md', text: 'Exports markdown' }, { id: 'img', text: 'Exports images' }] },
  result: {
    summary: 'Markdown works',
    criteria: [
      { id: 'md', met: true, evidence: 'chat-export.spec.ts' },
      { id: 'img', met: false, evidence: 'Images are inlined', reason: 'Needs the asset server' },
    ],
  },
});

describe('task widget validation', () => {
  it.each([optimization, uiChange, plan, feature])('accepts a $task.type card', (value) => {
    expect(widget(value)).toBe(value);
    expect(presentableWidget(value)).toBe(value);
    expect(widgetSpecs(`\`\`\`atelier-widget\n${JSON.stringify(value)}\n\`\`\``)).toEqual([value]);
  });

  it.each([
    ['no task', { type: 'task', event: 'create' }],
    ['no event', { type: 'task', task: makeTask() }],
    ['a bad status', { type: 'task', event: 'create', task: { ...makeTask(), status: 'open' } }],
    ['no number', { type: 'task', event: 'create', task: { ...makeTask(), number: 0 } }],
    ['no plan', { type: 'task', event: 'create', task: { ...makeTask(), plan: null } }],
    ['a list for a result', { type: 'task', event: 'create', task: { ...makeTask(), result: [] } }],
    ['a list for its detail', { type: 'task', event: 'check', task: makeTask(), detail: [] }],
  ])('refuses a card with %s', (_, value) => {
    expect(widget(value)).toBeNull();
  });

  it('accepts what the change recorded, as an object', () => {
    const checked = { ...feature, event: 'check', detail: { item: 'md', met: true } };
    expect(presentableWidget(checked)).toBe(checked);
    expect(widget({ ...checked, detail: 'met' })).toBeNull();
  });

  it('refuses extra top-level fields from the presenter', () => {
    expect(presentableWidget({ ...feature, extra: 1 })).toBeNull();
  });

  it('draws the card after an `atelier task` call', () => {
    const tool = (command: string): TranscriptTool => ({
      kind: 'tool', id: 't1', name: 'Bash', title: command, status: 'ok', seconds: 0, summary: null,
      parentId: null, diff: null, input: { command }, output: '', presented: [feature as ChatWidget],
    });
    expect(ranThePresenter(tool('atelier task create < plan.json'))).toBe(true);
    expect(ranThePresenter(tool('atelier tool task done 7 --input r.json'))).toBe(true);
    expect(ranThePresenter(tool('atelier tool present image --file x.png'))).toBe(true);
    expect(ranThePresenter(tool('atelier tasks'))).toBe(false);
    // The card says what happened, so the call that drew it is not drawn as a command too.
    expect(withPresented([tool('atelier task done 7')]).map((item) => item.id)).toEqual(['t1:presented']);
    // A call that failed keeps its row, whatever it printed.
    expect(withPresented([{ ...tool('atelier task done 7'), status: 'failed' }]).map((item) => item.id)).toEqual(['t1', 't1:presented']);
    const exited = { ...tool('atelier task done 7'), terminal: { exitCode: 1 } } as unknown as TranscriptTool;
    expect(withPresented([exited]).map((item) => item.id)).toEqual(['t1', 't1:presented']);
  });
});

describe('task card rendering', () => {
  // A chat shows one card per task, when it is created; a finished task is a
  // line there, and its whole result is in the detail (TaskCard without event).
  const detail = (widget: TaskWidget) => render(<TaskCard task={widget.task!} />);
  const showAll = () => fireEvent.click(screen.getByTestId('task-result-all'));

  it('draws an optimization as a table of targets, met and missed', () => {
    detail(optimization);
    expect(screen.getByText('#4')).toBeVisible();
    expect(screen.getByText('Optimization')).toBeVisible();
    expect(screen.getByTestId('task-status')).toHaveAttribute('data-status', 'done');
    expect(screen.getByTestId('task-done-counts')).toHaveTextContent('1 of 2 met · 1 missed');
    // Only the missed target is listed until Show all.
    expect(screen.getAllByTestId('task-missed').map((row) => row.textContent)).toEqual(['ScrollLayout still thrashes']);
    expect(screen.queryByTestId('optimization-row')).toBeNull();
    expect(screen.getByText('abcdef1234')).toBeVisible();
    showAll();
    const rows = screen.getAllByTestId('optimization-row');
    expect(rows.map((row) => row.getAttribute('data-met'))).toEqual(['yes', 'no']);
    expect(within(rows[0]!).getByText('Met')).toBeVisible();
    expect(within(rows[1]!).getByText('Missed')).toBeVisible();
    expect(screen.getByText('The index is cached')).toBeVisible();
  });

  it('puts a follow-up into the composer as an @task line', () => {
    const prefill = vi.fn();
    render(<ComposerPrefillContext.Provider value={prefill}><TaskCard task={optimization.task!} /></ComposerPrefillContext.Provider>);
    showAll();
    fireEvent.click(within(screen.getByTestId('task-followup')).getByRole('button', { name: 'Create task' }));
    expect(prefill).toHaveBeenCalledWith('@task bug: Fix the layout thrash — Scroll is still slow');
  });

  it('draws a UI change in review with its before and after pictures shown, read from the chat folder, and the answer after them', () => {
    detail(uiChange);
    // What is reviewed is looked at: no Show all, no toggle per screen.
    expect(screen.queryByTestId('task-result-all')).toBeNull();
    const screenRow = screen.getByTestId('ui-screen');
    expect(within(screenRow).queryByTestId('task-images-toggle')).toBeNull();
    expect(within(screenRow).getByTestId('image-comparison')).toBeInTheDocument();
    expect(within(screenRow).getByAltText('Home before')).toHaveAttribute('src', '/api/fs/media?path=%2Frepo%2Fshots%2Fbefore.png');
    expect(within(screenRow).getByAltText('Home after')).toHaveAttribute('src', `/api/presentation-assets/${'c'.repeat(64)}.png`);
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeVisible();
    expect(screenRow.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws a plan as its document, decisions, questions and proposed tasks', () => {
    const prefill = vi.fn();
    render(<ComposerPrefillContext.Provider value={prefill}><TaskCard task={plan.task!} /></ComposerPrefillContext.Provider>);
    // The document comes first, before the summary, and only once.
    const document = screen.getByTestId('plan-document');
    expect(document.compareDocumentPosition(screen.getByText('Wrote it')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    showAll();
    expect(screen.getAllByTestId('plan-document')).toHaveLength(1);
    expect(within(document).getByRole('heading', { name: 'The design' })).toBeVisible();
    expect(screen.getByText('Store in workbench.db')).toBeVisible();
    expect(screen.getByText('Import old cards?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(prefill).toHaveBeenCalledWith('@task feature: Tasks tab — Owners need to see tasks');
  });

  it('draws a feature as criteria with evidence, and a missed one in amber with its reason', () => {
    detail(feature);
    const missed = screen.getAllByTestId('task-missed');
    expect(missed).toHaveLength(1);
    expect(within(missed[0]!).getByText('Exports images')).toBeVisible();
    expect(within(missed[0]!).getByText('Needs the asset server')).toHaveClass('text-[var(--color-warning-accent)]');
    showAll();
    const checks = screen.getAllByTestId('task-check');
    expect(checks.map((row) => row.getAttribute('data-met'))).toEqual(['yes', 'no']);
    expect(within(checks[0]!).getByText('chat-export.spec.ts')).toBeVisible();
  });

  it('draws only the plan before the task is finished', () => {
    render(<ChatWidgetView widget={card({ type: 'feature', plan: feature.task!.plan })} />);
    expect(screen.getByText('Exports markdown')).toBeVisible();
    expect(screen.queryByTestId('task-check')).toBeNull();
  });

  it('shows the live status over the snapshot', () => {
    const live = byNumber([makeTask({ ...feature.task, status: 'cancelled', updatedAt: 9 })]);
    render(<LiveTasksContext.Provider value={live}><ChatWidgetView widget={card(feature.task!)} /></LiveTasksContext.Provider>);
    expect(screen.getByTestId('task-status')).toHaveAttribute('data-status', 'cancelled');
  });

  it('shows why a task is blocked', () => {
    const blocked = card({ status: 'blocked', blocked: { cause: 'CI is down', needed_to_resume: 'CI back up' } }, 'block');
    render(<ChatWidgetView widget={{ type: 'task', event: 'block', task: blocked.task!, detail: { cause: 'CI is down', needed_to_resume: 'CI back up' } }} />);
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Blocked: CI is down');
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    expect(screen.getByTestId('task-event-more')).toHaveTextContent('CI back up');
    cleanup();
    detail(blocked);
    expect(screen.getByTestId('task-blocked')).toHaveTextContent('CI is down');
    expect(screen.getByTestId('task-blocked')).toHaveTextContent('CI back up');
  });

  it('shows a plan change on one line, and counts it beside the diff once open', () => {
    const amend = { outcome: 'Chats export', criteria: [{ id: 'md', text: 'Exports markdown' }, { id: 'img', text: 'Exports images' }, { id: 'pdf', text: 'Exports PDF' }] };
    render(<ChatWidgetView widget={{ ...card({ status: 'in_progress', plan: amend }, 'amend'), detail: { previous: feature.task!.plan } }} />);
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Plan changed: +1 criterion “Exports PDF”');
    expect(screen.getByTestId('task-event')).toHaveAttribute('data-waiting', 'no');
    expect(screen.queryByTestId('task-event-more')).toBeNull();
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    expect(screen.getByTestId('task-event-text')).toHaveTextContent(/^Plan changed: \+1$/);
    const changes = screen.getAllByTestId('task-amend-change');
    expect(changes.map((row) => [row.getAttribute('data-change'), row.textContent])).toEqual([['added', 'Added: Exports PDF']]);
  });

  it('asks for a note before reopening a task in review', async () => {
    act.mockResolvedValue({ task: makeTask({ ...uiChange.task, status: 'in_progress', updatedAt: 5 }), widget: null });
    render(<ChatWidgetView widget={{ type: 'task', event: 'done', task: uiChange.task! }} />);
    // Waiting on the owner's review: the summary starts open, with the buttons on the line.
    expect(screen.getByTestId('task-event-more')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const submit = screen.getByRole('button', { name: 'Reopen' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Header is clipped' } });
    fireEvent.click(submit);
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 5, 'reopen', { note: 'Header is clipped' }));
    await waitFor(() => expect(screen.getByTestId('task-event-answer')).toHaveTextContent('Reopened'));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});
