/**
 * The owner's switch for the whole tasks system (tasks, proposals, grids):
 * on or off for the app, and per project either the app's choice or its own.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the app's server holds; the switch reads and writes it over HTTP. */
let held: { install: boolean; project: boolean | null };
let asked: string[];

beforeEach(() => {
  held = { install: true, project: null };
  asked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    const address = String(url);
    if (!address.includes('/api/workbench/tasks-switch')) return new Response('[]', { status: 200 });
    asked.push(`${init?.method ?? 'GET'} ${address}`);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { scope: string; enabled: boolean | null };
      if (body.scope === 'install') held.install = body.enabled ?? true;
      else held.project = body.enabled;
    }
    return Response.json({ ...held, enabled: held.project ?? held.install });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('the Use tasks switch', () => {
  it('turns tasks off for the whole app', async () => {
    const { TasksSwitch } = await import('@/components/settings/tasks-switch');
    render(<TasksSwitch />);
    const toggle = await screen.findByRole('switch', { name: 'Use tasks' });
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(held.install).toBe(false);
  });

  it('lets a project follow the app, or turn tasks on or off for itself', async () => {
    held.install = false;
    const { TasksSwitch } = await import('@/components/settings/tasks-switch');
    render(<TasksSwitch projectId="p1" />);
    const same = await screen.findByRole('radio', { name: /Same as app/ });
    await waitFor(() => expect(same).toBeChecked());
    expect(same).toHaveAccessibleName(/Off/);
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    await waitFor(() => expect(screen.getByRole('radio', { name: 'On' })).toBeChecked());
    expect(held.project).toBe(true);
    expect(asked.some((one) => one.startsWith('PUT') && one.includes('project=p1'))).toBe(true);
  });
});
