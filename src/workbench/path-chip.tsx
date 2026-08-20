/**
 * A file named in a chat, drawn as something to click, and what happens when it
 * is clicked.
 *
 * Both halves live here because a chat draws chips two ways and they must be
 * one thing: a message is a tree and gets a component; a tool's command has
 * already been painted into a string of HTML and gets markup
 * (`paths-in-html.ts`). Neither carries a handler of its own — one listener on
 * the conversation catches every chip in it, which is also what lets a chip sit
 * inside the button that opens a tool row without opening it (bw-khe.13).
 */
'use client';

import { fs } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import { CHIP_CLASS, TITLE } from '@/workbench/paths-in-html';

/** A file named in a message. Its words are the reader's, not the address. */
export function PathChip({ absolute, raw, line }: { absolute: string; raw: string; line: number | null }) {
  return (
    <span
      data-path-mention={absolute}
      {...(line === null ? {} : { 'data-path-line': String(line) })}
      data-testid="path-chip"
      className={CHIP_CLASS}
      title={TITLE(line)}
    >
      {raw}
    </span>
  );
}

/**
 * A click somewhere in a conversation, answered if it landed on a file.
 *
 * Plain click opens the file the way the machine opens it — whatever program
 * the reader has told their desktop to use. Alt-click, when the address named a
 * line, opens their editor sitting on that line, which no default program can
 * do. Returns whether it was a chip, so the caller knows to stop the click
 * going any further.
 */
export function openPathClicked(event: {
  target: EventTarget | null;
  altKey: boolean;
  stopPropagation(): void;
  preventDefault(): void;
}): boolean {
  const target = event.target as HTMLElement | null;
  const chip = target?.closest?.('[data-path-mention]') as HTMLElement | null;
  if (!chip) return false;

  event.stopPropagation();
  event.preventDefault();

  const absolute = chip.getAttribute('data-path-mention') ?? '';
  const at = chip.getAttribute('data-path-line');
  const line = at ? Number(at) : null;
  const toEditor = event.altKey && line !== null;

  void fs
    .openExternal(absolute, toEditor ? 'vscode' : 'finder', toEditor ? line : null)
    .catch((e: unknown) =>
      // A file that will not open must say so. Failing in silence is how a
      // reader ends up clicking the same dead address four times.
      toast({
        title: 'Could not open that file',
        description: e instanceof Error ? e.message : absolute,
        variant: 'destructive',
      }),
    );

  return true;
}
