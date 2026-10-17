'use client';

/**
 * The menu behind a right-click on a message in a chat, or a long press on a
 * phone (bw-yszdw).
 *
 * It hangs off the point that was pressed, the way the path chips' menu does
 * (`path-menu.tsx`), and stays out of the way of what already has a menu of its
 * own: a file chip keeps the chip's menu, and a link keeps the browser's, which
 * is where "Open in new tab" lives.
 *
 * What it offers is decided when it opens rather than when it is drawn: text
 * the reader had selected inside this message is read at the press, because
 * the menu taking focus is free to clear the selection before an item is
 * chosen.
 *
 * Copying works anywhere a message is drawn. Everything that reaches the chat
 * itself — sending again, the writing box, a link to the message — comes from
 * `MessageReplies`, which only the chat's own conversation provides, so a
 * message drawn anywhere else offers copying alone (bw-drvtr.2).
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { Copy, Link, Pencil, Quote, RotateCcw, TextSelect } from 'lucide-react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { PointerAnchor } from '@/components/ui/point-anchor';
import { copyAndSay } from '@/lib/clipboard';
import { imageMarker, pictureId, type DraftPicture } from '@/workbench/composer-attachments';
import type { TranscriptItem } from '@/workbench/fold';
import { chipUnder } from '@/workbench/path-chip';

type Message = Extract<TranscriptItem, { kind: 'message' }>;

/** What the open chat lets a message do to it. */
export interface MessageReplies {
  /** Send these words and pictures again, as a new message. */
  resend: (draft: string, pictures: DraftPicture[]) => void;
  /** Put them in the writing box, after anything already written there. */
  edit: (draft: string, pictures: DraftPicture[]) => void;
  /** Put this text in the writing box as a quote. */
  quote: (text: string) => void;
  /** The address that opens this chat at the message. */
  linkTo: (messageId: string) => string;
}

export const MessageRepliesContext = createContext<MessageReplies | null>(null);

/**
 * A sent message as the writing box holds one: its words, with a marker
 * wherever a picture sat, and the pictures under fresh ids. Sending that again
 * goes through the same steps as typing it, pictures in their places.
 */
export function messageAsDraft(item: Pick<Message, 'text' | 'images'>): { draft: string; pictures: DraftPicture[] } {
  const pictures = item.images.map((image) => ({ ...image, id: pictureId() }));
  const placed = pictures
    .filter((picture) => picture.at !== undefined)
    .map((picture) => ({ picture, at: Math.max(0, Math.min(item.text.length, picture.at!)) }))
    .sort((a, b) => a.at - b.at);
  let draft = '';
  let from = 0;
  for (const { picture, at } of placed) {
    draft += item.text.slice(from, at) + imageMarker(picture.id);
    from = at;
  }
  return { draft: draft + item.text.slice(from), pictures };
}

/** The text as a quote: every line marked, then a line to answer on. */
export function quoted(text: string): string {
  return `${text.trim().split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')}\n\n`;
}


/** How long a finger has to stay put before it counts as a right-click. */
const HELD_LONG_ENOUGH = 500;

/** Where the menu was asked for, and the selection it was asked over. */
interface Asked {
  x: number;
  y: number;
  selected: string;
}

/** Text selected inside `box` right now, or nothing. */
function selectedIn(box: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return '';
  const range = selection.getRangeAt(0);
  if (!box.contains(range.commonAncestorContainer)) return '';
  return selection.toString();
}

/** A press that something inside the message answers for itself. */
function hasItsOwnMenu(target: EventTarget | null): boolean {
  if (chipUnder(target)) return true;
  return Boolean((target as HTMLElement | null)?.closest?.('a[href]'));
}

/** What a message puts on itself, and the menu it draws inside itself. */
export interface MessageActions {
  /** Spread onto the message's own box. */
  box: {
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  menu: ReactNode;
}

/** The right-click menu for one message. */
export function useMessageActions(item: Message): MessageActions {
  const replies = useContext(MessageRepliesContext);
  const [asked, setAsked] = useState<Asked | null>(null);
  const held = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Where the finger went down, so a scroll can be told from a press. */
  const from = useRef<{ x: number; y: number } | null>(null);

  const letGo = useCallback(() => {
    from.current = null;
    if (held.current === null) return;
    clearTimeout(held.current);
    held.current = null;
  }, []);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (hasItsOwnMenu(event.target)) return;
      event.preventDefault();
      letGo();
      setAsked({ x: event.clientX, y: event.clientY, selected: selectedIn(event.currentTarget) });
    },
    [letGo],
  );

  // A touch has no second button, so it says the same thing by staying still.
  // Android also sends a `contextmenu` after a long press; whichever comes
  // first opens the menu and the other finds it already open.
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      letGo();
      if (event.pointerType === 'mouse' || hasItsOwnMenu(event.target)) return;
      const box = event.currentTarget;
      const { clientX: x, clientY: y } = event;
      from.current = { x, y };
      held.current = setTimeout(() => {
        held.current = null;
        setAsked({ x, y, selected: selectedIn(box) });
      }, HELD_LONG_ENOUGH);
    },
    [letGo],
  );

  // A finger that wandered is a scroll, not a press.
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = from.current;
      if (start === null) return;
      if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 10) letGo();
    },
    [letGo],
  );

  return {
    box: { onContextMenu, onPointerDown, onPointerUp: letGo, onPointerCancel: letGo, onPointerMove },
    menu: asked && (
      <DropdownMenu open modal={false} onOpenChange={(now) => { if (!now) setAsked(null); }}>
        <PointerAnchor at={{ left: asked.x, top: asked.y }} />
        <DropdownMenuContent align="start" side="bottom" sideOffset={0} className="w-52" data-testid="message-menu">
          {asked.selected && (
            <DropdownMenuItem data-testid="message-menu-copy-selection" onSelect={() => copyAndSay(asked.selected, 'Selection copied')}>
              <TextSelect />
              Copy selection
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-testid="message-menu-copy" onSelect={() => copyAndSay(item.text, 'Message copied')}>
            <Copy />
            Copy message
          </DropdownMenuItem>
          {replies && (
            <>
              <DropdownMenuItem
                data-testid="message-menu-copy-link"
                onSelect={() => copyAndSay(new URL(replies.linkTo(item.id), window.location.origin).toString(), 'Link copied')}
              >
                <Link />
                Copy link to message
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* What was selected, when something was; otherwise all of it. */}
              <DropdownMenuItem data-testid="message-menu-quote" onSelect={() => replies.quote(asked.selected || item.text)}>
                <Quote />
                Quote in reply
              </DropdownMenuItem>
              {/* Only what he wrote to this chat: a helper's prompt was the
                  agent's words, not his. */}
              {item.role === 'user' && !item.parentId && (
                <>
                  <DropdownMenuItem data-testid="message-menu-edit" onSelect={() => {
                    const { draft, pictures } = messageAsDraft(item);
                    replies.edit(draft, pictures);
                  }}>
                    <Pencil />
                    Edit and resend
                  </DropdownMenuItem>
                  <DropdownMenuItem data-testid="message-menu-resend" onSelect={() => {
                    const { draft, pictures } = messageAsDraft(item);
                    replies.resend(draft, pictures);
                  }}>
                    <RotateCcw />
                    Resend
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  };
}
