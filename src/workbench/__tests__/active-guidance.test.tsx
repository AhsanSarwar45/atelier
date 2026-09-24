import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActiveGuidance } from '../active-guidance';

describe('active guidance', () => {
  it('distinguishes included instructions from on-demand skills and manual commands', () => {
    render(<ActiveGuidance snapshot={{ revision: 'private-revision', items: [
      { id: 'rules', name: 'Team rules', kind: 'instruction', source: 'global', state: 'available' },
      { id: 'skill', name: 'Review', kind: 'skill', source: 'project', state: 'available', automatic: true },
      { id: 'command', name: 'Release', kind: 'skill', source: 'global', state: 'available', automatic: false },
      { id: 'off', name: 'Disabled rule', kind: 'instruction', source: 'global', state: 'disabled' },
    ] }} />);
    expect(screen.getByRole('button', { name: 'Active guidance' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('guidance-popover')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Active guidance' }));
    expect(screen.getByText('Included in this connection · 1')).toBeVisible();
    expect(screen.getByText('Available on demand · 2')).toBeVisible();
    expect(screen.getByText(/Command · Global/)).toBeVisible();
    expect(screen.getByTestId('guidance-diagnostics')).toHaveAttribute('data-state', 'closed');
    fireEvent.click(screen.getByText('Diagnostics'));
    expect(screen.getByText('Revision private-revision')).toBeVisible();
    expect(screen.getByText('Disabled rule · disabled')).toBeVisible();
  });
});
