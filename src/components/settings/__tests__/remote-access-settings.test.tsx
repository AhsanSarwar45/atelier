/**
 * What the Remote access section promises.
 *
 * The API is stood in for, because what these cases are about is the section:
 * that the switch cannot be turned on while something is missing, that the one
 * step needing a password is offered to copy rather than half-done, that a
 * refusal is drawn as the server wrote it, and that what the switch says is
 * what came back rather than what was asked for. Whether Tailscale is actually
 * there, and whether a host can be bound, are the server's questions and are
 * answered in server/src/remote.rs and server/src/routes/remote_access.rs.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAccessSettings } from '@/components/settings/remote-access-settings';
import { remoteAccess, saveRemoteAccess, type RemoteAccess } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  remoteAccess: vi.fn(),
  saveRemoteAccess: vi.fn(),
}));

const read = vi.mocked(remoteAccess);
const save = vi.mocked(saveRemoteAccess);

/** A computer with nothing set up yet, which is where everybody starts. */
const nothing: RemoteAccess = {
  standing: 'not-installed',
  wrong: 'Tailscale is not installed. Run `atelier remote install` in a terminal.',
  serving: false,
  address: null,
  bindHost: null,
  bindHostDefault: '0.0.0.0',
  publicUrl: null,
  publishing: null,
  port: 3008,
};

/** The same computer once the command has been run and it has signed in. */
const ready: RemoteAccess = {
  ...nothing,
  standing: 'ready',
  wrong: null,
  address: 'https://desk.tailnet.ts.net',
};

describe('the Remote access section', () => {
  beforeEach(() => {
    read.mockReset();
    save.mockReset();
  });

  it('offers the one step that needs a password rather than pretending to do it', async () => {
    read.mockResolvedValue(nothing);

    render(<RemoteAccessSettings />);

    expect(await screen.findByText('atelier remote install')).toBeInTheDocument();
    // Turning it on now would leave the switch saying on over a board nobody
    // can reach, which is worse than saying what is missing.
    expect(screen.getByTestId('remote-serving')).toBeDisabled();
  });

  it('turns serving on once there is nothing missing, and shows the address', async () => {
    read.mockResolvedValue(ready);
    save.mockResolvedValue({ ...ready, serving: true });

    render(<RemoteAccessSettings />);
    const button = await screen.findByTestId('remote-serving');
    expect(button).toHaveTextContent('Off');
    expect(button).toBeEnabled();

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveTextContent('On'));
    expect(save).toHaveBeenCalledWith({ serving: true });
    expect(screen.getByTestId('remote-address')).toHaveTextContent('https://desk.tailnet.ts.net');
  });

  it('says off when the server says off, whatever the switch was asked to do', async () => {
    read.mockResolvedValue(ready);
    // Tailscale took the command and did not serve. What is drawn is what came
    // back, because a switch reporting its own hopes is the failure this
    // section exists to avoid.
    save.mockResolvedValue({ ...ready, serving: false });

    render(<RemoteAccessSettings />);
    const button = await screen.findByTestId('remote-serving');
    fireEvent.click(button);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(button).toHaveTextContent('Off');
  });

  it("draws a refused host in the server's words, leaving what was typed to correct", async () => {
    read.mockResolvedValue(nothing);
    save.mockRejectedValue(new Error('my-desk is not an address this computer can listen on.'));

    render(<RemoteAccessSettings />);
    const field = await screen.findByLabelText('Listen on');
    fireEvent.change(field, { target: { value: 'my-desk' } });
    fireEvent.click(screen.getByTestId('remote-host-save'));

    expect(await screen.findByTestId('remote-refused')).toHaveTextContent(
      'my-desk is not an address this computer can listen on.',
    );
    expect(field).toHaveValue('my-desk');
  });
});
