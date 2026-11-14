/**
 * A bug you see on a screen is a `ui_bug`; a bug in what a 3D scene renders
 * is a `render_bug` (docs/tasks.md, "Types"). Each card names its kind and
 * lists its screens or scenes.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { makeTask } from '@/workbench/tasks/__tests__/fixtures';

vi.mock('@/workbench/live', async (original) => ({
  ...(await original<typeof import('@/workbench/live')>()),
  useLiveSessions: () => [],
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/project',
}));

const bug = { symptom: 'Broken', repro_steps: ['Open'], expected: 'Works', actual: 'Broken' };

describe('ui and render bugs', () => {
  it.each([
    ['ui_bug', 'UI bug', { ...bug, screens: [{ id: 'menu', name: 'Settings menu', how_to_reach: 'Header' }] }, 'Settings menu'],
    ['render_bug', 'Render bug', { ...bug, scenes: [{ id: 'hall', scene: 'Great hall', camera: 'door, 35mm' }] }, 'Great hall'],
  ])('draws a %s card with its label and its items', (type, label, plan, item) => {
    render(<ChatWidgetView widget={{ type: 'task', event: 'create', task: makeTask({ type, plan }) }} />);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByTestId('task-plan-item')).toHaveTextContent(item);
  });
});
