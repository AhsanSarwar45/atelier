import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

import { TodoPanel } from '@/workbench/chat-tab';

const active = [
  { id: '1', text: 'Find the cause', status: 'completed' as const },
  { id: '2', text: 'Fix the screen', status: 'in_progress' as const },
];

describe('the live checklist', () => {
  it('appears expanded while work is active and can be collapsed to one row', () => {
    render(<TodoPanel items={active} />);

    const toggle = screen.getByRole('button', { name: /checklist/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Fix the screen')).toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('todo-panel')).toHaveAttribute('data-expanded', 'no');
    expect(screen.getByText('1/2')).toBeVisible();
  });

  it('automatically collapses when the last item completes', () => {
    const view = render(<TodoPanel items={active} />);
    view.rerender(<TodoPanel items={active.map((item) => ({ ...item, status: 'completed' as const }))} />);

    expect(screen.getByRole('button', { name: /checklist/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2/2')).toBeVisible();
  });

  it('starts compact when a completed checklist is restored with a chat', () => {
    render(<TodoPanel items={active.map((item) => ({ ...item, status: 'completed' as const }))} />);
    expect(screen.getByRole('button', { name: /checklist/i })).toHaveAttribute('aria-expanded', 'false');
  });
});
