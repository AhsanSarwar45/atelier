/**
 * One case per block kind — twelve kinds, plus the dispatcher's refusal for
 * a kind it doesn't recognise. Each assertion checks something the block
 * actually draws (a number, a label, an SVG shape count), not just that it
 * rendered without throwing.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderBlock } from '@/components/report/blocks';
import { LightboxProvider } from '@/components/report/lightbox';
import type { Block, BlockKind } from '@/components/report/types';

import { REPORT_FIXTURE } from './report-fixture';

const blocks = REPORT_FIXTURE.content[0].blocks;
const byKind = Object.fromEntries(blocks.map((b) => [b.kind, b])) as Record<BlockKind, Block>;

function renderBlockOf(kind: BlockKind) {
  return render(<LightboxProvider>{renderBlock(byKind[kind])}</LightboxProvider>);
}

describe('report block kinds', () => {
  it('text: draws the sentence', () => {
    renderBlockOf('text');
    expect(screen.getByText('A single sentence block.')).toBeInTheDocument();
  });

  it('list: draws every item in an unordered list', () => {
    renderBlockOf('list');
    const list = screen.getByText('First item').closest('ul');
    expect(list).not.toBeNull();
    expect(screen.getByText('Second item')).toBeInTheDocument();
  });

  it('rows: tints the hot row and strikes the gone row', () => {
    renderBlockOf('rows');
    const hot = screen.getByText('Hot row');
    const gone = screen.getByText('Gone row');
    expect(hot.closest('div')?.className).toContain('bg-info/15');
    expect(hot.className).not.toContain('line-through');
    expect(gone.className).toContain('line-through');
    expect(screen.getByText('Plain row')).toBeInTheDocument();
  });

  it('note: draws the label and the warn tone', () => {
    renderBlockOf('note');
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    const text = screen.getByText('A note block with a label.');
    expect(text.closest('div')?.className).toContain('bg-warning/15');
  });

  it('table: draws typed cells — bold, num, pill', () => {
    renderBlockOf('table');
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Alpha').tagName).toBe('B');
    expect(screen.getByText('12')).toBeInTheDocument();
    const pill = screen.getByText('beta');
    expect(pill.tagName).toBe('SPAN');
    expect(pill.className).toContain('bg-info/15');
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('tiles: draws each value, key, and delta', () => {
    renderBlockOf('tiles');
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('bars: draws one rect per series item, labelled by alt text', () => {
    const { container } = renderBlockOf('bars');
    const svg = screen.getByRole('img', { name: 'bars alt text' });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelectorAll('rect')).toHaveLength(2);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(container.textContent).toContain('12pt');
  });

  it('breakdown: draws one segment per part, sized to their share', () => {
    const { container } = renderBlockOf('breakdown');
    screen.getByRole('img', { name: 'breakdown alt text' });
    const rects = container.querySelectorAll('rect');
    expect(rects).toHaveLength(2);
    // 6 of 10 total -> 60% of the 640-wide viewBox.
    expect(Number(rects[0].getAttribute('width'))).toBeCloseTo(384, 0);
    expect(container.textContent).toContain('Done 6');
  });

  it('trend: draws one polyline per line and a legend entry', () => {
    const { container } = renderBlockOf('trend');
    screen.getByRole('img', { name: 'trend alt text' });
    expect(container.querySelectorAll('polyline')).toHaveLength(1);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(screen.getByText('Errors')).toBeInTheDocument();
    expect(screen.getByText('Mon')).toBeInTheDocument();
  });

  it('images: opens the picture viewer with its caption on click', () => {
    renderBlockOf('images');
    fireEvent.click(screen.getByAltText('Shot one'));
    const dialog = screen.getByRole('dialog', { name: 'Picture viewer' });
    expect(within(dialog).getByText('Shot one')).toBeInTheDocument();
  });

  it('compare: opens both before/after images together', () => {
    renderBlockOf('compare');
    fireEvent.click(screen.getByAltText('Before'));
    const dialog = screen.getByRole('dialog', { name: 'Picture viewer' });
    expect(within(dialog).getByText('Before')).toBeInTheDocument();
    expect(within(dialog).getByText('After')).toBeInTheDocument();
  });

  it('wipe: starts at the midpoint and drags to the pointer position', () => {
    const { container } = renderBlockOf('wipe');
    const slider = screen.getByRole('slider', { name: 'Before and after' });
    expect(slider).toHaveAttribute('aria-valuenow', '50');
    slider.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 50, right: 200, bottom: 50, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerDown(slider, { clientX: 150, pointerId: 1 });
    expect(slider).toHaveAttribute('aria-valuenow', '75');
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('an unrecognised kind refuses instead of crashing', () => {
    const bogus = { kind: 'mystery' } as unknown as Block;
    render(renderBlock(bogus));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('mystery');
  });
});
