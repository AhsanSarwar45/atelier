/**
 * The whole document assembled from the fixture: the six parts render in
 * order, and the two pieces of cross-card state — answer chips and decision
 * overrides — actually reach the one composed reply and the copy button.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReportDocument } from '@/components/report/report-document';

import { REPORT_FIXTURE } from './report-fixture';

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('ReportDocument', () => {
  it('renders the title and all six parts in the fixed order', () => {
    const { container } = render(<ReportDocument spec={REPORT_FIXTURE} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Demo report');

    // Ordering is checked against the flattened page text rather than a
    // query, since every part's own label is also a substring of every
    // ancestor's aggregated text — asserting order needs the raw document.
    const text = container.textContent ?? '';
    const at = (s: string) => text.indexOf(s);
    expect(at('What I need from you')).toBeGreaterThanOrEqual(0);
    expect(at('Where we are')).toBeGreaterThan(at('What I need from you'));
    expect(at('All twelve block kinds')).toBeGreaterThan(at('Where we are'));
    expect(at('Decisions')).toBeGreaterThan(at('All twelve block kinds'));
    // "Next" also opens "Next up" inside the status card, so the part
    // label — the last of the six — is the rightmost match, not the first.
    expect(text.lastIndexOf('Next')).toBeGreaterThan(at('Decisions'));
  });

  it('defaults the recommended answer, then switches on click and updates the preview', () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    // q1's "pick" option is "Yes, ship it" -> its `say` text starts the reply.
    expect(screen.getByText('Ship the onboarding flow this week.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Hold for now' }));
    expect(screen.getByText('Hold the onboarding flow.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Hold for now' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Yes, ship it' })).toHaveAttribute('aria-checked', 'false');
  });

  it('a settled question loses its chips and is struck through', () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    expect(screen.getByText('Old settled question kept for history')).toHaveClass('line-through');
    expect(screen.getByText('Settled on the board — this no longer needs an answer.')).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Yes' })).toBeNull();
  });

  it('copies the composed reply to the clipboard and shows the confirmation', async () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy my reply' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Ship the onboarding flow this week.');
    expect(await screen.findByRole('button', { name: 'Copied — paste it in' })).toBeInTheDocument();
  });

  it('flags a decision override and folds it into the composed reply', () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    // D2 needs_you -> no override button, only a "needs you" pill.
    expect(screen.getByText('needs you')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'override' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'override' }));
    expect(screen.getByRole('button', { name: 'change this' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Ship the onboarding flow this week. Change D1.')).toBeInTheDocument();
  });

  it('draws the status checklist and its done/draft/todo split', () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    expect(screen.getByText('Building the shelf components')).toBeInTheDocument();
    expect(screen.getByText('Wiring the screen around it')).toBeInTheDocument();
    expect(screen.getByText('Types and tone mapping')).toBeInTheDocument();
    expect(screen.getByText('in review')).toBeInTheDocument();
  });

  it('marks the starting step and prices every step in the plan', () => {
    render(<ReportDocument spec={REPORT_FIXTURE} />);
    expect(screen.getByText('starting here')).toBeInTheDocument();
    expect(screen.getByText('small')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
    expect(screen.getByText('large')).toBeInTheDocument();
    expect(screen.getByText('The current plan keeps running as scheduled.')).toBeInTheDocument();
  });
});
