/**
 * What a reference's badge says: a chat's name and provider, a skill's name.
 *
 * A reference is written as an id (`@chat:<id>`, `@skill:standup`) and drawn as
 * the thing's own name, so whatever draws one has to be able to look the name
 * up without waiting (bw-mi3s.1). Three places know names, and none of them is
 * asked over the network while a badge is drawn:
 *
 * - every chat the live store is carrying (`live.ts`), which is most of them;
 * - the chat's own command list, which carries each skill's name;
 * - whatever the `@` menu showed, which it learns here as it shows it — so a
 *   chat from another project keeps its name after it is picked.
 *
 * A reference nobody has a name for yet draws with its id, and is asked about
 * once (`askAbout`), so a draft restored after a reload names its chats too.
 */
import { useMemo, useSyncExternalStore } from 'react';

import type { Reference } from '@/components/reference-badge';
import type { BeadStatus } from '@/types';
import { useChatNames } from '@/workbench/live';
import type { Brand, CommandInfo } from '@/workbench/protocol';
import type { AtelierKind } from '@/workbench/references';

export interface ChatName {
  name: string;
  brand: Brand;
  projectId: string | null;
}

export interface SkillName {
  name: string;
  description?: string;
}

const chats = new Map<string, ChatName>();
const skills = new Map<string, SkillName>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Remember a chat's name, from anything that has seen it. */
export function learnChat(id: string, name: ChatName): void {
  const had = chats.get(id);
  if (had && had.name === name.name && had.brand === name.brand && had.projectId === name.projectId) return;
  chats.set(id, name);
  changed();
}

/** Remember a skill's name, from anything that has seen it. */
export function learnSkill(id: string, name: SkillName): void {
  const had = skills.get(id);
  if (had && had.name === name.name && had.description === name.description) return;
  skills.set(id, name);
  changed();
}

/** A way to ask the server about ids nobody here knows; set by the `@` search. */
let asker: ((kind: AtelierKind, id: string) => void) | null = null;
const asked = new Set<string>();

export function setReferenceAsker(ask: (kind: AtelierKind, id: string) => void): void {
  asker = ask;
}

function askAbout(kind: AtelierKind, id: string): void {
  const key = `${kind}:${id}`;
  if (asked.has(key) || !asker) return;
  asked.add(key);
  asker(kind, id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Only for tests: forget everything learned. */
export function forgetReferenceNames(): void {
  chats.clear();
  skills.clear();
  asked.clear();
  changed();
}

/** Turns a kind and an id into everything its badge draws. */
export type DescribeReference = (kind: AtelierKind, id: string) => Reference;

/**
 * The lookup, kept current: a new function whenever anything it reads changes,
 * so a caller that keys its drawing on it redraws exactly then.
 */
export function useDescribeReference(
  statuses: ReadonlyMap<string, BeadStatus>,
  commands: readonly CommandInfo[] | undefined,
): DescribeReference {
  const live = useChatNames();
  const learned = useSyncExternalStore(subscribe, () => version, () => 0);
  return useMemo(() => {
    const menu = new Map<string, CommandInfo>();
    for (const command of commands ?? []) {
      if (command.name.startsWith('skill:')) menu.set(command.name.slice('skill:'.length), command);
    }
    return (kind, id) => {
      if (kind === 'bead') return { kind, id, status: statuses.get(id) };
      if (kind === 'chat') {
        const session = live.get(id);
        if (session) {
          return { kind, id, name: session.name, brand: session.brand, projectId: session.projectId };
        }
        const known = chats.get(id);
        if (known) return { kind, id, ...known };
        askAbout(kind, id);
        return { kind, id, name: null };
      }
      const command = menu.get(id);
      if (command) return { kind, id, name: command.title || id, description: command.description };
      const known = skills.get(id);
      if (known) return { kind, id, ...known };
      askAbout(kind, id);
      return { kind, id, name: null };
    };
    // `learned` is what says the learned maps moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, commands, statuses, learned]);
}
