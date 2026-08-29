import { fireEvent, render, screen } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';
import { ChatWidgetView } from '@/workbench/chat-widget-view';
import type { ChatWidget } from '@/workbench/chat-widgets';

const widgets: ChatWidget[] = [
  { type: 'metrics', title: 'Health', items: [{ label: 'Latency', value: '42 ms', trend: 'down' }] },
  { type: 'chart', chart: 'bar', title: 'Requests', series: [{ name: 'Web' }], data: [{ label: 'Mon', values: [12] }, { label: 'Tue', values: [18] }] },
  { type: 'chart', chart: 'line', title: 'Speed', series: [{ name: 'Time' }], data: [{ label: '1', values: [5] }, { label: '2', values: [3] }] },
  { type: 'progress', title: 'Release', items: [{ label: 'Tests', value: 8, max: 10 }] },
  { type: 'timeline', title: 'Next', items: [{ label: 'Built', status: 'done' }, { label: 'Ship', status: 'next' }] },
  { type: 'table', title: 'Options', columns: ['Choice', 'Cost'], rows: [['A', '$2']] },
  { type: 'video', title: 'Proof', src: '/home/me/proof.webm' },
  { type: 'image', title: 'Architecture', asset: `${'a'.repeat(64)}.png`, alt: 'Architecture diagram', caption: 'Request path' },
  { type: 'image_compare', title: 'Visual proof', mode: 'wipe', before: { asset: `${'b'.repeat(64)}.png`, alt: 'Before' }, after: { asset: `${'c'.repeat(64)}.webp`, alt: 'After' } },
  { type: 'explainer', title: 'Session recovery', summary: 'Replay without losing a word.', nodes: [{ id: 'drop', label: 'Disconnect' }, { id: 'replay', label: 'Replay' }, { id: 'live', label: 'Live' }], edges: [{ from: 'drop', to: 'replay' }, { from: 'replay', to: 'live' }], steps: [{ label: 'Connection drops', active: ['drop'] }, { label: 'Events replay', active: ['replay'] }, { label: 'Streaming resumes', active: ['live'] }], evidence: [{ label: 'Session store', path: '/repo/store.ts', line: 84 }] },
];

describe('chat widget rendering', () => {
  it.each(widgets)('draws $type as a bounded conversation widget', (widget) => {
    render(<ChatWidgetView widget={widget} />);
    expect(screen.getByTestId('chat-widget')).toHaveAttribute('data-widget', widget.type);
    if (widget.title) expect(screen.getByText(widget.title)).toBeVisible();
  });

  it('gives charts an accessible image label and progress an accessible value', () => {
    const { rerender } = render(<ChatWidgetView widget={widgets[1]!} />);
    expect(screen.getByRole('img', { name: 'bar chart' })).toBeVisible();
    rerender(<ChatWidgetView widget={widgets[3]!} />);
    expect(screen.getByRole('progressbar', { name: 'Tests' })).toHaveAttribute('aria-valuenow', '80');
  });

  it('draws a local video through the backend with playback controls', () => {
    render(<ChatWidgetView widget={widgets[6]!} />);
    const video = document.querySelector('video');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', '/api/fs/media?path=%2Fhome%2Fme%2Fproof.webm');
  });

  it('does not crash on a malformed file URL', () => {
    render(<ChatWidgetView widget={{ type: 'video', src: 'file:///%E0%A4%A' }} />);
    expect(document.querySelector('video')).toHaveAttribute('src', '');
  });

  it('lets the reader move through an explainer and exposes its evidence', () => {
    render(<ChatWidgetView widget={widgets[9]!} />);
    expect(screen.getByRole('img', { name: 'Session recovery flow diagram, step 1 of 3' })).toBeVisible();
    expect(screen.getByText('Connection drops')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Step 2: Events replay' }));
    expect(screen.getByRole('img', { name: 'Session recovery flow diagram, step 2 of 3' })).toBeVisible();
    expect(screen.getByText('Events replay')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Session store:84' })).toBeVisible();
  });

  it('offers playback without forcing motion on a reader who asked for less', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    render(<ChatWidgetView widget={widgets[9]!} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play explanation' }));
    expect(screen.getByRole('button', { name: 'Pause explanation' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'Session recovery flow diagram, step 1 of 3' })).toBeVisible();
    vi.unstubAllGlobals();
  });

  it.each(['flow', 'sequence', 'cycle', 'layers'] as const)('draws and advances the %s visual language', (layout) => {
    const base = widgets[9] as Extract<ChatWidget, { type: 'explainer' }>;
    render(<ChatWidgetView widget={{ ...base, layout }} />);
    const diagram = screen.getByRole('img', { name: `Session recovery ${layout} diagram, step 1 of 3` });
    expect(diagram).toHaveAttribute('data-layout', layout);
    fireEvent.click(screen.getByRole('button', { name: 'Step 3: Streaming resumes' }));
    expect(diagram.querySelector('[data-node="live"]')).toHaveAttribute('data-active', 'true');
    expect(diagram.querySelector('[data-node="drop"]')).toHaveAttribute('data-accent', 'var(--color-info-accent)');
    expect(diagram.querySelector('[data-node="live"]')).toHaveAttribute('data-accent', 'var(--color-success-accent)');
  });

  it('renders managed images and wipe comparisons from stable asset routes', () => {
    const { rerender } = render(<ChatWidgetView widget={widgets[7]!} />);
    expect(screen.getByRole('img', { name: 'Architecture diagram' })).toHaveAttribute('src', `/api/presentation-assets/${'a'.repeat(64)}.png`);
    rerender(<ChatWidgetView widget={widgets[8]!} />);
    expect(screen.getByTestId('image-comparison')).toHaveAttribute('data-mode', 'wipe');
    expect(screen.getByRole('img', { name: 'After' })).toHaveAttribute('src', `/api/presentation-assets/${'c'.repeat(64)}.webp`);
  });
});
