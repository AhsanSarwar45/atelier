/**
 * What the Remote access section promises.
 *
 * The API is stood in for, because what these cases are about is the section:
 * that the switch cannot be turned on while something is missing, that the one
 * step needing a password is offered to copy rather than half-done, that a
 * refusal is drawn as the server wrote it, that a refusal with somewhere to go
 * is drawn as a step rather than as a fault, that the wait is visible while it
 * is happening, that the address is shown with where it came from, that who can
 * reach it is two named doors rather than an address to type, and that what
 * the switch says is what came back rather than what was asked for. Whether
 * Tailscale is actually there, and whether a host can be bound, are the
 * server's questions and are answered in server/src/remote.rs and
 * server/src/routes/remote_access.rs.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAccessSettings, shutsTheDoor } from '@/components/settings/remote-access-settings';
import {
  remoteAccess,
  RemoteAccessRefused,
  restartApp,
  saveRemoteAccess,
  type RemoteAccess,
} from '@/lib/api';

vi.mock('@/lib/api', () => ({
  remoteAccess: vi.fn(),
  saveRemoteAccess: vi.fn(),
  restartApp: vi.fn(),
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
  homeAddress: 'http://desk.local:3008',
  bindHost: null,
  bindHostDefault: '0.0.0.0',
  port: 3008,
  nextPort: null,
  needsRestart: false,
  canRestart: true,
  renameCommand: 'sudo hostnamectl set-hostname new-name',
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

  it('shows the address before it is on, and says where the name came from', async () => {
    // The address is the whole point of the section and the thing a reader
    // decides on, so waiting for the switch to be on hides it exactly when it
    // would be read. And it is a name nobody chose, so the screen says whose
    // name it is rather than leaving a box that looks like it sets it
    // (bw-t2m2).
    read.mockResolvedValue(ready);

    render(<RemoteAccessSettings />);

    expect(await screen.findByTestId('remote-address')).toHaveTextContent(
      'https://desk.tailnet.ts.net',
    );
    expect(screen.getByTestId('remote-serving')).toHaveTextContent('Enable');
    // Every address is the same three controls, and the edit for this one
    // goes where the address is really changed (bw-t2m2.4).
    expect(screen.getByLabelText('Rename this computer in Tailscale')).toHaveAttribute(
      'href',
      'https://login.tailscale.com/admin/machines',
    );
  });

  it('offers a restart, rather than telling the reader a change applies later', async () => {
    // "Applies after restart" is a note, not a control. If the change cannot
    // take effect now, the screen has to offer the restart it is waiting for.
    read.mockResolvedValue({ ...ready, nextPort: 4000, needsRestart: true });

    render(<RemoteAccessSettings />);

    const row = await screen.findByTestId('remote-restart');
    expect(row).toHaveTextContent('http://desk.local:4000');
    fireEvent.click(screen.getByTestId('remote-restart-now'));

    await waitFor(() => expect(restartApp).toHaveBeenCalled());
  });

  it('checks neither door when the stored address is neither of them', async () => {
    // Checking the open one would be a claim about who can reach this board,
    // made from a value that says something else.
    read.mockResolvedValue({ ...ready, bindHost: '192.168.1.13' });

    render(<RemoteAccessSettings />);

    expect(await screen.findByTestId('remote-host-odd')).toHaveTextContent('192.168.1.13');
    expect(screen.getByTestId('remote-reach-everyone')).not.toBeChecked();
    expect(screen.getByTestId('remote-reach-here')).not.toBeChecked();
  });

  it('shows the command for the half of the address it cannot change itself', async () => {
    // The port is this app's. The name is the computer's, and renaming it
    // needs root, so the box hands over the command rather than the job.
    read.mockResolvedValue(ready);

    render(<RemoteAccessSettings />);
    fireEvent.click(await screen.findByLabelText('Change the port'));

    expect(screen.getByTestId('remote-rename-command')).toHaveTextContent(
      'sudo hostnamectl set-hostname new-name',
    );
  });

  it('goes to the new port after the restart, not the one nothing answers on', async () => {
    // The restart the reader pressed is the one that moves the app. Reloading
    // this address would land on the port it just left.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const where = { port: '3008', reload: vi.fn() };
    const own = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', { value: where, writable: true, configurable: true });
    read.mockResolvedValue({ ...ready, port: 3008, nextPort: 4000, needsRestart: true });

    render(<RemoteAccessSettings />);
    fireEvent.click(await screen.findByTestId('remote-restart-now'));
    await waitFor(() => expect(restartApp).toHaveBeenCalled());
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(where.port).toBe('4000');
    expect(where.reload).not.toHaveBeenCalled();
    vi.useRealTimers();
    if (own) Object.defineProperty(window, 'location', own);
  });

  it('says what to do instead when nothing would start it again', async () => {
    // Started by hand in a terminal: stopping is not restarting, and a button
    // saying otherwise would take the board away.
    read.mockResolvedValue({ ...ready, nextPort: 4000, needsRestart: true, canRestart: false });

    render(<RemoteAccessSettings />);

    expect(await screen.findByTestId('remote-restart')).toHaveTextContent('Quit Atelier');
    expect(screen.queryByTestId('remote-restart-now')).not.toBeInTheDocument();
  });

  it('changes the port from the address it belongs to', async () => {
    read.mockResolvedValue(ready);
    save.mockResolvedValue({ ...ready, nextPort: 4000, needsRestart: true });

    render(<RemoteAccessSettings />);
    fireEvent.click(await screen.findByLabelText('Change the port'));
    fireEvent.change(screen.getByTestId('remote-port-input'), { target: { value: '4000' } });
    fireEvent.click(screen.getByTestId('remote-port-save'));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ port: 4000 }));
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
    expect(screen.getByTestId('remote-working')).toHaveTextContent('Contacting Tailscale');

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

  it('offers who can reach it as two doors, and saves the one picked', async () => {
    // The old box wanted an IP address for a question a reader asks in words,
    // and any address typed into it could lock them out (bw-t2m2.3).
    read.mockResolvedValue(ready);
    save.mockResolvedValue({ ...ready, bindHost: '127.0.0.1' });

    render(<RemoteAccessSettings />);
    const everyone = await screen.findByTestId('remote-reach-everyone');
    const here = screen.getByTestId('remote-reach-here');
    // Nothing stored means the default, which lets the home network in.
    expect(everyone).toBeChecked();

    fireEvent.click(here);

    await waitFor(() => expect(here).toBeChecked());
    expect(save).toHaveBeenCalledWith({ bindHost: '127.0.0.1' });
  });

  it('draws a stored address that is neither door as itself, rather than guessing', async () => {
    // Rounding somebody's own address to whichever door looks closer would be
    // guessing about who can reach their board, which is the one place not to.
    read.mockResolvedValue({ ...ready, bindHost: '192.168.1.13' });

    render(<RemoteAccessSettings />);

    expect(await screen.findByTestId('remote-host-odd')).toHaveTextContent('192.168.1.13');
  });

  it("draws a refusal in the server's words", async () => {
    read.mockResolvedValue(ready);
    save.mockRejectedValue(new Error('my-desk is not an address this computer can listen on.'));

    render(<RemoteAccessSettings />);
    fireEvent.click(await screen.findByTestId('remote-reach-here'));

    expect(await screen.findByTestId('remote-refused')).toHaveTextContent(
      'my-desk is not an address this computer can listen on.',
    );
  });

  it('knows which stored addresses shut the door on the network', () => {
    expect(shutsTheDoor('127.0.0.1')).toBe(true);
    expect(shutsTheDoor('::1')).toBe(true);
    expect(shutsTheDoor('localhost')).toBe(true);
    expect(shutsTheDoor('0.0.0.0')).toBe(false);
    expect(shutsTheDoor(null)).toBe(false);
  });
});
