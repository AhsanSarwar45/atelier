import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RestoreRow } from '@/workbench/protocol';

class FakeStream {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close(): void {}
}

class FakeFoot {
  observe(): void {}
  disconnect(): void {}
}

const chat: RestoreRow = {
  sessionId: 'atelier-session-1',
  externalId: 'provider-session-1',
  brand: 'claude',
  title: 'Original name',
  name: 'Original name',
  lastActiveAt: '2026-09-14T10:00:00.000Z',
  state: 'dormant',
  origin: 'app',
  projectId: 'project-1',
  cwdHint: '/project',
  folder: 'project',
  branch: 'main',
  beads: [],
};

let commands: Record<string, unknown>[];
let clipboard: ReturnType<typeof vi.fn>;

async function draw(expected = 'Original name') {
  vi.resetModules();
  const { ChatSidebar } = await import('@/workbench/chat-sidebar');
  render(<ChatSidebar projectId="project-1" projectPath="/project" openSessionId={null} onOpen={() => {}} />);
  await waitFor(() => expect(screen.queryByText(expected)).not.toBeNull());
}

async function openMenu() {
  fireEvent.contextMenu(screen.getByTestId('restore-row'), { clientX: 80, clientY: 120 });
  await waitFor(() => expect(screen.queryByTestId('chat-context-menu')).not.toBeNull());
}

beforeEach(() => {
  commands = [];
  clipboard = vi.fn(async () => undefined);
  vi.stubGlobal('WebSocket', FakeStream);
  vi.stubGlobal('IntersectionObserver', FakeFoot);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      commands.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => [chat] } as Response;
  }));
});

afterEach(() => vi.unstubAllGlobals());

it('right-clicking a chat offers rename and copy ID without opening it', async () => {
  await draw();
  await openMenu();

  expect(within(screen.getByTestId('chat-context-menu')).getByText('Rename…')).toBeVisible();
  fireEvent.click(screen.getByTestId('chat-menu-copy-id'));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith('atelier-session-1'));
});

it('renames the chosen chat and updates its row', async () => {
  await draw();
  await openMenu();
  fireEvent.click(screen.getByTestId('chat-menu-rename'));

  const input = await screen.findByLabelText('Chat name');
  fireEvent.change(input, { target: { value: 'Release planning' } });
  await act(async () => void fireEvent.submit(input.closest('form')!));

  await waitFor(() => expect(screen.queryByText('Release planning')).not.toBeNull());
  expect(commands.filter((command) => command.type === 'session.rename')).toEqual([
    { type: 'session.rename', sessionId: 'atelier-session-1', title: 'Release planning' },
  ]);
});

it('copies the provider ID for a chat not imported into Atelier yet', async () => {
  const outside = { ...chat, sessionId: null, title: 'Outside chat', name: 'Outside chat' };
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [outside] }) as Response));
  await draw('Outside chat');
  await openMenu();

  expect(screen.getByTestId('chat-menu-rename')).toHaveAttribute('data-disabled');
  fireEvent.click(screen.getByTestId('chat-menu-copy-id'));
  await waitFor(() => expect(clipboard).toHaveBeenCalledWith('provider-session-1'));
});

it('opens the same menu from the row button, for a thumb that cannot right-click', async () => {
  await draw();
  fireEvent.click(screen.getByTestId('row-menu'));
  await waitFor(() => expect(screen.queryByTestId('chat-context-menu')).not.toBeNull());

  const menu = within(screen.getByTestId('chat-context-menu'));
  expect(menu.getByText('Rename…')).toBeVisible();
  expect(menu.getByText('Copy ID')).toBeVisible();
  expect(menu.getByText('Close chat')).toBeVisible();
});

it('closes a running chat from the row menu', async () => {
  const running = { ...chat, state: 'idle' as const, title: 'Running chat', name: 'Running chat' };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      commands.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    return { ok: true, json: async () => [running] } as Response;
  }));
  await draw('Running chat');
  fireEvent.click(screen.getByTestId('row-menu'));
  await waitFor(() => expect(screen.queryByTestId('chat-context-menu')).not.toBeNull());

  await act(async () => void fireEvent.click(screen.getByTestId('chat-menu-close')));
  await waitFor(() => expect(commands).toContainEqual({ type: 'session.close', sessionId: 'atelier-session-1' }));
});

it('greys the close item on a chat with nothing of ours attached', async () => {
  await draw();
  fireEvent.click(screen.getByTestId('row-menu'));
  await waitFor(() => expect(screen.queryByTestId('chat-context-menu')).not.toBeNull());

  expect(screen.getByTestId('chat-menu-close')).toHaveAttribute('data-disabled');
});
