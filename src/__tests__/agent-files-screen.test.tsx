import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFilesBrowser } from '@/components/agent-files-browser';

const { sendCommand, openExternal, toast } = vi.hoisted(() => ({ sendCommand: vi.fn(), openExternal: vi.fn(), toast: vi.fn() }));
vi.mock('@/workbench/use-session', () => ({ sendCommand }));
vi.mock('@/lib/api', () => ({ fs: { openExternal } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/workbench/code-editor', () => ({
  CodeEditor: ({ text, onChange }: { text: string; onChange?: (text: string) => void }) => (
    <textarea aria-label="File text" value={text} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

const row = { id: 'claude-user', provider: 'claude', scope: 'personal', category: 'instructions', name: 'CLAUDE.md', path: '/home/me/.claude/CLAUDE.md', relativePath: 'CLAUDE.md', format: 'markdown', size: 12, modifiedAt: '2026-08-28T00:00:00.000Z' };

describe('Agent files browser', () => {
  beforeEach(() => {
    sendCommand.mockReset(); openExternal.mockReset(); toast.mockReset();
    sendCommand.mockImplementation((command) => Promise.resolve(command.type === 'agent-files.list' ? { files: [row] } : { content: '# Hello', truncated: false }));
    openExternal.mockResolvedValue({ success: true });
  });

  it('lists and reads discovered files, and saves only once the text has changed', async () => {
    render(<AgentFilesBrowser />);
    expect((await screen.findAllByText('CLAUDE.md')).length).toBe(2);
    expect(await screen.findByDisplayValue('# Hello')).toBeInTheDocument();
    expect(screen.getByTestId('agent-file-save')).toBeDisabled();
    expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.list' });
    expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.read', path: row.path });

    fireEvent.change(screen.getByLabelText('File text'), { target: { value: '# Hello there' } });
    expect(screen.getByTestId('agent-file-dirty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-file-save'));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.write', path: row.path, content: '# Hello there' }));
  });

  it('asks for one account\'s files when told the account', async () => {
    render(<AgentFilesBrowser profileId="work" brand="claude" />);
    await screen.findByDisplayValue('# Hello');
    expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.list', profileId: 'work' });
  });

  it('opens the file and its containing folder only after explicit clicks', async () => {
    render(<AgentFilesBrowser />);
    await screen.findByDisplayValue('# Hello');
    fireEvent.click(screen.getByRole('button', { name: /open in external editor/i }));
    fireEvent.click(screen.getByRole('button', { name: /reveal in file manager/i }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(row.path, 'finder'));
    expect(openExternal).toHaveBeenCalledWith('/home/me/.claude', 'finder');
  });

  it('filters files by the words the reader types', async () => {
    render(<AgentFilesBrowser />);
    await screen.findByText('CLAUDE.md');
    fireEvent.change(screen.getByLabelText('Search agent files'), { target: { value: 'nothing-here' } });
    expect(screen.getByText('No agent files')).toBeInTheDocument();
  });
});
