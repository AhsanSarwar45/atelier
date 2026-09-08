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
 *
 * ## A badge in a message, a link in a row
 *
 * A file named anywhere in an agent's own message is a file, and is drawn the
 * way this app draws every other file: a badge with the icon and the colour of
 * its kind, the same one a markdown link to a file gets. That holds inside a
 * fenced block and inside inline code too, which is where an agent writes most
 * of them (bw-un8y.1, bw-1e2e.1).
 *
 * The plain underlined link is for the machinery around the message: the
 * collapsed line of an activity row, the command inside one, and the file line
 * of an edit card. Those are dense, already coloured, and read as one line
 * rather than as a sentence — a row of capsules through the middle of them
 * destroys the line as something to read across and copy.
 */
'use client';

import { FILE_BADGE_CLASS, FILE_KINDS, fileKind } from '@/components/file-kinds';
import { Badge } from '@/components/ui/badge';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { openLocalPath } from '@/workbench/open-local-path';
import { CHIP_CLASS, TITLE } from '@/workbench/paths-in-html';

/** How a file is drawn where it was named. */
export type PathLook = 'badge' | 'link';

/** A file named in a message. Its words are the reader's, not the address. */
export function PathChip({
  absolute,
  raw,
  line,
  endLine = null,
  target = 'default',
  look = 'link',
}: {
  absolute: string;
  raw: string;
  line: number | null;
  /** The last line of a range, when the writer named one (`@a.ts:3-9`). */
  endLine?: number | null;
  target?: 'default' | 'editor';
  look?: PathLook;
}) {
  const label =
    target === 'editor' && line !== null
      ? `Click to open this file in your editor at line ${line}`
      : TITLE(line);
  // Every chip carries the same marks, whichever way it is drawn: the one
  // listener on the conversation finds it by them and by nothing else.
  const marks = {
    'data-path-mention': absolute,
    ...(line === null ? {} : { 'data-path-line': String(line) }),
    // A range rides alongside the first line rather than replacing it: opening
    // still lands on line one of the range, and what else the reference asked
    // for is there for whoever wants it (bw-gr8y.2).
    ...(line === null || endLine === null ? {} : { 'data-path-range': `${line}-${endLine}` }),
    ...(target === 'editor' ? { 'data-path-target': 'editor' } : {}),
    'data-testid': 'path-chip',
  };

  if (look === 'badge') {
    const kind = fileKind(absolute);
    const Icon = FILE_KINDS[kind].icon;
    return (
      <Tooltip label={label}>
        <Badge
          asChild
          variant="primary"
          appearance="outline"
          size="sm"
          shape="circle"
          className={cn(FILE_BADGE_CLASS, 'cursor-pointer', FILE_KINDS[kind].color)}
        >
          <span {...marks} data-path-look="badge" data-file-kind={kind}>
            <Icon className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{raw}</span>
          </span>
        </Badge>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={label}>
      <span {...marks} data-path-look="link" className={CHIP_CLASS}>
        {raw}
      </span>
    </Tooltip>
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
  const toEditor = line !== null && (event.altKey || chip.getAttribute('data-path-target') === 'editor');

  openLocalPath(absolute, toEditor ? 'vscode' : 'finder', toEditor ? line : null);

  return true;
}
