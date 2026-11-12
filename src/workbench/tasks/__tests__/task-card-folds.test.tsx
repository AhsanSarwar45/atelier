/**
 * A chat shows one card per task, printed when it is created; every later
 * change is one line (docs/tasks.md, "Front end").
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { ITEMS_SHOWN, TaskCard } from '@/workbench/tasks/task-card';
import { answer, eventText, waitsOnOwner } from '@/workbench/tasks/task-event-row';
import type { Task, TaskEventDetail } from '@/workbench/tasks/types';
import { LiveTasksContext, byNumber } from '@/workbench/tasks/use-tasks';

vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const criteria = [
  'The settings menu opens from the header button on every screen of the app',
  'Arrow keys move through the menu',
  'Theme switch works',
  'Phone sheet',
  'Saves at once',
  'Reset button',
  'Screen readers announce it',
].map((text, index) => ({ id: `c${index}`, text }));
const plan = { outcome: 'One settings menu', criteria };
const feature = (over: Partial<Task> = {}) => makeTask({ number: 3, type: 'feature', title: 'Settings menu', plan, ...over });
const show = (event: string, task: Task, detail?: TaskEventDetail) =>
  render(<ChatWidgetView widget={{ type: 'task', event, task, ...(detail ? { detail } : {}) }} />);

afterEach(() => window.history.replaceState(null, '', '/'));

describe('the create card', () => {
  it('lists the plan items one line each, cut short, with the whole text as its hover label', () => {
    show('create', feature());
    const card = screen.getByTestId('task-card');
    expect(card).toHaveAttribute('data-compact', 'yes');
    const rows = within(card).getAllByTestId('task-plan-item');
    expect(rows).toHaveLength(ITEMS_SHOWN);
    // The whole text is the row's hover label (and is in the detail).
    expect(rows[0]).toHaveAttribute('data-full', criteria[0]!.text);
    expect(rows[0]).toHaveAttribute('data-state', 'closed');
    expect(rows[0]!.querySelector('span')).toHaveClass('truncate');
  });

  it('shows all of them on Show all N, when there are more than five', () => {
    show('create', feature());
    fireEvent.click(screen.getByRole('button', { name: 'Show all 7' }));
    expect(screen.getAllByTestId('task-plan-item')).toHaveLength(7);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByTestId('task-plan-item')).toHaveLength(5);
  });

  it('has no Show all for five items or fewer', () => {
    show('create', feature({ plan: { outcome: 'o', criteria: criteria.slice(0, 5) } }));
    expect(screen.queryByTestId('task-plan-show-all')).toBeNull();
  });

  it('ticks its items live and counts them', () => {
    const checks = { criteria: [{ id: 'c0', met: true, evidence: 'e' }, { id: 'c1', met: false, reason: 'No keys' }] };
    const live = byNumber([feature({ status: 'in_progress', checks, updatedAt: 5 })]);
    render(<LiveTasksContext.Provider value={live}><ChatWidgetView widget={{ type: 'task', event: 'create', task: feature() }} /></LiveTasksContext.Provider>);
    expect(screen.getAllByTestId('task-plan-item').slice(0, 3).map((row) => row.getAttribute('data-met'))).toEqual(['yes', 'no', 'pending']);
    expect(screen.getByTestId('task-card-counts')).toHaveTextContent('1 of 7 met · 1 missed');
    // Nothing more than the header and the items: no result, no amend panel.
    expect(screen.queryByTestId('task-done-summary')).toBeNull();
    expect(screen.queryByTestId('task-amend')).toBeNull();
  });

  it.each([
    ['visual_bug', { symptom: 'Blurry icons', repro_steps: ['Open'], expected: 'Sharp', actual: 'Blurry', screens: [{ id: 'menu', name: 'Settings menu', how_to_reach: 'Header' }] }, 'Settings menu'],
    ['render_change', { scenes: [{ id: 'hall', scene: 'Great hall', camera: 'door', change: 'Warmer light', reference: true }] }, 'Great hall'],
  ])('draws a %s by its items', (type, typePlan, name) => {
    show('create', makeTask({ type, plan: typePlan }));
    expect(screen.getByText(type === 'visual_bug' ? 'Visual bug' : 'Render change')).toBeVisible();
    expect(screen.getByTestId('task-plan-item')).toHaveTextContent(name);
  });
});

describe('a later change is one line', () => {
  it.each([
    ['start', {}, {}, 'Started'],
    ['unblock', {}, {}, 'Unblocked'],
    ['check', {}, { item: 'c1', met: true }, 'Checked “Arrow keys move through the menu” — met'],
    ['check', {}, { item: 'c3', met: false, reason: 'No sheet yet' }, 'Checked “Phone sheet” — missed: No sheet yet'],
    ['block', { status: 'blocked' as const, blocked: { cause: 'No key', needed_to_resume: 'A key' } }, { cause: 'No key', needed_to_resume: 'A key' }, 'Blocked: No key'],
    ['cancel', { status: 'cancelled' as const, cancelReason: 'Not needed' }, { reason: 'Not needed' }, 'Cancelled: Not needed'],
    ['take', {}, {}, 'Taken by this chat'],
    ['reopen', {}, { note: 'Clipped' }, 'Reopened: Clipped'],
    ['approve', {}, {}, 'Approved'],
    ['approve_amend', {}, {}, 'Plan change approved'],
    ['reject_amend', {}, {}, 'Plan change rejected'],
    ['release', {}, {}, 'Released'],
  ] as const)('%s', (event, over, detail, words) => {
    show(event, feature(over), detail);
    expect(screen.queryByTestId('task-card')).toBeNull();
    const row = screen.getByTestId('task-event');
    expect(within(row).getByText('#3')).toBeVisible();
    expect(screen.getByTestId('task-event-text')).toHaveTextContent(words);
    expect(row.textContent!.length).toBeLessThan(120);
  });

  it('a done line counts what was met and missed, and starts folded once finished', () => {
    const result = { summary: 'Shipped', criteria: criteria.map((c, i) => (i === 3 ? { id: c.id, met: false, evidence: 'popover', reason: 'No sheet component' } : { id: c.id, met: true, evidence: 'e2e' })) };
    show('done', feature({ status: 'done', result, shortfalls: true }));
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Done · 6 of 7 met · 1 missed');
    expect(screen.queryByTestId('task-event-more')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    const summary = screen.getByTestId('task-done-summary');
    expect(within(summary).getAllByTestId('task-missed').map((row) => row.textContent)).toEqual(['Phone sheetNo sheet component']);
    expect(summary).toHaveTextContent('Shipped');
    expect(within(summary).queryAllByTestId('task-check')).toHaveLength(0);
    fireEvent.click(within(summary).getByRole('button', { name: 'Show all 7' }));
    expect(within(summary).getAllByTestId('task-check')).toHaveLength(7);
  });

  it('a done line waiting for review starts open, with Approve and Reopen after the summary', () => {
    show('done', feature({ status: 'review', result: { summary: 'Ready', criteria: criteria.map((c) => ({ id: c.id, met: true, evidence: 'e' })) } }));
    const row = screen.getByTestId('task-event');
    expect(row).toHaveAttribute('data-waiting', 'yes');
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Done, ready for review · 7 of 7 met');
    expect(screen.getByTestId('task-event-more')).toHaveTextContent('Ready');
    // The line gives the counts; the summary under it does not repeat them.
    expect(screen.queryByTestId('task-done-counts')).toBeNull();
    const more = screen.getByTestId('task-event-more');
    const approve = within(more).getByRole('button', { name: 'Approve' });
    expect(approve).toBeVisible();
    expect(within(more).getByRole('button', { name: 'Reopen' })).toBeVisible();
    expect(within(more).getByTestId('task-done-summary').compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Folded, they move up onto the line.
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    expect(screen.queryByTestId('task-event-more')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeVisible();
  });

  it('opens the task detail in the Tasks tab on a click, as a new history entry', () => {
    window.history.replaceState(null, '', '/project?id=p1&tab=chat&chat=s1');
    const length = window.history.length;
    show('start', feature());
    fireEvent.click(screen.getByTestId('task-event-text'));
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('tasks');
    expect(params.get('task')).toBe('3');
    expect(params.get('chat')).toBe('s1');
    expect(window.history.length).toBe(length + 1);
  });

  it('does not open the task when one of its buttons is clicked', () => {
    window.history.replaceState(null, '', '/project?id=p1&tab=chat');
    show('done', feature({ status: 'done', result: { summary: 's', criteria: [] } }));
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('chat');
  });

  it('names the task, and puts a bare label on the same line with no gap before it', () => {
    show('start', feature({ status: 'in_progress' }));
    const row = screen.getByTestId('task-event');
    expect(within(row).getByText('Settings menu')).toBeVisible();
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Started');
    expect(screen.queryByTestId('task-event-toggle')).toBeNull();
    // One line: the label, number and title share it.
    const line = screen.getByTestId('task-event-text').parentElement!;
    expect(line).toContainElement(screen.getByTestId('task-event-open'));
    expect(line.firstElementChild!.tagName.toLowerCase()).toBe('svg');
  });

  it('gives the text a row of its own, the full width of the card', () => {
    show('done', feature({ status: 'review', result: { summary: 's', criteria: [] } }));
    const text = screen.getByTestId('task-event-text');
    expect(text).toHaveClass('break-words');
    // The text's button is not beside the chevron and icon, but under them.
    const open = screen.getByTestId('task-event-open');
    expect(open).toHaveClass('w-full');
    expect(open.parentElement!.firstElementChild).toContainElement(screen.getByTestId('task-event-toggle'));
  });
});

describe('whether a line still waits on the owner', () => {
  const amend = { outcome: 'o', criteria: criteria.slice(0, 2) };
  const printed = feature({ status: 'in_progress', pendingAmend: amend });

  it('a plan change waits while the same change is pending, then says how it was answered', () => {
    expect(waitsOnOwner('amend', printed, printed)).toBe(true);
    expect(answer('amend', printed, printed)).toBe('');
    expect(waitsOnOwner('amend', printed, { ...printed, pendingAmend: null, plan: amend })).toBe(false);
    expect(answer('amend', printed, { ...printed, pendingAmend: null, plan: amend })).toBe('Approved');
    expect(answer('amend', printed, { ...printed, pendingAmend: null })).toBe('Rejected');
  });

  it('a finished task waits while the same result is in review', () => {
    const done = feature({ status: 'review', result: { summary: 's' } });
    expect(waitsOnOwner('done', done, done)).toBe(true);
    expect(answer('done', done, { ...done, status: 'done' })).toBe('Approved');
    expect(answer('done', done, { ...done, status: 'in_progress' })).toBe('Reopened');
    expect(waitsOnOwner('start', done, done)).toBe(false);
  });

  it('names a plan change by what it adds', () => {
    expect(eventText('amend', feature({ pendingAmend: { ...plan, criteria: [...criteria, { id: 'search', text: 'Search box' }] } }))).toBe('Plan change: +1 criterion “Search box”');
    expect(eventText('amend', feature({ pendingAmend: { ...plan, criteria: [...criteria.slice(1, 6), { id: 'search', text: 'Search box' }] } }), {}, true)).toBe('Plan change: +1 / −2');
  });
});

describe('the Tasks tab detail', () => {
  it('always shows the whole card, with no toggle', () => {
    render(<TaskCard task={makeTask({ status: 'in_progress' })} />);
    expect(screen.queryByTestId('task-card-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('task-card')).not.toHaveAttribute('data-compact');
  });

  it('shows a pending plan change as what it changes, not both plans', () => {
    const amend = { outcome: 'One settings menu', criteria: [...criteria.slice(0, 5).map((c) => (c.id === 'c2' ? { ...c, text: 'Theme switch works without a reload' } : c)), { id: 'search', text: 'Search box' }] };
    render(<TaskCard task={feature({ status: 'in_progress', pendingAmend: amend })} />);
    const panel = screen.getByTestId('task-amend');
    const changes = within(panel).getAllByTestId('task-amend-change').map((row) => row.getAttribute('data-change'));
    expect(changes).toEqual(['added', 'removed', 'removed', 'changed']);
    expect(panel).toHaveTextContent('Theme switch works without a reload');
    expect(panel).not.toHaveTextContent('Arrow keys move through the menu');
    expect(within(panel).getByRole('button', { name: 'Approve change' })).toBeVisible();
  });
});

describe('the visual types, finished', () => {
  const asset = (c: string) => `/api/presentation-assets/${c.repeat(64)}.png`;

  it('a visual bug shows its root cause and fix, with each screen\'s images shown, not behind Show all', () => {
    render(<TaskCard task={makeTask({
      type: 'visual_bug', status: 'review',
      plan: { symptom: 'Blurry', repro_steps: ['Open'], expected: 'Sharp', actual: 'Blurry', screens: [{ id: 'menu', name: 'Settings menu', how_to_reach: 'Header' }] },
      result: { summary: 'SVG icons', root_cause: '1x sprites', fix: 'Inline SVG', screens: [{ id: 'menu', before: asset('a'), after: asset('b') }] },
    })} />);
    const summary = screen.getByTestId('task-done-summary');
    expect(summary).toHaveTextContent('1 of 1 met');
    expect(screen.getAllByText('1x sprites')).toHaveLength(1);
    expect(summary).toHaveTextContent('Inline SVG');
    expect(within(summary).queryByTestId('task-result-all')).toBeNull();
    expect(screen.queryByTestId('task-images-toggle')).toBeNull();
    expect(screen.getByAltText('Settings menu before')).toHaveAttribute('src', asset('a'));
    expect(screen.getByAltText('Settings menu after')).toHaveAttribute('src', asset('b'));
  });

  it('a render change shows the reference image beside before and after', () => {
    render(<TaskCard task={makeTask({
      type: 'render_change', status: 'review',
      plan: { scenes: [{ id: 'hall', scene: 'Great hall', camera: 'door', change: 'Warmer', reference: true }] },
      result: { summary: 'Warmer', scenes: [{ id: 'hall', before: asset('a'), after: asset('b'), reference: asset('c') }] },
    })} />);
    expect(screen.getByAltText('Great hall reference')).toHaveAttribute('src', asset('c'));
    expect(screen.getByAltText('Great hall after')).toHaveAttribute('src', asset('b'));
  });
});

describe('the answer a finished line shows', () => {
  it('says Reopened for a result a later done replaced, even once the task is approved', () => {
    const first = feature({ status: 'review', result: { summary: 'first', criteria: [] } });
    const approvedLater = feature({ status: 'done', result: { summary: 'second', criteria: [] } });
    expect(answer('done', first, approvedLater)).toBe('Reopened');
    expect(answer('done', first, { ...first, status: 'done' })).toBe('Approved');
  });
});

describe('a plan under one heading', () => {
  it('drops the outer Plan heading when the plan starts with its own', () => {
    render(<TaskCard task={feature({ status: 'in_progress' })} />);
    const card = screen.getByTestId('task-card');
    expect(within(card).getByText('Outcome')).toBeVisible();
    expect(within(card).queryByText('Plan')).toBeNull();
  });

  it('keeps it for a plan with no heading of its own', () => {
    render(<TaskCard task={makeTask({ type: 'ui_change', status: 'todo', plan: { screens: [{ id: 's', name: 'Home', how_to_reach: '/', change: 'Bigger' }] } })} />);
    expect(within(screen.getByTestId('task-card')).getByText('Plan')).toBeVisible();
  });
});
