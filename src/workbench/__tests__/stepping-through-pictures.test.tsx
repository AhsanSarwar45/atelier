/**
 * A picture opened from among several steps to the one before and the one
 * after without closing (bw-6xsa5.1). The grid hands the viewer the run it was
 * clicked in; the viewer draws the arrows and takes the arrow keys.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';

import type { ImagePayload, LookableImage } from '@/workbench/protocol';

import { AttachmentGrid } from '../attachment-grid';
import { AttachmentViewer } from '../attachment-viewer';

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function pictures(count: number): ImagePayload[] {
  return Array.from({ length: count }, (_, i) => ({ mime: 'image/png', dataUrl: PIXEL, alt: `Picture ${i + 1}` }));
}

function Chat({ files }: { files: ImagePayload[] }) {
  const [looking, setLooking] = useState<{ image: LookableImage; set?: readonly ImagePayload[] } | null>(null);
  return (
    <>
      <AttachmentGrid files={files} onLook={(image, set) => setLooking({ image, set })} />
      {looking && <AttachmentViewer image={looking.image} set={looking.set} onClose={() => setLooking(null)} />}
    </>
  );
}

const shown = () => screen.getByTestId('picture-viewer-image').getAttribute('alt');

afterEach(cleanup);

describe('stepping through the pictures of one message', () => {
  it('opens the one clicked, and the arrows move to its neighbours', () => {
    render(<Chat files={pictures(3)} />);
    fireEvent.click(screen.getAllByTestId('message-image-open')[1]!);
    expect(shown()).toBe('Picture 2');
    expect(screen.getByTestId('attachment-viewer-position').textContent).toBe('2 of 3');

    fireEvent.click(screen.getByTestId('attachment-viewer-next'));
    expect(shown()).toBe('Picture 3');
    expect(screen.getByTestId('attachment-viewer-next')).toBeDisabled();

    fireEvent.click(screen.getByTestId('attachment-viewer-previous'));
    fireEvent.click(screen.getByTestId('attachment-viewer-previous'));
    expect(shown()).toBe('Picture 1');
    expect(screen.getByTestId('attachment-viewer-previous')).toBeDisabled();
  });

  it('steps on the arrow keys too', () => {
    render(<Chat files={pictures(3)} />);
    fireEvent.click(screen.getAllByTestId('message-image-open')[0]!);
    act(() => { fireEvent.keyDown(window, { key: 'ArrowRight' }); });
    expect(shown()).toBe('Picture 2');
    act(() => { fireEvent.keyDown(window, { key: 'ArrowLeft' }); });
    act(() => { fireEvent.keyDown(window, { key: 'ArrowLeft' }); });
    expect(shown()).toBe('Picture 1');
  });

  it('shows no arrows for a picture on its own', () => {
    render(<Chat files={pictures(1)} />);
    fireEvent.click(screen.getByTestId('message-image-open'));
    expect(shown()).toBe('Picture 1');
    expect(screen.queryByTestId('attachment-viewer-next')).toBeNull();
    expect(screen.queryByTestId('attachment-viewer-previous')).toBeNull();
  });
});
