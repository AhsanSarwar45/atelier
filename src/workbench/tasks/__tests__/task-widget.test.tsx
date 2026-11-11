import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { presentableWidget, widget, widgetSpecs, type ChatWidget } from '@/workbench/chat-widgets';
import type { TranscriptTool } from '@/workbench/fold';
import { ranThePresenter, withPresented } from '@/workbench/presented';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { ComposerPrefillContext } from '@/workbench/tasks/composer-prefill';
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
  plan: { question: 'How should tasks work?', scope: 'App only', constraints: ['No Beads'] },
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
  ])('refuses a card with %s', (_, value) => {
    expect(widget(value)).toBeNull();
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
    expect(withPresented([tool('atelier task done 7')]).map((item) => item.id)).toEqual(['t1', 't1:presented']);
  });
});

describe('task card rendering', () => {
  it('draws an optimization as a table of targets, met and missed', () => {
    render(<ChatWidgetView widget={optimization} />);
    expect(screen.getByTestId('chat-widget')).toHaveAttribute('data-widget', 'task');
    expect(screen.getByText('#4')).toBeVisible();
    expect(screen.getByText('Optimization')).toBeVisible();
    expect(screen.getByTestId('task-status')).toHaveAttribute('data-status', 'done');
    const rows = screen.getAllByTestId('optimization-row');
    expect(rows.map((row) => row.getAttribute('data-met'))).toEqual(['yes', 'no']);
    expect(within(rows[0]!).getByText('Met')).toBeVisible();
    expect(within(rows[1]!).getByText('Missed')).toBeVisible();
    expect(screen.getByText('The index is cached')).toBeVisible();
    expect(screen.getByText('Layout still thrashes')).toBeVisible();
    expect(screen.getByTestId('task-shortfalls')).toBeVisible();
    expect(screen.getByText('abcdef1234')).toBeVisible();
  });

  it('puts a follow-up into the composer as an @task line', () => {
    const prefill = vi.fn();
    render(<ComposerPrefillContext.Provider value={prefill}><ChatWidgetView widget={optimization} /></ComposerPrefillContext.Provider>);
    fireEvent.click(within(screen.getByTestId('task-followup')).getByRole('button', { name: 'Create task' }));
    expect(prefill).toHaveBeenCalledWith('@task bug: Fix the layout thrash — Scroll is still slow');
  });

  it('draws a UI change as before and after pictures, read from the chat folder', () => {
    render(<ChatWidgetView widget={uiChange} />);
    const screenRow = screen.getByTestId('ui-screen');
    expect(within(screenRow).getByTestId('image-comparison')).toBeInTheDocument();
    expect(within(screenRow).getByAltText('Home before')).toHaveAttribute('src', '/api/fs/media?path=%2Frepo%2Fshots%2Fbefore.png');
    expect(within(screenRow).getByAltText('Home after')).toHaveAttribute('src', `/api/presentation-assets/${'c'.repeat(64)}.png`);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeVisible();
  });

  it('draws a plan as its document, decisions, questions and proposed tasks', () => {
    const prefill = vi.fn();
    render(<ComposerPrefillContext.Provider value={prefill}><ChatWidgetView widget={plan} /></ComposerPrefillContext.Provider>);
    expect(within(screen.getByTestId('plan-document')).getByRole('heading', { name: 'The design' })).toBeVisible();
    expect(screen.getByText('Store in workbench.db')).toBeVisible();
    expect(screen.getByText('Import old cards?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(prefill).toHaveBeenCalledWith('@task feature: Tasks tab — Owners need to see tasks');
  });

  it('draws a feature as criteria with evidence, and a missed one in amber with its reason', () => {
    render(<ChatWidgetView widget={feature} />);
    const checks = screen.getAllByTestId('task-check');
    expect(checks.map((row) => row.getAttribute('data-met'))).toEqual(['yes', 'no']);
    expect(within(checks[0]!).getByText('chat-export.spec.ts')).toBeVisible();
    expect(within(checks[1]!).getByText('Needs the asset server')).toHaveClass('text-[var(--color-warning-accent)]');
  });

  it('draws only the plan before the task is finished', () => {
    render(<ChatWidgetView widget={card({ type: 'feature', plan: feature.task.plan })} />);
    expect(screen.getByText('Exports markdown')).toBeVisible();
    expect(screen.queryByTestId('task-check')).toBeNull();
  });

  it('shows the live status over the snapshot', () => {
    const live = byNumber([makeTask({ ...feature.task, status: 'cancelled', updatedAt: 9 })]);
    render(<LiveTasksContext.Provider value={live}><ChatWidgetView widget={feature} /></LiveTasksContext.Provider>);
    expect(screen.getByTestId('task-status')).toHaveAttribute('data-status', 'cancelled');
  });

  it('shows why a task is blocked', () => {
    render(<ChatWidgetView widget={card({ status: 'blocked', blocked: { cause: 'CI is down', needed_to_resume: 'CI back up' } }, 'block')} />);
    expect(screen.getByTestId('task-blocked')).toHaveTextContent('CI is down');
    expect(screen.getByTestId('task-blocked')).toHaveTextContent('CI back up');
  });

  it('lets the owner approve a proposed plan change', async () => {
    act.mockResolvedValue({ task: makeTask({ ...feature.task, pendingAmend: null, updatedAt: 5 }), widget: null });
    render(<ChatWidgetView widget={card({ status: 'in_progress', pendingAmend: { outcome: 'Smaller', criteria: [{ id: 'md', text: 'Only markdown' }] } }, 'amend')} />);
    expect(within(screen.getByTestId('task-amend')).getByText('Only markdown')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Approve change' }));
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 1, 'approve_amend', undefined));
  });

  it('asks for a note before reopening a task in review', async () => {
    act.mockResolvedValue({ task: makeTask({ ...uiChange.task, status: 'in_progress', updatedAt: 5 }), widget: null });
    render(<ChatWidgetView widget={uiChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    const submit = screen.getByRole('button', { name: 'Reopen' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note' }), { target: { value: 'Header is clipped' } });
    fireEvent.click(submit);
    await waitFor(() => expect(act).toHaveBeenCalledWith('p1', 5, 'reopen', { note: 'Header is clipped' }));
    await waitFor(() => expect(screen.getByTestId('task-status')).toHaveAttribute('data-status', 'in_progress'));
  });
});
