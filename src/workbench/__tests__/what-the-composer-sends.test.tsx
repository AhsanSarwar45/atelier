/**
 * What the agent is handed, once the composer draws badges over what he wrote
 * (bw-gr8y.6).
 *
 * A badge is a drawing. `@src/workbench/paths.ts:12-40` is replaced on screen
 * by a pill that says `src/workbench/paths.ts:12-40`, and a reference pasted in
 * from another editor is drawn in our own form rather than the one it arrived
 * in. None of that may reach the agent: `prompt.send` has to carry the
 * characters he typed, byte for byte, or the reference the agent is asked to
 * open is not the one the reader pointed at.
 *
 * The chat around the box is stood in for down to the one command it sends.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { answering } = vi.hoisted(() => ({ answering: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/workbench/use-session', async (real) => {
  const actual = await real<typeof import('@/workbench/use-session')>();
  const { EMPTY } = await import('@/workbench/fold');
  return {
    ...actual,
    sendCommand: answering,
    useSession: () => ({ ...EMPTY, state: 'idle' as const, stateLabel: 'Idle', loadOlder: null }),
    useSessionFacts: () => null,
    useSessionFactsRead: () => null,
  };
});

vi.mock('@/workbench/live', () => ({
  useHeardFromOutside: () => 0,
  useHeldFactsAreOld: () => false,
  useHolds: () => new Map(),
  useLiveSessions: () => [],
  usePlanUsage: () => ({ available: false, plan: null, session: null, week: null, opus: null, at: null }),
  useRunningElsewhere: () => new Set<string>(),
  useRunningSaidAt: () => null,
}));

vi.mock('@/workbench/chat-sidebar', () => ({ ChatSidebar: () => null }));
vi.mock('@/workbench/chat-right-rail', () => ({
  ChatRightRail: () => null,
  useRightRail: (): [boolean, () => void] => [false, () => {}],
  useGitPanel: (): [boolean, () => void] => [false, () => {}],
  useGitDiff: () => ({ diffOpen: false, flipDiff: () => {} }),
}));
vi.mock('@/workbench/paths-on-disk', () => ({
  usePathsOnDisk: () => ({ real: () => false, home: '/home/me', ask: () => {} }),
}));
vi.mock('@/workbench/known-cards', () => ({
  useKnownCards: () => new Set<string>(),
  useKnownCardStatuses: () => new Map<string, string>(),
}));

const { default: ChatTab } = await import('@/workbench/chat-tab');

beforeEach(() => {
  answering.mockReset();
  answering.mockImplementation(async () => ({ messageId: 'm1' }));
  localStorage.clear();
  vi.stubGlobal('WebSocket', class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
});

/** The line he wrote, as the server was told it. */
function whatWasSent(): string {
  const send = answering.mock.calls.map(([c]) => c).find((c: { type: string }) => c.type === 'prompt.send');
  expect(send, 'the chat sent a prompt').toBeTruthy();
  return (send as { text: string }).text;
}

describe('a line with references in it', () => {
  it('reaches the agent as the characters he typed, not as the badges he saw', async () => {
    // Three shapes at once: ours, the one a JetBrains plugin pastes, and a
    // folder. All three are drawn differently from how they are written.
    const line = 'Compare @src/workbench/paths.ts:12-40 with @src/a.ts#L3-L9 under @docs/designs/';
    const { container } = render(<ChatTab projectId="p1" projectPath="/home/me/project" openSessionId="s1" />);
    await act(async () => {});

    // Written into the drawn line itself, which is where a reader writes it.
    const editor = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
    await act(async () => {
      editor.dispatch({ changes: { from: 0, insert: line } });
    });

    // All three are badges on screen, and not one of them says what it stands
    // for: two were shortened and one was rewritten into our own form.
    const badges = [...container.querySelectorAll('[data-testid="composer-reference"]')].map((b) =>
      b.getAttribute('data-reference'),
    );
    expect(badges).toEqual(['src/workbench/paths.ts:12-40', 'src/a.ts:3-9', 'docs/designs/']);
    expect(screen.getByTestId('composer')).toHaveValue(line);

    await act(async () => {
      fireEvent.keyDown(editor.contentDOM, { key: 'Enter' });
    });

    expect(whatWasSent()).toBe(line);
  });
});
