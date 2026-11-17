/**
 * A message's markdown drawn as HTML, for the clipboard.
 *
 * A selection copied with Ctrl+C carries the page's HTML beside its text, so
 * a rich editor — Slack, Docs, Linear — pastes links as links and bold as
 * bold. "Copy message" copies the words as written, so it builds the same
 * HTML from them, with the same markdown the chat draws (GFM, and a line
 * break where one was typed).
 *
 * HTML written inside a message is left out, never passed through as markup:
 * a paste is no place for a stray script or a tag the reader never saw.
 */

import rehypeStringify from 'rehype-stringify';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

const drawing = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).use(remarkRehype).use(rehypeStringify);

export function markdownToHtml(markdown: string): string {
  return String(drawing.processSync(markdown));
}
