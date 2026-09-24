import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SharedLibrary } from '@/components/settings/shared-library';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', () => ({ request }));
vi.mock('@/workbench/use-session', () => ({ sendCommand: vi.fn() }));

const item = { id: 'proof', name: 'Proof', description: '', kind: 'skill', content: 'text', when: { op: 'always' }, requires: [], automatic: true, parameters: {}, resources: {}, bundle: '' };
function answer(source = 'global', state = 'available', overrides = {}) {
  return { library: { items: [], overrides, output_style: null }, revision: 'local-revision', source_revision: 'global-revision', inherited: [item], guidance: '', resolved: { revision: 'snapshot', items: [{ item, source, state, customized: false, evaluation: { matched: true, reason: 'Always', children: [] }, missing: [] }] } };
}

describe('project skill switches', () => {
  beforeEach(() => request.mockReset());

  it.each(['global', 'project'])('saves only the project override for a %s skill', async source => {
    const initial = answer(source, 'available', { proof: { content: 'Keep customized text', parameters: { key: 'keep' } } });
    request.mockResolvedValue({ ok: true, json: async () => initial });
    render(<SharedLibrary projectPath="/project one" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Skills', exact: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Proof for this project' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/settings/library?path=%2Fproject+one', expect.objectContaining({ method: 'PUT' })));
    const body = JSON.parse(request.mock.calls.find(call => call[1]?.method === 'PUT')![1].body);
    expect(body).toEqual({ library: { ...initial.library, overrides: { proof: { content: 'Keep customized text', parameters: { key: 'keep' }, disabled: true } } }, revision: 'local-revision', source_revision: 'global-revision' });
  });

  it('uses the saved preference even when the effective state is conflict', async () => {
    request.mockResolvedValue({ ok: true, json: async () => answer('global', 'conflict', { proof: { disabled: true } }) });
    render(<SharedLibrary projectPath="/repo" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Skills', exact: true }));
    const toggle = screen.getByRole('switch', { name: 'Enable Proof for this project' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(request.mock.calls.some(call => call[1]?.method === 'PUT')).toBe(true));
    const body = JSON.parse(request.mock.calls.find(call => call[1]?.method === 'PUT')![1].body);
    expect(body.library.overrides).toEqual({});
  });

  it('keeps the confirmed switch state after a rejected save', async () => {
    request.mockImplementation(async (_url, options) => options?.method === 'PUT'
      ? { ok: false, text: async () => 'Settings changed. Reload before saving.' }
      : { ok: true, json: async () => answer() });
    render(<SharedLibrary projectPath="/repo" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Skills', exact: true }));
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Proof for this project' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('does not offer project switches in global settings', async () => {
    request.mockImplementation(async url => ({ ok: true, json: async () => url === '/api/projects' ? [] : answer() }));
    render(<SharedLibrary />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Skills', exact: true }));
    expect(within(screen.getByTestId('library-item-proof')).queryByRole('switch')).toBeNull();
  });

  it('offers deletion only for items owned by the current scope', async () => {
    request.mockResolvedValue({ ok: true, json: async () => answer() });
    render(<SharedLibrary projectPath="/repo" />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Skills', exact: true }));
    expect(within(screen.getByTestId('library-item-proof')).queryByRole('button', { name: 'Delete…' })).toBeNull();
  });

  it('confirms complete folder deletion and sends the prepared revision', async () => {
    const initial = answer();
    const folderAnswer = { ...initial, resolved: { ...initial.resolved, items: [{ ...initial.resolved.items[0], folder_source: '/global/skills/proof' }] } };
    let deleted = false;
    request.mockImplementation(async (url, options) => ({ ok: true, json: async () => {
      if (url === '/api/projects') return [];
      if (options?.method === 'DELETE') { deleted = true; return { archive: '/global/deleted-skills/unique/proof' }; }
      if (url.includes('/skill/delete?')) return { revision: 'whole-folder-revision', source: '/global/skills/proof', files: 3 };
      return deleted ? { ...initial, resolved: { ...initial.resolved, items: [] } } : folderAnswer;
    } }));
    render(<SharedLibrary />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Skills', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('scripts and assets');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete skill', exact: true })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete skill', exact: true })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete skill', exact: true }));
    await waitFor(() => expect(screen.queryByTestId('library-item-proof')).toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('/global/deleted-skills/unique/proof');
    expect(request).toHaveBeenCalledWith('/api/settings/library/skill/delete?id=proof', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ revision: 'whole-folder-revision' }) }));
  });
});
