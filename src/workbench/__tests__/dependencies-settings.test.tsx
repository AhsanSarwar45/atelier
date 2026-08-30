import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DependenciesSettings } from '../dependencies-settings';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ request: requestMock }));
vi.mock('@/workbench/live-wire', () => ({ onBootstrap: vi.fn(() => () => {}) }));

const tools = [
  ['git', true], ['bd', false], ['claude', true], ['codex', false], ['browser', true],
].map(([tool, found]) => ({
  tool, requiredFor: `${tool} work`, found, ok: found,
  path: found ? `/tools/${tool}` : null, version: found ? `${tool} 1` : null,
  hint: `Install ${tool}`,
}));

describe('Dependencies settings', () => {
  beforeEach(() => {
    requestMock.mockReset();
    requestMock.mockImplementation(async (url: string) => {
      if (url === '/api/environment') return new Response(JSON.stringify(tools), { status: 200 });
      if (url === '/api/environment/bd/install') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  });

  it('reports every dependency and sends one explicit consent for Beads installation', async () => {
    const consent = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DependenciesSettings />);

    expect(await screen.findByText('browser')).toBeVisible();
    expect(screen.getByText('claude')).toBeVisible();
    expect(screen.getByText('codex')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(consent).toHaveBeenCalledTimes(1));
    const install = requestMock.mock.calls.find(([url]) => url === '/api/environment/bd/install');
    expect(install).toBeDefined();
    expect(JSON.parse(install![1].body)).toEqual({ consent: true });
  });
});
