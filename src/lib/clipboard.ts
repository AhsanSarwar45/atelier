/**
 * Putting text on the clipboard, wherever the app is opened.
 *
 * `navigator.clipboard` exists only on a secure page: https, or localhost.
 * Opened over remote access at a plain http address, the browser takes it
 * away, and a copy written against it alone silently does nothing. So the
 * clipboard API is tried where it exists, and otherwise the older copy command
 * carries the text, which every browser still honours inside a click.
 *
 * The command route selects nothing the reader can see and never takes focus,
 * so a dialog's focus trap cannot undo it and the reader's own selection is
 * put back afterwards.
 */

import { toast } from '@/hooks/use-toast';

/** Put `text` on the clipboard. Resolves to whether the browser took it. */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  // Where the API is missing the command runs before any await, while the
  // click that asked for it still counts as the reader's gesture.
  if (!navigator.clipboard?.writeText) return copyByCommand(text);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyByCommand(text);
  }
}

function copyByCommand(text: string): boolean {
  const holder = document.createElement('span');
  holder.textContent = text;
  holder.setAttribute('aria-hidden', 'true');
  Object.assign(holder.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    opacity: '0',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    userSelect: 'text',
  });
  // The copy event is answered directly, so the text goes over exactly as
  // given: no styling, and no line breaks the browser invents on the way.
  const fill = (event: ClipboardEvent) => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const selection = document.getSelection();
  const kept = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i)) : [];
  document.body.appendChild(holder);
  document.addEventListener('copy', fill, true);
  let copied = false;
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    selection?.removeAllRanges();
    selection?.addRange(range);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', fill, true);
    holder.remove();
    if (selection) {
      selection.removeAllRanges();
      for (const range of kept) selection.addRange(range);
    }
  }
  return copied;
}

/** Copy, and say so, since nothing on screen moves; or say the browser refused. */
export function copyAndSay(text: string, said: string): void {
  void copyText(text).then((copied) => {
    toast(copied ? { title: said } : COPY_REFUSED);
  });
}

/** The toast for a copy the browser would not take. */
export const COPY_REFUSED = { title: 'Couldn’t copy', variant: 'destructive' } as const;
