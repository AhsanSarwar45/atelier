/**
 * A message's words in the forms the clipboard takes.
 *
 * A selection copied with Ctrl+C carries the page's HTML beside its text, so
 * a rich editor — Slack, Docs, Linear — pastes links as links and bold as
 * bold, and a plain one gets the words as read, without markdown marks. "Copy
 * message" builds the same pair from the words as written, with the same
 * markdown the chat draws (GFM, and a line break where one was typed). "Copy
 * selection as Markdown" goes the other way, from the drawn page back to
 * markdown.
 *
 * HTML written inside a message is left out, never passed through as markup:
 * a paste is no place for a stray script or a tag the reader never saw.
 */

import { fromDom } from 'hast-util-from-dom';
import { toMdast } from 'hast-util-to-mdast';
import { toText } from 'hast-util-to-text';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import rehypeStringify from 'rehype-stringify';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

import type { Element as HastElement, Root as HastRoot } from 'hast';

const drawing = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks).use(remarkRehype);
const printing = unified().use(rehypeStringify);

function drawn(markdown: string): HastRoot {
  return drawing.runSync(drawing.parse(markdown)) as HastRoot;
}

/** The markdown drawn as HTML. */
export function markdownToHtml(markdown: string): string {
  return printing.stringify(drawn(markdown));
}

/**
 * The words as a reader sees them, laid out the way the browser copies a
 * selection, with each list item keeping its bullet or number.
 */
export function markdownToPlain(markdown: string): string {
  const tree = drawn(markdown);
  markListItems(tree);
  return toText(tree).trim();
}

function markListItems(node: HastRoot | HastElement): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'ul' || child.tagName === 'ol') {
      let number = Number(child.properties.start ?? 1);
      for (const item of child.children) {
        if (item.type !== 'element' || item.tagName !== 'li') continue;
        const mark = child.tagName === 'ol' ? `${number++}. ` : '- ';
        // A loose item's words sit in a paragraph; the mark goes inside it.
        const first = item.children.find((c) => c.type === 'element' || (c.type === 'text' && c.value.trim()));
        const into = first?.type === 'element' && first.tagName === 'p' ? first : item;
        into.children.unshift({ type: 'text', value: mark });
      }
    }
    markListItems(child);
  }
}

/** Drawn HTML — a selection out of a message — written back as markdown. */
export function htmlToMarkdown(node: Node): string {
  const tree = toMdast(fromDom(node) as HastRoot);
  return toMarkdown(tree, { bullet: '-', extensions: [gfmToMarkdown()] }).trim();
}
