/**
 * Task types in the app (docs/tasks.md, "Task types"): the reasons an agent
 * gave for its type, a custom type's items and a type's default items on the
 * task card; the chat card for a types change, with its Undo; and the
 * settings section that lists the types and turns them on and off.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskTypesSettings } from '@/components/settings/task-types-settings';

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

const posts = () => calls.filter((call) => call.method === 'POST' && call.url.includes('/api/workbench/task-types'));

describe('the task types settings', () => {
  const listing = {
    types: [
      { name: 'bug', code: true, review: false, custom: false, description: 'plan: …', plan: '', result: '', items: [] },
      { name: 'render_change', code: true, review: false, custom: false, description: 'plan: …', plan: '', result: '', items: [] },
      { name: 'api_change', code: true, review: false, custom: true, description: 'A change to the HTTP API', plan: '', result: '',
        items: [{ id: 'docs-updated', text: 'docs/api.md describes the change' }] },
    ],
    off: ['qa'],
  };

  it('lists the project\'s types with their default items, and turns one off', async () => {
    answer = (call) => (call.method === 'GET' ? { status: 200, body: listing } : { status: 200, body: { summary: 'Turned type "render_change" off for the project.' } });
    render(<TaskTypesSettings projectId="p1" />);
    const rows = await screen.findAllByTestId('task-type-row');
    expect(rows.map((row) => row.getAttribute('data-name'))).toEqual(['bug', 'render_change', 'api_change', 'qa']);
    const api = rows[2]!;
    expect(api).toHaveTextContent('A change to the HTTP API');
    expect(api).toHaveTextContent('docs/api.md describes the change');
    expect(calls[0]!.url).toContain('/api/workbench/task-types?project=p1');

    fireEvent.click(within(rows[1]!).getByRole('switch', { name: 'render_change' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ project: 'p1', change: { action: 'disable', scope: 'project', name: 'render_change' } });
  });

  it('turns a type that is off back on', async () => {
    answer = (call) => (call.method === 'GET' ? { status: 200, body: listing } : { status: 200, body: { summary: 'ok' } });
    render(<TaskTypesSettings projectId="p1" />);
    const rows = await screen.findAllByTestId('task-type-row');
    const qa = rows.find((row) => row.getAttribute('data-name') === 'qa')!;
    expect(within(qa).getByRole('switch', { name: 'qa' })).not.toBeChecked();
    fireEvent.click(within(qa).getByRole('switch', { name: 'qa' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ project: 'p1', change: { action: 'enable', scope: 'project', name: 'qa' } });
  });
});
