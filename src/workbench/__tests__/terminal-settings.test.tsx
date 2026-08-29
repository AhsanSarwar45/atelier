/**
 * What the shell setting on the settings screen promises.
 *
 * The API is stood in for here, because what these cases are about is the form:
 * that it says what the computer would open on its own before anything is
 * chosen, that the shells the computer lists are offered as completions, that
 * what is typed is what is sent, and that a refusal is drawn as the server
 * wrote it with the typed path still in the field to correct. Whether a path
 * can actually be run is the server's question and is answered in
 * server/src/terminal/settings.rs, where the file is there to look at.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveTerminalSettings, terminalSettings } from '@/lib/api';
import { TerminalSettings } from '@/workbench/terminal-settings';

vi.mock('@/lib/api', () => ({
  terminalSettings: vi.fn(),
  saveTerminalSettings: vi.fn(),
}));

const read = vi.mocked(terminalSettings);
const save = vi.mocked(saveTerminalSettings);

/** What this computer lists, near enough to a real one to be worth typing. */
const listed = ['/bin/sh', '/bin/bash', '/usr/bin/fish'];

describe('choosing which shell the terminal opens', () => {
  beforeEach(() => {
    read.mockReset();
    save.mockReset();
  });

  it('names the shell the computer would open, and offers the ones it lists', async () => {
    read.mockResolvedValue({ shell: null, default: '/bin/bash', available: listed });

    render(<TerminalSettings />);
    const field = await screen.findByLabelText('Shell');

    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'System default (/bin/bash)');
    expect(field).toHaveAttribute('list', 'terminal-shells');

    const offered = Array.from(
      screen.getByTestId('terminal-shells').querySelectorAll('option'),
    ).map((option) => option.getAttribute('value'));
    expect(offered).toEqual(listed);
  });

  it('sends the path that was typed', async () => {
    read.mockResolvedValue({ shell: null, default: '/bin/bash', available: listed });
    save.mockResolvedValue({ shell: '/usr/bin/fish', default: '/bin/bash', available: listed });

    render(<TerminalSettings />);
    const field = await screen.findByLabelText('Shell');
    fireEvent.change(field, { target: { value: '/usr/bin/fish' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith('/usr/bin/fish'));
    await waitFor(() => expect(field).toHaveValue('/usr/bin/fish'));
    expect(screen.queryByTestId('terminal-shell-refused')).toBeNull();
  });

  it('draws a refusal in the words it came in, and keeps what was typed', async () => {
    const why = '/usr/bin/fsh is not a file this computer can run, so the shell was not changed.';
    read.mockResolvedValue({ shell: null, default: '/bin/bash', available: listed });
    save.mockRejectedValue(new Error(why));

    render(<TerminalSettings />);
    const field = await screen.findByLabelText('Shell');
    fireEvent.change(field, { target: { value: '/usr/bin/fsh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByTestId('terminal-shell-refused')).toHaveTextContent(why);
    expect(field).toHaveValue('/usr/bin/fsh');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the choice when the system default is asked for', async () => {
    read.mockResolvedValue({ shell: '/usr/bin/fish', default: '/bin/bash', available: listed });
    save.mockResolvedValue({ shell: null, default: '/bin/bash', available: listed });

    render(<TerminalSettings />);
    const field = await screen.findByLabelText('Shell');
    expect(field).toHaveValue('/usr/bin/fish');

    fireEvent.click(screen.getByRole('button', { name: 'Use system default' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(null));
    await waitFor(() => expect(field).toHaveValue(''));
  });
});
