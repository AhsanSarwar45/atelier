import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFilesBrowser } from '@/components/agent-files-browser';

const { sendCommand, openExternal, toast } = vi.hoisted(() => ({ sendCommand: vi.fn(), openExternal: vi.fn(), toast: vi.fn() }));
vi.mock('@/workbench/use-session', () => ({ sendCommand }));
vi.mock('@/lib/api', () => ({ fs: { openExternal } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));

const row = { id: 'claude-user', provider: 'claude', scope: 'personal', category: 'instructions', name: 'CLAUDE.md', path: '/home/me/.claude/CLAUDE.md', relativePath: 'CLAUDE.md', format: 'markdown', size: 12, modifiedAt: '2026-08-28T00:00:00.000Z' };

describe('Agent files browser', () => {
  beforeEach(() => {
    sendCommand.mockReset(); openExternal.mockReset(); toast.mockReset();
    sendCommand.mockImplementation((command) => Promise.resolve(command.type === 'agent-files.list' ? { files: [row] } : { content: '# Hello', truncated: false }));
    openExternal.mockResolvedValue({ success: true });
  });

  it('lists and reads discovered files without edit controls', async () => {
    render(<AgentFilesBrowser projects={[{ id: 'p', name: 'beads-web', path: '/repo' }]} />);
    expect((await screen.findAllByText('CLAUDE.md')).length).toBe(2);
    expect(await screen.findByText('# Hello')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.list' });
    expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.read', path: row.path });
  });

  it('opens the file and its containing folder only after explicit clicks', async () => {
    render(<AgentFilesBrowser projects={[]} />);
    await screen.findByText('# Hello');
    fireEvent.click(screen.getByRole('button', { name: /open in editor/i }));
    fireEvent.click(screen.getByRole('button', { name: /reveal in file manager/i }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(row.path, 'finder'));
    expect(openExternal).toHaveBeenCalledWith('/home/me/.claude', 'finder');
  });

  it('filters files by the words the reader types', async () => {
    render(<AgentFilesBrowser projects={[]} />);
    await screen.findByText('CLAUDE.md');
    fireEvent.change(screen.getByLabelText('Search agent files'), { target: { value: 'nothing-here' } });
    expect(screen.getByText('No agent files found')).toBeInTheDocument();
  });
});
