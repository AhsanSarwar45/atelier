import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMemories } from '@/components/settings/agent-memories';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/api', () => ({ request }));

const memory = (scope: string, id: string) => ({ scope, id, description: `About ${id}`, type: 'feedback', body: `Body of ${id}`, revision: `rev-${id}`, path: `/data/${id}.md` });
const listing = (project: unknown[] | null = null) => ({ global: [memory('global', 'tone')], project, problems: [], types: ['user', 'feedback', 'project', 'reference'] });
const sent = (method: string) => JSON.parse(request.mock.calls.find(call => call[1]?.method === method)![1].body);

describe('Atelier memories editor', () => {
  beforeEach(() => request.mockReset());

  it('adds a global memory with the fields the server validates', async () => {
    request.mockResolvedValue({ ok: true, json: async () => listing() });
    render(<AgentMemories />);
    expect(await screen.findByTestId('memory-global-tone')).toHaveTextContent('About tone');
    fireEvent.click(screen.getByRole('button', { name: 'Add memory' }));
    const save = screen.getByRole('button', { name: 'Save memory' });
    fireEvent.change(screen.getByLabelText('Memory ID'), { target: { value: 'Not Valid' } });
    fireEvent.change(screen.getByLabelText('Memory description'), { target: { value: 'Owner port' } });
    fireEvent.change(screen.getByLabelText('Memory body'), { target: { value: 'Never touch 3008.' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Memory ID'), { target: { value: 'owner-port' } });
    fireEvent.click(save);
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/settings/library/memories?', expect.objectContaining({ method: 'PUT' })));
    expect(sent('PUT')).toEqual({ scope: 'global', memory: { id: 'owner-port', description: 'Owner port', type: 'feedback', body: 'Never touch 3008.' } });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved owner-port. New and reconnected chats receive this change.');
  });

  it('edits and deletes a project memory against the revision it read, and shows global memory read-only', async () => {
    request.mockResolvedValue({ ok: true, json: async () => listing([memory('project', 'port')]) });
    render(<AgentMemories projectPath="/repo one" />);
    const card = await screen.findByTestId('memory-project-port');
    expect(within(screen.getByTestId('memory-global-tone')).queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Memory ID'), { target: { value: 'owner-port' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/api/settings/library/memories?path=%2Frepo+one', expect.objectContaining({ method: 'PUT' })));
    expect(sent('PUT')).toMatchObject({ scope: 'project', previous_id: 'port', revision: 'rev-port', memory: { id: 'owner-port' } });
    fireEvent.click(within(await screen.findByTestId('memory-project-port')).getByRole('button', { name: 'Delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete memory' }));
    await waitFor(() => expect(request.mock.calls.some(call => call[1]?.method === 'DELETE')).toBe(true));
    expect(sent('DELETE')).toEqual({ scope: 'project', id: 'port', revision: 'rev-port' });
  });

  it('keeps the draft and offers a reload when the server refuses a stale edit', async () => {
    request.mockResolvedValueOnce({ ok: true, json: async () => listing() })
      .mockResolvedValueOnce({ ok: false, text: async () => 'Memory tone changed in another editor. Reload before saving' });
    render(<AgentMemories />);
    fireEvent.click(within(await screen.findByTestId('memory-global-tone')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Memory body'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('changed in another editor');
    expect(screen.getByLabelText('Memory body')).toHaveValue('Changed');
    expect(screen.getByRole('button', { name: 'Discard draft and reload' })).toBeInTheDocument();
  });
});
