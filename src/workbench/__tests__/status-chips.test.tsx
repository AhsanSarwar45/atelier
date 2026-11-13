/**
 * On a phone the status line hides its less urgent chips; a toggle at the end
 * of the row shows them all and hides them again.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ChipRow, PHONE_HIDDEN } from '@/workbench/status-chips';

describe('status chips on a phone', () => {
  it('shows the hidden chips when the toggle is pressed, and hides them again', () => {
    render(<ChipRow><span data-testid="folder" className={PHONE_HIDDEN}>shop</span></ChipRow>);
    const row = screen.getByTestId('chat-status-line');
    const toggle = screen.getByRole('button', { name: 'Show all chips' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveAttribute('data-expanded', 'false');
    // Only phones hide them, so only phones get the toggle.
    expect(toggle.className.split(/\s+/)).toContain('md:hidden');

    fireEvent.click(toggle);
    expect(row).toHaveAttribute('data-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Show fewer chips' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer chips' }));
    expect(row).toHaveAttribute('data-expanded', 'false');
  });

  it('hides a chip on a phone until the row is expanded', () => {
    const classes = PHONE_HIDDEN.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes).toContain('md:inline-flex');
    expect(classes).toContain('group-data-[expanded=true]/chips:inline-flex');
    render(<ChipRow><span>x</span></ChipRow>);
    expect(screen.getByTestId('chat-status-line').className.split(/\s+/)).toContain('group/chips');
  });

  it('lets every chip the status line hides on a phone come back when the row is expanded', () => {
    for (const file of ['chat-tab.tsx', 'memory-badge.tsx', 'active-guidance.tsx', 'worktree-badge.tsx']) {
      const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
      const stuck = [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1])
        .filter((names) => names.split(/\s+/).includes('hidden') && names.includes('md:inline-flex'))
        .filter((names) => !names.includes('group-data-[expanded=true]/chips:inline-flex'));
      expect(stuck, `${file} hides a chip on a phone for good`).toEqual([]);
    }
  });
});
