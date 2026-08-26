import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { TranscriptMessage } from '@/workbench/fold';
import type { ImageComparison, ImagePayload } from '@/workbench/protocol';
import { TranscriptRow } from '@/workbench/transcript-rows';

const mentions: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };
const image = (alt: string): ImagePayload => ({ mime: 'image/png', dataUrl: `data:image/png;base64,${alt}`, alt });
const spec = `\`\`\`atelier-image-compare
{"mode":"wipe","before":{"path":"before.png","caption":"Old"},"after":{"path":"after.png","caption":"New"}}
\`\`\``;

function message(comparison: ImageComparison): TranscriptMessage {
  return {
    kind: 'message', id: 'answer', role: 'assistant', done: true, parentId: null, images: [],
    text: `Here is the change.\n\n${spec}`,
    comparisons: [comparison],
  };
}

describe('structured image comparisons in chat', () => {
  it('draws a wipe comparison and hides its machine-readable block', () => {
    render(<TranscriptRow item={message({ mode: 'wipe', before: image('Old'), after: image('New') })} sessionId="chat" mentions={mentions} onLook={vi.fn()} />);

    expect(screen.getByTestId('image-comparison')).toHaveAttribute('data-mode', 'wipe');
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('Here is the change.')).toBeVisible();
    expect(screen.queryByText(/atelier-image-compare/)).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '52');
  });

  it('draws two inspectable images side by side', () => {
    const look = vi.fn();
    render(<TranscriptRow item={message({ mode: 'side_by_side', before: image('Before'), after: image('After') })} sessionId="chat" mentions={mentions} onLook={look} />);

    expect(screen.getByTestId('image-comparison')).toHaveAttribute('data-mode', 'side_by_side');
    fireEvent.click(screen.getByAltText('After'));
    expect(look).toHaveBeenCalledWith(expect.objectContaining({ alt: 'After' }));
  });

  it.each(['wipe', 'side_by_side'] as const)('bounds portrait images in %s comparisons without cropping them', (mode) => {
    render(<TranscriptRow item={message({ mode, before: image('Tall before'), after: image('Tall after') })} sessionId="chat" mentions={mentions} onLook={vi.fn()} />);

    const shown = screen.getByAltText('Tall after');
    expect(shown).toHaveStyle({
      width: 'auto',
      height: 'auto',
      maxWidth: '100%',
      maxHeight: '24rem',
    });
    expect(shown).toHaveClass('object-contain');
  });
});
