/**
 * What the app's bars promise: there are two of them and never a third, and the
 * first one ends with the way to a shell beside the way out to settings.
 *
 * The count is the point of most of this. `data-shell-bar` is what the
 * acceptance suite reads in a real browser (`tests/e2e/shell.spec.ts`), and a
 * control that could not be fitted onto one of the two bars would show up here
 * as a third — including the terminal, which opens a window over the whole page
 * and must add nothing to the page's own chrome.
 *
 * The window that opens is the real one, with the real shells behind it. Three
 * things are stood in for, and all three are things jsdom does not have rather
 * than things this file did not want: the server, the socket, and the media
 * queries the terminal's renderer asks about the moment it opens. What the pane
 * does with a socket once it has one is its own suite's business
 * (`src/workbench/__tests__/terminal-pane.test.tsx`).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Shell } from '@/components/shell';
import { Terminals } from '@/workbench/terminal-tabs';

/** The shape of an answer, with only the parts anything here reads. */
const answers = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

/** A socket that goes nowhere; the pane only has to be able to make one. */
class Socket {
  static readonly OPEN = 1;
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((frame: { data: unknown }) => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) =>
    (init?.method ?? 'GET') === 'POST' ? answers({ id: 'opened-1' }) : answers([]),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A screen with both bars, inside the app's one set of shells. */
function draw() {
  return render(
    <Terminals>
      <Shell bar={<span>corsetta</span>} tabs={<span>Board</span>} activeTab="board">
        <div>the work</div>
      </Shell>
    </Terminals>,
  );
}

/** Every bar in the page, however it got there. */
const bars = () => document.querySelectorAll('[data-shell-bar]');

const terminalButton = () => screen.getByRole('button', { name: 'Terminal' });

describe('the app’s bars', () => {
  it('draws two of them and no more', () => {
    draw();
    expect(bars(), 'the project bar, then the tabs and their tools; nothing else').toHaveLength(2);
  });

  it('ends the first bar with the way to a shell beside the way out to settings', () => {
    draw();
    const first = screen.getByTestId('project-bar');
    const shell = within(first).getByRole('button', { name: 'Terminal' });
    const settings = within(first).getByRole('link', { name: 'Settings' });

    expect(
      shell.parentElement,
      'the two ways off this screen end the bar together, in the same corner',
    ).toBe(settings.parentElement);
    expect(
      within(screen.getByTestId('tab-bar')).queryByRole('button', { name: 'Terminal' }),
      'the way to a shell belongs to the app, not to whichever tab is open',
    ).toBeNull();
  });

  it('opens the window from the bar, without adding a bar to open it', async () => {
    draw();
    expect(
      screen.queryByTestId('terminal-window'),
      'nothing is drawn until somebody asks for a shell',
    ).toBeNull();

    fireEvent.click(terminalButton());

    expect(screen.getByTestId('terminal-window'), 'the button opens the window').toBeInTheDocument();
    expect(bars(), 'and the window is a window, not a third bar').toHaveLength(2);
    await waitFor(() => expect(screen.getAllByTestId('terminal-tab')).toHaveLength(1));
    expect(
      within(screen.getByTestId('terminal-window')).getByTestId('terminal-tab-strip'),
      'the tabs are inside the window, where the shells are',
    ).toBeInTheDocument();
  });

  it('opens the same one window from whichever screen asks', async () => {
    render(
      <Terminals>
        <Shell bar={<span>the project list</span>}>
          <div>projects</div>
        </Shell>
        <Shell bar={<span>corsetta</span>} tabs={<span>Board</span>} activeTab="board">
          <div>the work</div>
        </Shell>
      </Terminals>,
    );

    const [fromTheList, fromTheProject] = screen.getAllByRole('button', { name: 'Terminal' });
    fireEvent.click(fromTheList);
    await waitFor(() => expect(screen.getAllByTestId('terminal-tab')).toHaveLength(1));
    fireEvent.click(fromTheProject);

    expect(
      screen.getAllByTestId('terminal-window'),
      'one window, whichever bar was pressed; the shells in it are the app’s',
    ).toHaveLength(1);
    expect(screen.getAllByTestId('terminal-tab'), 'and the shell already running is still the only one').toHaveLength(1);
  });
});
