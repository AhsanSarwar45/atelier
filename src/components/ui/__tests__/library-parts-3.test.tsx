/**
 * What the dots, chips, bars and boxes needed so screens stopped drawing their
 * own (bw-weih.11).
 */

import * as React from 'react';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Badge, BadgeDot } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';

describe('BadgeDot', () => {
  it('is a quiet dot inside a chip, and a full-colour mark of a given size standing alone', () => {
    const ref = React.createRef<HTMLSpanElement>();
    render(
      <>
        <BadgeDot data-testid="quiet" />
        <BadgeDot data-testid="mark" ref={ref} size="sm" solid className="text-warning" aria-label="Unsaved changes" />
        <BadgeDot data-testid="tag" size="md" solid color="#3366ff" />
      </>,
    );
    expect(screen.getByTestId('quiet')).toHaveClass('size-1.5', 'rounded-full', 'bg-current', 'opacity-75');
    const mark = screen.getByTestId('mark');
    expect(mark).toHaveClass('size-2', 'bg-current', 'text-warning');
    expect(mark).not.toHaveClass('opacity-75');
    expect(mark).toHaveAttribute('data-slot', 'badge-dot');
    expect(ref.current).toBe(mark);
    const tag = screen.getByTestId('tag');
    expect(tag).toHaveClass('size-3');
    expect(tag).toHaveStyle({ color: '#3366ff' });
    expect(tag).not.toHaveAttribute('color');
  });
});

describe('Badge', () => {
  it('wraps a long address onto as many lines as it needs', () => {
    render(
      <Badge size="sm" wrap>
        a/very/long/path.ts
      </Badge>,
    );
    const chip = screen.getByText('a/very/long/path.ts');
    expect(chip).toHaveClass('h-auto', 'whitespace-normal', 'break-all');
    expect(chip).not.toHaveClass('h-5', 'whitespace-nowrap');
  });

  it('takes a colour that is not a hex, thinning it the same way', () => {
    render(<Badge color="var(--color-info-accent)">edge</Badge>);
    const chip = screen.getByText('edge');
    expect(chip.style.color).toBe('var(--color-info-accent)');
    expect(chip.getAttribute('style')).toContain('color-mix');
  });
});

describe('Panel', () => {
  it('runs as a strip edged only underneath', () => {
    render(
      <Panel shape="strip" tone="danger" inset="xs" data-testid="strip">
        Couldn’t save
      </Panel>,
    );
    const strip = screen.getByTestId('strip');
    expect(strip).toHaveClass('border-b', 'bg-danger/10', 'px-3', 'py-1');
    expect(strip).not.toHaveClass('rounded-md', 'border');
  });

  it('marks the chosen box, a box inside a box, and a bar over a picture', () => {
    render(
      <>
        <Panel data-testid="plain" />
        <Panel tone="accent" data-testid="accent" />
        <Panel tone="nested" data-testid="nested" />
        <Panel tone="media" inset="bar" data-testid="media" />
      </>,
    );
    expect(screen.getByTestId('plain')).toHaveClass('rounded-md', 'border', 'px-3', 'py-2');
    expect(screen.getByTestId('accent')).toHaveClass('border-primary', 'bg-primary/10');
    expect(screen.getByTestId('nested')).toHaveClass('bg-background/50');
    expect(screen.getByTestId('media')).toHaveClass('bg-black/70', 'text-white', 'p-1');
  });
});

describe('Progress', () => {
  it('comes thinner, and glides between readings when fed once a second', () => {
    const { container } = render(<Progress value={40} size="xs" pace="steady" data-testid="bar" />);
    const bar = screen.getByTestId('bar');
    expect(bar).toHaveClass('h-1');
    expect(bar).not.toHaveClass('h-2');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(container.querySelector('[data-tone]')).toHaveClass('duration-1000', 'ease-linear');
  });
});
