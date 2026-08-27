import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ResizeDivider } from '@/workbench/chat-tab';

describe('desktop chat panels', () => {
  it('resizes either side in the direction its divider moves', () => {
    const leftChanged = vi.fn();
    const rightChanged = vi.fn();
    const capture = vi.fn();
    const release = vi.fn();
    const { rerender } = render(<ResizeDivider side="left" value={288} onChange={leftChanged} maximum={() => 560} />);
    const left = screen.getByRole('separator', { name: 'Resize left panel' });
    Object.assign(left, { setPointerCapture: capture, releasePointerCapture: release });
    fireEvent.pointerDown(left, { pointerId: 1, clientX: 300 });
    fireEvent.pointerMove(left, { pointerId: 1, clientX: 348 });
    fireEvent.pointerUp(left, { pointerId: 1, clientX: 348 });
    expect(leftChanged).toHaveBeenLastCalledWith(336);

    rerender(<ResizeDivider side="right" value={288} onChange={rightChanged} maximum={() => 560} />);
    const right = screen.getByRole('separator', { name: 'Resize right panel' });
    Object.assign(right, { setPointerCapture: capture, releasePointerCapture: release });
    fireEvent.pointerDown(right, { pointerId: 2, clientX: 900 });
    fireEvent.pointerMove(right, { pointerId: 2, clientX: 852 });
    expect(rightChanged).toHaveBeenLastCalledWith(336);
  });

  it('keeps the transcript viewport full width and constrains only its rows', () => {
    const source = readFileSync(join(process.cwd(), 'src/workbench/chat-tab.tsx'), 'utf8');
    expect(source).toContain('className="w-full flex-1 overflow-y-auto [overflow-anchor:none]"');
    expect(source).toContain('data-testid="transcript-rows" className="mx-auto flex w-full max-w-[110ch]');
  });
});
