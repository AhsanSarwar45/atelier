/**
 * What a message DRAWS for the things it names (bw-8fh2).
 *
 * Two faults the manager saw in one screenshot each, and both live here rather
 * than in the splitting rule next door: a chip written into a sentence hung a
 * third of a line above the words around it, and a report handed over as a
 * whole address stayed raw blue text while a bare report name beside it was a
 * chip.
 *
 * The alignment is read off the class rather than the pixels because jsdom has
 * no layout — the browser check is what proves the line. What is pinned here is
 * that the chip does not go back to being aligned on a baseline it does not
 * have: it is an inline-flex box whose first item is an icon, and an icon has no
 * baseline, so a browser uses its bottom edge and the chip rides high.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { MarkdownBody, type Mentions } from '@/components/markdown-body';
import { BeadChip } from '@/components/bead-chip-row';
import { addressedBy } from '@/workbench/mentions';
import { ReportChip } from '@/workbench/report-view';

// Both chips navigate when clicked; nothing here clicks one.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const REPORT = { project: 'beads-web', slug: 'agents-you-cannot-see', title: 'Agents you cannot see' };

/** The chat's own wiring, as far as this is about: what exists, and what it draws. */
const MENTIONS: Mentions = {
  split: (text) => [{ kind: 'text', text }],
  card: (id) => <BeadChip id={id} projectId="p" size="xs" testId="mention-card" className="mx-0.5" />,
  report: (slug) => <ReportChip project={REPORT.project} slug={slug} title={REPORT.title} className="mx-0.5" />,
  link: (href) => {
    const named = addressedBy(href);
    if (!named) return null;
    if (named.kind === 'card') return named.id === 'bw-1u1' ? MENTIONS.card(named.id) : null;
    return named.slug === REPORT.slug ? MENTIONS.report(named.slug) : null;
  },
};

const say = (text: string) => render(<MarkdownBody mentions={MENTIONS}>{text}</MarkdownBody>);

describe('an address a message carries', () => {
  it('is drawn as the report it names, not as a link', () => {
    say(
      'The page is up: http://127.0.0.1:3008/project?id=7ec315b6-f66e-421e-84ae-a28088bdf16b&tab=reports&report=agents-you-cannot-see',
    );
    expect(screen.getByTestId('chat-report-chip')).toHaveTextContent(REPORT.title);
    expect(screen.queryByTestId('markdown-link')).toBeNull();
  });

  it('is drawn as the card it names', () => {
    say('Landed: http://127.0.0.1:3008/project?id=p&card=bw-1u1');
    expect(screen.getByTestId('mention-card')).toHaveTextContent('bw-1u1');
    expect(screen.queryByTestId('markdown-link')).toBeNull();
  });

  // A bare address is machinery the reader never wanted to see. A phrase
  // somebody chose is not, and drawing the report's own title over it threw
  // those words away (bw-8fh2.5).
  it('keeps the writer’s own words when the link was given some', () => {
    say('[read it](http://127.0.0.1:3008/project?tab=reports&report=agents-you-cannot-see) when you can');
    expect(screen.queryByTestId('chat-report-chip')).toBeNull();
    expect(screen.getByTestId('markdown-link')).toHaveTextContent('read it');
  });

  it('names nothing of ours when the address is on another machine', () => {
    say('https://example.com/project?tab=reports&report=agents-you-cannot-see');
    expect(screen.queryByTestId('chat-report-chip')).toBeNull();
    expect(screen.getByTestId('markdown-link')).toHaveAttribute(
      'href',
      'https://example.com/project?tab=reports&report=agents-you-cannot-see',
    );
  });

  it('stays a link when it names nothing of ours', () => {
    say('See https://github.com/gastownhall/beads for the rest');
    expect(screen.getByTestId('markdown-link')).toHaveAttribute('href', 'https://github.com/gastownhall/beads');
  });

  it('stays a link when the report it names is not one this project has', () => {
    say('http://127.0.0.1:3008/project?tab=reports&report=some-other-projects-page');
    expect(screen.queryByTestId('chat-report-chip')).toBeNull();
    expect(screen.getByTestId('markdown-link')).toBeInTheDocument();
  });
});

describe('where a chip sits on the line', () => {
  it('is centred on the words, never aligned on a baseline the icon decides', () => {
    say('Landed: http://127.0.0.1:3008/project?id=p&card=bw-1u1');
    const chip = screen.getByTestId('mention-card');
    expect(chip.className).toContain('align-middle');
    expect(chip.className).not.toContain('align-baseline');
  });

  it('holds for a report chip too', () => {
    say('http://127.0.0.1:3008/project?tab=reports&report=agents-you-cannot-see');
    const chip = screen.getByTestId('chat-report-chip');
    expect(chip.className).toContain('align-middle');
    expect(chip.className).not.toContain('align-baseline');
  });
});
