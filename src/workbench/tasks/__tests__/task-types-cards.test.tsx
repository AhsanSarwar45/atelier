/**
 * Task types in the app (docs/tasks.md, "Task types"): the reasons an agent
 * gave for its type, a custom type's items and a type's default items on the
 * task card; the chat card for a types change, with its Undo; and the
 * settings section that lists the types and turns them on and off.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';
import type { Task } from '@/workbench/tasks/types';

vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let answer: (call: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const { status, body } = answer(call);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const show = (task: Task) => render(<ChatWidgetView widget={{ type: 'task', event: 'create', task }} />);
const posts = () => calls.filter((call) => call.method === 'POST' && call.url.includes('/api/workbench/task-types'));

describe('the task card', () => {
  it('shows the reason for the chosen type first, and the reasons for the others', () => {
    const decisions = { ui_change: 'the change is to a screen that is there', feature: 'nothing new is added', bug: 'nothing is broken' };
    show(makeTask({ type: 'ui_change', plan: { screens: [] }, decisions } as Partial<Task>));
    fireEvent.click(screen.getByRole('button', { name: 'Why this type' }));
    const reasons = within(screen.getByTestId('task-decisions')).getAllByTestId('task-decision');
    expect(reasons).toHaveLength(3);
    expect(reasons[0]).toHaveTextContent('the change is to a screen that is there');
    expect(reasons[0]).toHaveAttribute('data-chosen', 'yes');
    expect(screen.getByTestId('task-decisions')).toHaveTextContent('nothing is broken');
  });

  it('lists a custom type\'s items like the type it is planned as, not as raw JSON', () => {
    const plan = { outcome: 'The API says when a project is missing', done_when: [{ id: 'missing', text: 'An unknown project answers 404' }] };
    show(makeTask({ type: 'api_change', shape: 'general', plan } as Partial<Task>));
    const card = screen.getByTestId('task-card');
    expect(within(card).getAllByTestId('task-plan-item')[0]).toHaveAttribute('data-full', 'An unknown project answers 404');
    expect(card.querySelector('pre')).toBeNull();
  });

  it('lists the type\'s default items, with the reason when one was declined', () => {
    const plan = {
      outcome: 'o', criteria: [{ id: 'a', text: 'Export works' }],
      requirements: [{ id: 'phone', text: 'Works on a phone screen', declined: 'there is no screen in this change' }],
    };
    show(makeTask({ type: 'feature', plan }));
    const rows = within(screen.getByTestId('task-card')).getAllByTestId('task-plan-item');
    const phone = rows.find((row) => row.getAttribute('data-full') === 'Works on a phone screen');
    expect(phone).toBeDefined();
    expect(phone).toHaveAttribute('data-declined', 'there is no screen in this change');
  });
});

describe('the types change card', () => {
  const card = () => render(<ChatWidgetView widget={{ type: 'taskTypes', projectId: 'p1', scope: 'project', summary: 'Turned type "qa" off for the project.', change: 'c1' }} />);

  it('says what changed and undoes that change', async () => {
    answer = () => ({ status: 200, body: { summary: 'Undid: Turned type "qa" off for the project.' } });
    card();
    expect(screen.getByTestId('task-types-card')).toHaveTextContent('Turned type "qa" off for the project.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('task-types-card')).toHaveTextContent('Undone'));
    expect(posts()[0]!.body).toEqual({ project: 'p1', change: { action: 'undo', scope: 'project', id: 'c1' } });
  });

  it('says why when the undo is refused', async () => {
    answer = () => ({ status: 400, body: { error: 'a later change was made to the project\'s task types; undo that first' } });
    card();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('task-types-card')).toHaveTextContent('a later change was made'));
  });
});
