/**
 * The rail comes back on the view it was left on (bw-8dp8.5).
 *
 * Which view the rail is showing is a way of looking, not a fact about one
 * chat: a manager working out of the Git panel wants it there in the next chat
 * too, and after the next reload — the same reason the rail's own open-or-shut
 * and the kind filter's switches are remembered for the browser (bw-qdim).
 *
 * The failure this pins down is a real one and has already happened once here:
 * a hook that mirrors its state into storage from an effect runs that effect on
 * the way in, with the value the screen STARTED at, and overwrites what was
 * remembered before the effect that reads it has run. It passes every test that
 * only flips the switch and looks at the screen. It fails this one, because
 * this one throws the screen away and builds it again.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGitPanel } from '@/workbench/chat-right-rail';

// The rail's chips navigate; nothing here draws one, and this is only what
// stands between importing the module and a page with no router mounted.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** A screen with nothing on it but the hook's answer and the way to flip it. */
function Harness() {
  const [showing, flip] = useGitPanel();
  return (
    <button type="button" data-testid="view" data-open={showing} onClick={flip}>
      {showing ? 'Git' : 'This chat'}
    </button>
  );
}

/** What the rail says it is showing, this time round. */
const showing = () => screen.getByTestId('view').textContent;

describe('the rail remembers which view it is on', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens on the chat with nothing remembered', () => {
    render(<Harness />);

    expect(showing()).toBe('This chat');
    expect(screen.getByTestId('view')).toHaveAttribute('data-open', 'false');
  });

  it('writes the choice down where it is made', () => {
    render(<Harness />);

    fireEvent.click(screen.getByTestId('view'));

    expect(showing()).toBe('Git');
    expect(localStorage.getItem('workbench.git-panel')).toBe('1');
  });

  it('comes back on Git after the screen is thrown away and built again', () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByTestId('view'));
    expect(showing()).toBe('Git');

    first.unmount();
    render(<Harness />);

    expect(showing()).toBe('Git');
    expect(screen.getByTestId('view')).toHaveAttribute('data-open', 'true');
  });

  it('comes back on the chat after Git was shut again', () => {
    const first = render(<Harness />);
    fireEvent.click(screen.getByTestId('view'));
    fireEvent.click(screen.getByTestId('view'));
    expect(localStorage.getItem('workbench.git-panel')).toBe('0');

    first.unmount();
    render(<Harness />);

    expect(showing()).toBe('This chat');
  });

  it('opens on Git for a browser that was left on it, without being asked twice', () => {
    localStorage.setItem('workbench.git-panel', '1');

    render(<Harness />);

    expect(showing()).toBe('Git');
    // Mounting must not write anything back: the mirror-from-an-effect bug
    // shows up here as a '0' landing on top of the '1' that was read.
    expect(localStorage.getItem('workbench.git-panel')).toBe('1');
  });
});
