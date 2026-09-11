/**
 * What a new chat opens on — the agent, and the account of that agent.
 *
 * Both are stars in the new-chat dialog, drawn the same way as the stars in
 * the model and effort pickers, and remembered in the same place those are:
 * outside the browser. The provider half used to live in local storage, under
 * `workbench.new-chat-default`, which made it a different answer on the phone
 * and on the desk and made it behave unlike the star beside it. The server
 * holds both now (server/src/routes/new_chat.rs), and `loadNewChatDefaults`
 * carries the old browser value across the first time it finds one.
 *
 * "Default" here means *start me here*, and nothing more. It used to also mean
 * *and do not ask*, which is why pressing the star skipped the dialog; the
 * dialog now has three sections and skipping it would skip two choices the
 * person never made.
 */

import { request } from '@/lib/api';

import type { Brand } from './protocol';

/** Where the provider half used to be kept, before the server held it. */
export const NEW_CHAT_DEFAULT = 'workbench.new-chat-default';

/** The agents this app starts chats with. */
const BRANDS: readonly string[] = ['claude', 'codex', 'local'];

/** What a new chat opens on, as the server holds it. */
export interface NewChatDefaults {
  /** The agent to open on, or null for none chosen. */
  provider: Brand | null;
  /** The account to open on, per agent, for the agents that have accounts. */
  profiles: Partial<Record<Brand, string>>;
  /** Whether the browser's old value has already been carried across. */
  migrated: boolean;
}

/** Nothing chosen, which is what a browser that cannot reach the app draws. */
export const NO_DEFAULTS: NewChatDefaults = { provider: null, profiles: {}, migrated: false };

const WHERE = '/api/settings/new-chat';

/**
 * Through `request` rather than `fetchApi`, for the same reason the terminal's
 * setting is: the server answers a refusal as one sentence written for the
 * person, and anything that reworded it here would be showing what this file
 * guessed instead of what the server looked at.
 */
async function answered(path: string, options?: RequestInit): Promise<NewChatDefaults> {
  const answer = await request(path, options);
  if (!answer.ok) throw new Error((await answer.text()) || `the app answered ${answer.status}`);
  return (await answer.json()) as NewChatDefaults;
}

function sending(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** The defaults as they stand. */
export async function readNewChatDefaults(): Promise<NewChatDefaults> {
  return answered(WHERE);
}

/** Press the star beside an agent. `null` clears the choice. */
export async function saveNewChatProvider(brand: Brand | null): Promise<NewChatDefaults> {
  return answered(WHERE, sending({ set: 'provider', brand }));
}

/** Press the star beside an account. `null` clears the choice. */
export async function saveNewChatProfile(
  brand: Brand,
  profile: string | null,
): Promise<NewChatDefaults> {
  return answered(WHERE, sending({ set: 'profile', brand, profile }));
}

/**
 * The defaults, carrying the browser's old value across if it still holds one.
 *
 * The old key is only forgotten once the server has taken it. A read that
 * fails leaves it where it was, so the choice survives an app that was not
 * running when this tab was opened.
 *
 * The server refuses the second browser to turn up with a stale copy, so a
 * choice made since this moved is not undone by a laptop that was closed at
 * the time. This end does not need to know that; it hands over what it has and
 * draws what comes back.
 */
export async function loadNewChatDefaults(): Promise<NewChatDefaults> {
  const carried = localStorage.getItem(NEW_CHAT_DEFAULT);
  if (carried === null) return readNewChatDefaults();

  // A value this app never wrote is not worth a refusal from the server, and
  // it is not worth keeping either. Anything but the five things that key ever
  // held is dropped, and the defaults are read as though it had not been there.
  if (carried !== 'ask' && !BRANDS.includes(carried)) {
    localStorage.removeItem(NEW_CHAT_DEFAULT);
    return readNewChatDefaults();
  }

  const now = await answered(`${WHERE}/migration`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: carried }),
  });
  localStorage.removeItem(NEW_CHAT_DEFAULT);
  return now;
}
