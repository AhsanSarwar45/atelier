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

  it('sends each header button to the program its label names', async () => {
    render(<AgentFilesBrowser />);
    await screen.findByDisplayValue('# Hello');
    fireEvent.click(screen.getByRole('button', { name: /open in external editor/i }));
    fireEvent.click(screen.getByRole('button', { name: /reveal in file manager/i }));
    // The editor button asked for the file manager before bw-31sl.2, and the
    // reveal button asked for the folder because the server could not pick a
    // file out of it. Both now name what the reader was promised.
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(row.path, 'vscode'));
    expect(openExternal).toHaveBeenCalledWith(row.path, 'finder');
    expect(openExternal).not.toHaveBeenCalledWith('/home/me/.claude', expect.anything());
  });

  it('filters files by the words the reader types', async () => {
    render(<AgentFilesBrowser />);
    await screen.findByText('CLAUDE.md');
    fireEvent.change(screen.getByLabelText('Search agent files'), { target: { value: 'nothing-here' } });
    expect(screen.getByText('No agent files')).toBeInTheDocument();
  });

  it.each([false, true])('confirms and deletes the exact file at the selected scope (project: %s)', async (project) => {
    let removed = false;
    const file = project ? { ...row, scope: 'project', path: '/repo/CLAUDE.md' } : row;
    sendCommand.mockImplementation(async (command) => {
      if (command.type === 'agent-files.list') return { files: removed ? [] : [file] };
      if (command.type === 'agent-files.delete') { removed = true; return { ok: true }; }
      return { content: '# Hello', truncated: false };
    });
    render(<AgentFilesBrowser {...(project ? { projectPath: '/repo' } : { profileId: 'work' })} />);
    const target = await screen.findByTestId('agent-file-CLAUDE.md');
    fireEvent.contextMenu(target, { clientX: 50, clientY: 80 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete file…' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent(file.path);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(removed).toBe(false);
    fireEvent.contextMenu(target);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete file…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete file', exact: true }));
    await waitFor(() => expect(sendCommand).toHaveBeenCalledWith({ type: 'agent-files.delete', path: file.path, ...(project ? { projectPath: '/repo' } : { profileId: 'work' }) }));
    await waitFor(() => expect(screen.queryByTestId('agent-file-CLAUDE.md')).not.toBeInTheDocument());
    expect(screen.getByText('No file selected')).toBeInTheDocument();
  });

  it('keeps the file and shows a failed deletion in the confirmation', async () => {
    sendCommand.mockImplementation(async (command) => {
      if (command.type === 'agent-files.list') return { files: [row] };
      if (command.type === 'agent-files.delete') throw new Error('Permission denied');
      return { content: '# Hello', truncated: false };
    });
    render(<AgentFilesBrowser />);
    fireEvent.contextMenu(await screen.findByTestId('agent-file-CLAUDE.md'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete file…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete file', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied');
    expect(screen.getByTestId('agent-file-CLAUDE.md')).toBeInTheDocument();
  });
});
