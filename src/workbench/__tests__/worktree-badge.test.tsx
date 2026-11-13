/**
 * The chat's folder chip opens the project's worktrees: their size, branch and
 * chats, with Move here for the open chat and Delete for any worktree but the
 * project's own.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorktreeBadge } from '@/workbench/worktree-badge';

const request = vi.fn();
vi.mock('@/lib/api', () => ({ request: (...args: unknown[]) => request(...args) }));

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const TREES = {
  trees: [
    { path: '/work/shop', name: 'shop', branch: 'main', isMain: true, dirty: false, bytes: 2 * GB,
      chats: [{ sessionId: 'other', title: 'Fix checkout', state: 'idle' }] },
    { path: '/work/trees/search', name: 'search', branch: 'search', isMain: false, dirty: false, bytes: 1.5 * GB,
      chats: [{ sessionId: 'chat-1', title: 'Build search', state: 'idle' }] },
    { path: '/work/trees/cart', name: 'cart', branch: 'cart-redo', isMain: false, dirty: true, bytes: 300 * MB, chats: [] },
  ],
};

/** The commands the badge posted, in order. */
const posted = () =>
  request.mock.calls
    .filter(([url, init]) => url === '/api/workbench/command' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
const sentOf = (type: string) => posted().filter((command) => command.type === type);

beforeEach(() => {
  request.mockImplementation(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    if (url === '/api/workbench/command' && body.type === 'worktrees.list') {
      return { ok: true, json: async () => TREES };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  });
});
afterEach(() => vi.clearAllMocks());

function badge() {
  render(<WorktreeBadge sessionId="chat-1" projectPath="/work/shop" cwd="/work/trees/search" />);
}

const row = (name: string) =>
  screen.getAllByTestId('worktree-row').find((one) => one.getAttribute('data-name') === name)!;

describe('worktree badge', () => {
  it('opens the worktree list from the folder chip, with the size of the chat\'s own worktree inside', async () => {
    badge();
    const chip = await screen.findByTestId('worktree-badge');
    // The chip names the folder; the sizes live in the list it opens.
    expect(chip).toHaveTextContent('search');
    expect(chip).not.toHaveTextContent('GB');
    fireEvent.click(chip);
    await screen.findByTestId('worktree-popup');
    expect(row('search')).toHaveTextContent('1.5 GB');
    expect(sentOf('worktrees.list')[0]).toMatchObject({ projectPath: '/work/shop' });
  });

  it('lists the project\'s worktrees with their size, branch and chats', async () => {
    badge();
    fireEvent.click(await screen.findByTestId('worktree-badge'));
    await screen.findByTestId('worktree-popup');
    expect(screen.getAllByTestId('worktree-row').map((one) => one.getAttribute('data-name'))).toEqual(['shop', 'search', 'cart']);
    expect(row('shop')).toHaveTextContent('2.0 GB');
    expect(row('shop')).toHaveTextContent('Fix checkout');
    expect(row('cart')).toHaveTextContent('cart-redo');
    expect(row('cart')).toHaveTextContent('300 MB');
    expect(row('cart')).toHaveTextContent('Uncommitted changes');
    expect(row('search')).toHaveTextContent('This chat');
  });

  it('moves the chat to another worktree', async () => {
    badge();
    fireEvent.click(await screen.findByTestId('worktree-badge'));
    await screen.findByTestId('worktree-popup');
    expect(within(row('search')).queryByRole('button', { name: 'Move here' })).toBeNull();
    fireEvent.click(within(row('cart')).getByRole('button', { name: 'Move here' }));
    await waitFor(() => expect(sentOf('session.move')).toEqual([
      { type: 'session.move', sessionId: 'chat-1', cwd: '/work/trees/cart' },
    ]));
  });

  it('deletes a worktree only after it is confirmed, and never the project\'s own folder', async () => {
    badge();
    fireEvent.click(await screen.findByTestId('worktree-badge'));
    await screen.findByTestId('worktree-popup');
    expect(within(row('shop')).queryByRole('button', { name: 'Delete' })).toBeNull();

    fireEvent.click(within(row('search')).getByRole('button', { name: 'Delete' }));
    expect(sentOf('worktree.delete')).toEqual([]);
    const confirm = await screen.findByTestId('worktree-delete-confirm');
    expect(confirm).toHaveTextContent('Build search');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete worktree' }));
    await waitFor(() => expect(sentOf('worktree.delete')).toEqual([
      { type: 'worktree.delete', projectPath: '/work/shop', path: '/work/trees/search', force: false },
    ]));
  });

  it('warns that uncommitted changes will be lost before deleting a worktree that has them', async () => {
    badge();
    fireEvent.click(await screen.findByTestId('worktree-badge'));
    await screen.findByTestId('worktree-popup');
    fireEvent.click(within(row('cart')).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByTestId('worktree-delete-confirm');
    expect(confirm).toHaveTextContent('uncommitted changes will be lost');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete anyway' }));
    await waitFor(() => expect(sentOf('worktree.delete')).toEqual([
      { type: 'worktree.delete', projectPath: '/work/shop', path: '/work/trees/cart', force: true },
    ]));
  });
});
