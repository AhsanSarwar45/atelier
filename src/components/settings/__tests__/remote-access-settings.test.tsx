/**
 * What the Remote access section promises.
 *
 * The API is stood in for, because what these cases are about is the section:
 * that the switch cannot be turned on while something is missing, that the one
 * step needing a password is offered to copy rather than half-done, that a
 * refusal is drawn as the server wrote it, that a refusal with somewhere to go
 * is drawn as a step rather than as a fault, that the wait is visible while it
 * is happening, and that what the switch says is what came back rather than
 * what was asked for. Whether Tailscale is actually
 * there, and whether a host can be bound, are the server's questions and are
 * answered in server/src/remote.rs and server/src/routes/remote_access.rs.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAccessSettings } from '@/components/settings/remote-access-settings';
import {
  remoteAccess,
  RemoteAccessRefused,
  saveRemoteAccess,
  type RemoteAccess,
} from '@/lib/api';

vi.mock('@/lib/api', () => ({
  remoteAccess: vi.fn(),
  saveRemoteAccess: vi.fn(),
  // The real one, because the section tells a refusal it can act on from one
  // it cannot by asking what kind it is.
  RemoteAccessRefused: class extends Error {
    constructor(message: string, readonly link: string | null) {
      super(message);
      this.name = 'RemoteAccessRefused';
    }
  },
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
    // The button names what pressing it does, not the state it is sitting in.
    expect(button).toHaveTextContent('Enable');
    expect(button).toBeEnabled();

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveTextContent('Disable'));
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
    expect(button).toHaveTextContent('Enable');
  });

  it('says it is working while it waits, rather than going quiet and grey', async () => {
    read.mockResolvedValue(ready);
    let answer: (it: RemoteAccess) => void = () => {};
    save.mockReturnValue(new Promise<RemoteAccess>((settle) => { answer = settle; }));

    render(<RemoteAccessSettings />);
    const button = await screen.findByTestId('remote-serving');
    fireEvent.click(button);

    // Turning this on starts processes and waits on a daemon, so there is a
    // real wait here. A reader sitting through it in front of a dead grey
    // button cannot tell working from broken (bw-ar1o).
    await waitFor(() => expect(button).toHaveTextContent('Turning it on…'));
    expect(screen.getByTestId('remote-working')).toHaveTextContent('Asking Tailscale');

    answer({ ...ready, serving: true });

    await waitFor(() => expect(button).toHaveTextContent('Disable'));
    expect(screen.queryByTestId('remote-working')).not.toBeInTheDocument();
  });

  it('draws the one refusal that can be acted on as a step, with the link to take', async () => {
    const link = 'https://login.tailscale.com/f/serve?node=abc';
    read.mockResolvedValue(ready);
    save.mockRejectedValue(
      new RemoteAccessRefused(
        `Your Tailscale network has not turned on Serve yet. Open ${link}, allow it, then turn this on again.`,
        link,
      ),
    );

    render(<RemoteAccessSettings />);
    fireEvent.click(await screen.findByTestId('remote-serving'));

    // Somewhere to go is not a fault to report in red: it is the next thing to
    // do, and the address is a link rather than something to retype.
    const step = await screen.findByTestId('remote-next-step');
    expect(step).toHaveTextContent('has not turned on Serve yet');
    expect(screen.getByTestId('remote-next-step-link')).toHaveAttribute('href', link);
    expect(screen.queryByTestId('remote-refused')).not.toBeInTheDocument();
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
