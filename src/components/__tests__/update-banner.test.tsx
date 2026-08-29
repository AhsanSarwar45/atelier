import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { UpdateBanner } from '../update-banner';

// Mock the api module
const mockCheck = vi.fn();
const mockPerform = vi.fn();
vi.mock('@/lib/api', () => ({
  version: {
    get check() {
      return mockCheck;
    },
  },
  update: {
    get perform() {
      return mockPerform;
    },
  },
  reachable: () => Promise.resolve(false),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UpdateBanner', () => {
  it('does not render when update_available is false', async () => {
    mockCheck.mockResolvedValue({
      current: '0.3.0',
      latest: '0.3.0',
      update_available: false,
      download_url: null,
      release_notes: null,
    });

    const { container } = render(<UpdateBanner />);

    // Wait for the async check to resolve
    await waitFor(() => {
      expect(mockCheck).toHaveBeenCalled();
    });

    // Banner should not be rendered
    expect(container.firstChild).toBeNull();
  });

  it('renders download link when update is available', async () => {
    mockCheck.mockResolvedValue({
      current: '0.3.0',
      latest: '0.4.0',
      update_available: true,
      download_url: 'https://github.com/example/releases/v0.4.0',
      release_notes: 'Bug fixes',
    });

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText('Update available: v0.4.0')).toBeInTheDocument();
    });

    const link = screen.getByText('GitHub');
    expect(link).toHaveAttribute('href', 'https://github.com/example/releases/v0.4.0');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('hides banner when dismiss button is clicked', async () => {
    mockCheck.mockResolvedValue({
      current: '0.3.0',
      latest: '0.4.0',
      update_available: true,
      download_url: 'https://github.com/example/releases/v0.4.0',
      release_notes: null,
    });

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText('Update available: v0.4.0')).toBeInTheDocument();
    });

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissButton);

    expect(screen.queryByText('Update available: v0.4.0')).not.toBeInTheDocument();
  });

  it('says why a download was refused, in the server\'s own words', async () => {
    // The server turns a download away when the file that arrived is not the
    // one the release publishes, and hands back why. That sentence is what a
    // reader needs — a refused replacement is not a hiccup to retry, it is a
    // reason to distrust the download — so it is shown, not swallowed
    // (bw-167m.2).
    mockCheck.mockResolvedValue({
      current: '0.3.0',
      latest: '0.4.0',
      update_available: true,
      download_url: 'https://github.com/example/releases/v0.4.0',
      release_notes: null,
      asset_url: 'https://github.com/example/releases/v0.4.0/atelier-linux-x64',
      checksums_url: 'https://github.com/example/releases/v0.4.0/SHA256SUMS.txt',
    });
    const refusal =
      'Refused: the downloaded atelier-linux-x64 is not the one we published. ' +
      'Nothing was replaced and the download was deleted.';
    mockPerform.mockRejectedValue(new Error(`API error: 502 ${refusal}`));

    render(<UpdateBanner />);

    const update = await screen.findByRole('button', { name: /Update & Restart/i });
    fireEvent.click(update);

    const said = await screen.findByTestId('update-error');
    // The server's whole sentence, and not the status number in front of it.
    expect(said).toHaveTextContent(refusal);
    expect(said).not.toHaveTextContent('API error');
    // The refusal replaces the in-progress state rather than sitting beside it.
    expect(screen.queryByText(/Downloading\.\.\./)).not.toBeInTheDocument();
    expect(screen.queryByText(/Restarting server\.\.\./)).not.toBeInTheDocument();
  });

  it('shows current version text', async () => {
    mockCheck.mockResolvedValue({
      current: '0.3.0',
      latest: '0.4.0',
      update_available: true,
      download_url: null,
      release_notes: null,
    });

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText(/You're running v0\.3\.0/)).toBeInTheDocument();
    });
  });
});
