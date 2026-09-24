import { render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { describe, expect, it, vi } from 'vitest';
import { MarkdownBody, markdownBlocks } from '@/components/markdown-body';

vi.mock('@/lib/api', () => ({ fs: { openExternal: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

// The line breaks a parse leaves between two blocks are text the page never
// draws, and the only thing a cut changes; everything else must match.
const html = (text: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>);
const whole = (text: string) => html(text).replace(/>\n+</g, '><');
const cut = (text: string) =>
  markdownBlocks(text)
    .map((block) => html(block))
    .join('')
    .replace(/>\n+</g, '><');

// Every shape an agent's answer takes, and the ones that reach across a blank
// line and so must not be cut there.
const ANSWERS = [
  'One paragraph.\n\nAnother one.\nWith a break.',
  '# Heading\n\nText under it.\n\n## Second\n\n- a\n- b\n\nAfter the list.',
  '1. first\n\n2. second, loose\n\n3. third\n\nDone.',
  '- item\n\n  still the item\n\n- next\n\nOut.',
  '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter the code.',
  '~~~\nfenced\n\n```\nnot a close\n~~~\n\nText.',
  '> quoted\n\n> still quoted\n\nNot quoted.',
  '    indented code\n\n    more of it\n\nText.',
  '| a | b |\n|---|---|\n| 1 | 2 |\n\nBelow the table.',
  'Text\n\n---\n\nMore.',
  'See [the docs][d].\n\n[d]: https://example.com',
  'A note[^1].\n\n[^1]: The note.',
  '<!-- a comment\n\nthat spans -->\n\nText.',
  '- [ ] task\n- [x] done\n\n**bold** and `code`.',
  'Setext\n===\n\nText.',
  'Unclosed fence while streaming\n\n```py\nprint(1)\n\n',
];

describe('A streaming answer', () => {
  it.each(ANSWERS)('draws the same page cut into blocks as parsed whole: %j', (text) => {
    expect(cut(text)).toBe(whole(text));
  });

  it('cuts where a new paragraph starts, and nowhere a block carries on', () => {
    expect(markdownBlocks('a\n\nb\n\nc')).toEqual(['a\n\n', 'b\n\n', 'c']);
    expect(markdownBlocks('- a\n\n- b')).toEqual(['- a\n\n- b']);
    expect(markdownBlocks('```\nx\n\ny\n```\n\nz')).toEqual(['```\nx\n\ny\n```\n\n', 'z']);
  });

  it('keeps the paragraphs already written when more words arrive', () => {
    const first = 'The first paragraph, finished.\n\nThe second is still';
    const { container, rerender } = render(<MarkdownBody>{first}</MarkdownBody>);
    const written = container.querySelector('p');
    rerender(<MarkdownBody>{`${first} being written.`}</MarkdownBody>);
    expect(container.querySelector('p')).toBe(written);
    expect(container.querySelectorAll('p')[1]).toHaveTextContent('The second is still being written.');
  });
});
