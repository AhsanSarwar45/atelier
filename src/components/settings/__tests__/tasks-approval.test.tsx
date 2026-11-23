/**
 * Settings → Tasks: Use tasks and Require approval. The app has a switch for
 * each; a project picks Same as app, On or Off for each from a select, the
 * way other settings with a few fixed choices do.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Scope = { install: boolean; project: boolean | null };
/** What the app's server holds; the settings read and write it over HTTP. */
let held: { enabled: Scope; approval: Scope };
let puts: Array<{ address: string; body: { scope: string; setting?: string; enabled: boolean | null } }>;

const answer = () => ({
  install: held.enabled.install,
  project: held.enabled.project,
  enabled: held.enabled.project ?? held.enabled.install,
  approval: { ...held.approval, enabled: held.approval.project ?? held.approval.install },
});

beforeEach(() => {
  held = { enabled: { install: true, project: null }, approval: { install: true, project: null } };
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const address = String(url);
    if (!address.includes('/api/workbench/tasks-switch')) return new Response('[]', { status: 200 });
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { scope: string; setting?: string; enabled: boolean | null };
      puts.push({ address, body });
      const scope = body.setting === 'approval' ? held.approval : held.enabled;
      if (body.scope === 'install') scope.install = body.enabled ?? true;
      else scope.project = body.enabled;
    }
    return Response.json(answer());
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('Require approval', () => {
  it('can be turned off for the whole app', async () => {
    const { TasksSwitch } = await import('@/components/settings/tasks-switch');
    render(<TasksSwitch />);
    const toggle = await screen.findByRole('switch', { name: 'Require approval' });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(held.approval.install).toBe(false);
    expect(held.enabled.install).toBe(true);
    expect(puts.at(-1)?.body).toEqual({ scope: 'install', setting: 'approval', enabled: false });
  });

  it('is chosen per project from a select that can follow the app', async () => {
    held.approval.install = false;
    const { TasksSwitch } = await import('@/components/settings/tasks-switch');
    render(<TasksSwitch projectId="p1" />);
    const select = await screen.findByRole('combobox', { name: 'Require approval' });
    await waitFor(() => expect(select).toHaveTextContent('Same as app (Off)'));
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole('option', { name: 'On' }));
    await waitFor(() => expect(held.approval.project).toBe(true));
    expect(puts.at(-1)?.address).toContain('project=p1');
    expect(puts.at(-1)?.body).toEqual({ scope: 'project', setting: 'approval', enabled: true });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Require approval' })).toHaveTextContent('On'));
  });
});

describe('Use tasks in a project', () => {
  it('is a select, not a list of radio buttons', async () => {
    held.enabled.install = false;
    const { TasksSwitch } = await import('@/components/settings/tasks-switch');
    render(<TasksSwitch projectId="p1" />);
    const select = await screen.findByRole('combobox', { name: 'Use tasks' });
    await waitFor(() => expect(select).toHaveTextContent('Same as app (Off)'));
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    fireEvent.click(select);
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('option').map((option) => option.textContent)).toEqual(['Same as app (Off)', 'On', 'Off']);
    fireEvent.click(within(list).getByRole('option', { name: 'On' }));
    await waitFor(() => expect(held.enabled.project).toBe(true));
    expect(puts.at(-1)?.body).toEqual({ scope: 'project', enabled: true });
  });
});
