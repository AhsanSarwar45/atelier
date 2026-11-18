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

/**
 * Put `text` on the clipboard with `html` beside it, the way a copied
 * selection goes: a rich paste takes the HTML, a plain one the text.
 *
 * The copy command goes first, because it is the very route a selection
 * copied with Ctrl+C, or with Copy on a phone, takes: a copy event filled with
 * both. Chrome on Android put only the text on the clipboard when the HTML came
 * through the clipboard API, so a pasted message lost its links and bullets.
 * The API is the fallback, for a browser that refuses the command.
 */
export async function copyRich(text: string, html: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (copyByCommand(text, html)) return true;
  if (!navigator.clipboard) return false;
  if (!navigator.clipboard.write || typeof ClipboardItem === 'undefined') return copyText(text);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return true;
  } catch {
    return copyText(text);
  }
}

function copyByCommand(text: string, html?: string): boolean {
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
    if (html !== undefined) event.clipboardData?.setData('text/html', html);
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

/** `copyAndSay`, with the HTML a rich paste takes. */
export function copyRichAndSay(text: string, html: string, said: string): void {
  void copyRich(text, html).then((copied) => {
    toast(copied ? { title: said } : COPY_REFUSED);
  });
}

/** The toast for a copy the browser would not take. */
export const COPY_REFUSED = { title: 'Couldn’t copy', variant: 'destructive' } as const;
