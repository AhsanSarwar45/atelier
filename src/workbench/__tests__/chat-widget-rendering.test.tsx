import { render, screen } from '@testing-library/react';

import { describe, expect, it } from 'vitest';
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
});
