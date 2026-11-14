/**
 * A task type's skills in settings (docs/tasks.md, "Task types"): each type
 * lists the skills an agent reads before working a task of that type, and the
 * owner adds one from the library or removes one.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TaskTypesSettings } from '@/components/settings/task-types-settings';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/settings',
}));

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

const listing = {
  types: [
    { name: 'ui_feature', code: true, review: true, custom: false, description: 'Add something new to the interface.', plan: '', result: '',
      items: [], skills: ['ui-copy'] },
    { name: 'bug', code: true, review: false, custom: false, description: 'Something works wrong.', plan: '', result: '', items: [], skills: [] },
  ],
  off: [],
  library: [
    { id: 'ui-copy', name: 'ui-copy', description: 'Write interface text' },
    { id: 'web-qa', name: 'web-qa', description: 'Test a web change in a real browser' },
  ],
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const body = call.method === 'GET' ? listing : { summary: 'ok' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const posts = () => calls.filter((call) => call.method === 'POST' && call.url.includes('/api/workbench/task-types'));

async function row(name: string) {
  const rows = await screen.findAllByTestId('task-type-row');
  return rows.find((one) => one.getAttribute('data-name') === name)!;
}

describe('a task type\'s skills', () => {
  it('lists the skills a type names', async () => {
    render(<TaskTypesSettings />);
    const ui = await row('ui_feature');
    expect(within(ui).getByRole('list', { name: 'ui_feature skills' })).toHaveTextContent('ui-copy');
  });

  it('adds a skill from the library', async () => {
    render(<TaskTypesSettings />);
    const ui = await row('ui_feature');
    fireEvent.click(within(ui).getByRole('combobox', { name: 'Add a skill to ui_feature' }));
    fireEvent.click(await screen.findByRole('option', { name: /web-qa/ }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ change: { action: 'edit', scope: 'install', name: 'ui_feature', skills: ['ui-copy', 'web-qa'] } });
  });

  it('removes a skill', async () => {
    render(<TaskTypesSettings />);
    const ui = await row('ui_feature');
    fireEvent.click(within(ui).getByRole('button', { name: 'Remove ui-copy from ui_feature' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ change: { action: 'edit', scope: 'install', name: 'ui_feature', skills: [] } });
  });
});
