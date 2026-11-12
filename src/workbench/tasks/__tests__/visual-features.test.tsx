/**
 * New work you can see: ui_feature and render_feature, with an after image
 * for every item and a before only where the screen or scene existed; and the
 * screenshots a feature or bug result carries when its commits change visual
 * files (docs/tasks.md, "Types" and "Visual files").
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import { checklistForTasks } from '@/workbench/tasks/checklist';
import { VISUAL_TYPES, itemProgress } from '@/workbench/tasks/progress';
import { TaskCard } from '@/workbench/tasks/task-card';
import { TYPE_LABEL, type Task } from '@/workbench/tasks/types';

vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const asset = (c: string) => `/api/presentation-assets/${c.repeat(64)}.png`;

const uiPlan = {
  outcome: 'Owners can pin a chat',
  screens: [
    { id: 'list', name: 'Chat list', how_to_reach: 'Chat tab', shows: 'A pin on each row', existed: true },
    { id: 'pinned', name: 'Pinned section', how_to_reach: 'Pin a chat', shows: 'A Pinned heading' },
  ],
};
const uiResult = { screens: [{ id: 'list', before: asset('a'), after: asset('b') }, { id: 'pinned', after: asset('c') }] };
const renderPlan = {
  outcome: 'HDR sky lighting',
  scenes: [{ id: 'hall', name: 'Great hall', scene: 'hall.gltf', camera: 'door, fov 60', shows: 'Sky light', existed: true, reference: true }],
};
const renderResult = { scenes: [{ id: 'hall', before: asset('a'), after: asset('b'), reference: asset('c') }] };

const uiFeature = (over: Partial<Task> = {}) => makeTask({ number: 6, type: 'ui_feature', title: 'Pin chats', plan: uiPlan, ...over });
const renderFeature = (over: Partial<Task> = {}) => makeTask({ number: 7, type: 'render_feature', title: 'HDR sky', plan: renderPlan, ...over });

describe('the new visual types', () => {
  it('are visual types with their own labels', () => {
    expect(TYPE_LABEL.ui_feature).toBe('UI feature');
    expect(TYPE_LABEL.render_feature).toBe('Render feature');
    expect(VISUAL_TYPES.has('ui_feature') && VISUAL_TYPES.has('render_feature')).toBe(true);
  });

  it.each([
    [uiFeature(), 'UI feature', ['Chat list', 'Pinned section']],
    [renderFeature(), 'Render feature', ['Great hall']],
  ])('a create card shows the label, the outcome and one line per item', (task, label, names) => {
    render(<ChatWidgetView widget={{ type: 'task', event: 'create', task }} />);
    const card = screen.getByTestId('task-card');
    expect(within(card).getByText(label)).toBeVisible();
    expect(card).toHaveTextContent((task.plan as { outcome: string }).outcome);
    expect(within(card).getAllByTestId('task-plan-item').map((row) => row.getAttribute('data-full'))).toEqual(names);
  });

  it('counts checked items toward the checklist', () => {
    const task = uiFeature({ status: 'in_progress', checks: { screens: [{ id: 'pinned', after: asset('c') }] } });
    expect(itemProgress(task).map((item) => item.state)).toEqual(['open', 'met']);
    expect(checklistForTasks([task], 's1')[0]!.progress).toEqual({ met: 1, total: 2 });
  });

  it('a finished ui_feature shows before and after side by side for a screen that existed, and the after alone for a new one', () => {
    render(<TaskCard task={uiFeature({ status: 'review', result: { summary: 'Pins', commits: ['abcdef1'], ...uiResult } })} />);
    // Shown as they are: no Show all, no toggle per screen.
    expect(screen.queryByTestId('task-result-all')).toBeNull();
    expect(screen.queryByTestId('task-images-toggle')).toBeNull();
    const shots = screen.getAllByTestId('ui-screen');
    expect(within(shots[0]!).getByTestId('image-comparison')).toBeInTheDocument();
    expect(within(shots[0]!).getByAltText('Chat list before')).toHaveAttribute('src', asset('a'));
    expect(within(shots[1]!).queryByTestId('image-comparison')).toBeNull();
    expect(within(shots[1]!).getByAltText('Pinned section after')).toHaveAttribute('src', asset('c'));
  });

  it('a finished render_feature shows the reference beside before and after', () => {
    render(<TaskCard task={renderFeature({ status: 'review', result: { summary: 'Sky', commits: ['abcdef1'], ...renderResult } })} />);
    expect(screen.getByAltText('Great hall after')).toHaveAttribute('src', asset('b'));
    expect(screen.getByAltText('Great hall reference')).toHaveAttribute('src', asset('c'));
  });

  it('a check line unfolds straight to the images of the item it checked', () => {
    const task = uiFeature({ status: 'in_progress', checks: { screens: [{ id: 'pinned', after: asset('c') }] } });
    render(<ChatWidgetView widget={{ type: 'task', event: 'check', task, detail: { item: 'pinned', met: true } }} />);
    expect(screen.getByTestId('task-event-text')).toHaveTextContent('Pinned section');
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    const more = screen.getByTestId('task-event-more');
    expect(within(more).queryByTestId('task-images-toggle')).toBeNull();
    expect(within(more).getByAltText('Pinned section after')).toHaveAttribute('src', asset('c'));
  });

  it('a finished visual task in a chat shows its images in the done line, with the answer after them', () => {
    const task = uiFeature({ status: 'review', result: { summary: 'Pins', commits: ['abcdef1'], ...uiResult } });
    render(<ChatWidgetView widget={{ type: 'task', event: 'done', task }} />);
    const more = screen.getByTestId('task-event-more');
    expect(within(more).getByAltText('Pinned section after')).toHaveAttribute('src', asset('c'));
    const approve = within(more).getByRole('button', { name: 'Approve' });
    expect(within(more).getAllByTestId('ui-screen').at(-1)!.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('screenshots on a feature or bug', () => {
  const featurePlan = { outcome: 'Export', criteria: [{ id: 'a', text: 'Export button' }] };
  const screens = [{ name: 'Export menu', before: asset('a'), after: asset('b') }, { name: 'Export dialog', after: asset('c') }];

  it('a done feature shows its screenshots in the done summary, once, behind toggles', () => {
    render(<TaskCard task={makeTask({
      type: 'feature', status: 'done', plan: featurePlan,
      result: { summary: 'Export', commits: ['abcdef1'], criteria: [{ id: 'a', met: true, evidence: 'e2e' }], screens },
    })} />);
    const shots = screen.getByTestId('task-screenshots');
    expect(shots).toHaveTextContent('Export menu');
    expect(shots).toHaveTextContent('Export dialog');
    fireEvent.click(within(shots).getByRole('button', { name: 'Show before and after' }));
    expect(within(shots).getByAltText('Export menu after')).toHaveAttribute('src', asset('b'));
    fireEvent.click(within(shots).getByRole('button', { name: 'Show after' }));
    expect(within(shots).getByAltText('Export dialog after')).toHaveAttribute('src', asset('c'));
    fireEvent.click(screen.getByRole('button', { name: 'Show all 1' }));
    expect(screen.getAllByTestId('task-screenshots')).toHaveLength(1);
  });

  it('a done bug line unfolds to its screenshots', () => {
    const task = makeTask({
      type: 'bug', status: 'done',
      plan: { symptom: 'Clipped', repro_steps: ['Open'], expected: 'Whole', actual: 'Clipped' },
      result: { summary: 'Fixed', commits: ['abcdef1'], root_cause: 'r', fix: 'f', proof: 'p', regression_checked: [], screens: [screens[0]] },
    });
    render(<ChatWidgetView widget={{ type: 'task', event: 'done', task }} />);
    fireEvent.click(screen.getByTestId('task-event-toggle'));
    expect(within(screen.getByTestId('task-event-more')).getByTestId('task-screenshots')).toHaveTextContent('Export menu');
  });

  it('a result without screenshots shows none', () => {
    render(<TaskCard task={makeTask({
      type: 'feature', status: 'done', plan: featurePlan,
      result: { summary: 'Export', commits: ['abcdef1'], criteria: [{ id: 'a', met: true, evidence: 'e2e' }] },
    })} />);
    expect(screen.queryByTestId('task-screenshots')).toBeNull();
  });
});
