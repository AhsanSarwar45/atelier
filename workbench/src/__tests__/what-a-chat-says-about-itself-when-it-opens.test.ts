/**
 * @vitest-environment node
 *
 * What a chat says about its own settings, and when it keeps quiet (bw-6jq5.2).
 *
 * A line saying the mode is now bypassPermissions is worth having: the tool
 * changes the mode by itself, and a chat that quietly stopped asking before it
 * touches anything is a trap (bw-1u1.43). What is not worth having is the same
 * sentence at the top of every conversation, saying nothing changed — 37 of
 * them in the manager's own record over three days, every one the first line of
 * its chat, all of them announcing the mode it opened in.
 *
 * The difference is whether anybody CHOSE it, and that is what these hold: the
 * mode a chat opened in passes without a word, a mode that changes says so, and
 * a mode the reader asks for says so even when it is the first thing the chat
 * does.
 */
import { describe, expect, it } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';

/**
 * One event out of a driver, `emit` reached past its privacy the way the rest
 * of these tests reach it: the alternative is `start()`, which launches a real
 * agent process.
 */
type Said = { type: string; kind?: string; text?: string; permissionMode?: string | null };
const listen = (driver: ClaudeDriver, hear: (e: Said) => void) => {
  (driver as unknown as { emit: (e: Said) => void }).emit = hear;
};

/** What the kit says as a chat comes up, and on every request after it. */
const OPENED = {
  type: 'system',
  subtype: 'init',
  session_id: 's1',
  model: 'claude-opus-5',
  cwd: '/tmp',
  permissionMode: 'default',
};
const status = (mode: string) => ({ type: 'system', subtype: 'status', permissionMode: mode });

/** Every sentence one driver says about the mode while it is fed these. */
function saidAboutTheMode(feed: (driver: ClaudeDriver) => void): string[] {
  const said: string[] = [];
  const driver = new ClaudeDriver();
  listen(driver, (e) => {
    if (e.type === 'note' && e.kind === 'mode') said.push(String(e.text));
  });
  feed(driver);
  return said;
}

describe('what a chat says about its own settings', () => {
  it('says nothing about the mode it opened in', () => {
    const said = saidAboutTheMode((d) => {
      d.draw(OPENED);
      d.draw(status('default'));
      d.draw(status('default'));
    });

    expect(said).toEqual([]);
  });

  it('says so once when the mode actually changes', () => {
    const said = saidAboutTheMode((d) => {
      d.draw(OPENED);
      d.draw(status('default'));
      d.draw(status('bypassPermissions'));
      d.draw(status('bypassPermissions'));
    });

    expect(said).toEqual(['Permission mode is now bypassPermissions.']);
  });

  // A chat that comes up already in plan mode is still a chat nobody switched:
  // the mode it opened in is the mode it opened in, whatever it is.
  it('keeps quiet about an opening mode that is not the ordinary one', () => {
    const said = saidAboutTheMode((d) => {
      d.draw({ ...OPENED, permissionMode: 'plan' });
      d.draw(status('plan'));
    });

    expect(said).toEqual([]);
  });

  it('speaks when the reader asks for a mode, even as the first thing the chat does', async () => {
    const said: string[] = [];
    const driver = new ClaudeDriver();
    listen(driver, (e) => {
      if (e.type === 'note' && e.kind === 'mode') said.push(String(e.text));
    });

    await driver.setMode('acceptEdits');

    expect(said).toEqual(['Permission mode is now acceptEdits.']);
  });

  // The header and the picker read this, not the conversation: they have to be
  // right about the opening mode even though nothing was said about it.
  it('still pins the mode it opened in, so the picker is not left guessing', () => {
    const pinned: string[] = [];
    const driver = new ClaudeDriver();
    listen(driver, (e) => {
      if (e.type === 'session.pinned' && e.permissionMode) pinned.push(e.permissionMode);
    });

    driver.draw(OPENED);
    driver.draw(status('default'));

    expect(pinned).toEqual(['default']);
  });
});
