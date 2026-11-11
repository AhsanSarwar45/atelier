import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DependenciesSettings } from '../dependencies-settings';

const requestMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ request: requestMock }));

const tools = [
  ['git', true], ['claude', true], ['codex', false], ['browser', true],
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
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
  });

  it('reports every dependency, and installs none itself', async () => {
    render(<DependenciesSettings />);

    expect(await screen.findByText('browser')).toBeVisible();
    expect(screen.getByText('claude')).toBeVisible();
    expect(screen.getByText('codex')).toBeVisible();
    expect(screen.getByText('Install codex')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });
});
