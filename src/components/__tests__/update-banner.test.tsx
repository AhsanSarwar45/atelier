import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { UpdateBanner } from '../update-banner';

// Mock the api module
const mockCheck = vi.fn();
const mockPerform = vi.fn();
const mockSaveSettings = vi.fn();
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
  get saveUpdateSettings() {
    return mockSaveSettings;
  },
  reachable: () => Promise.resolve(false),
}));

/**
 * The window's one connection, stood in for.
 *
 * Progress reaches the notice on the wire rather than down a stream of its
 * own, so a test that wants to draw a half-finished download hands the
 * listener a frame itself (src/workbench/live-wire.ts).
 */
let tellTheScreen: ((data: string) => void) | null = null;
vi.mock('@/workbench/live-wire', () => ({
  onUpdate: (tell: (data: string) => void) => {
    tellTheScreen = tell;
    return () => {
      tellTheScreen = null;
    };
  },
}));

/** One reading of a running update, as the server sends it. */
function saysItIsAt(run: Record<string, unknown>) {
  act(() => {
    tellTheScreen?.(
      JSON.stringify({
        phase: 'downloading',
        received: 0,
        total: null,
        note: null,
        failed: null,
        version: '0.4.0',
        ...run,
      }),
    );
  });
}

/**
 * A whole sentence, however it is cut up.
 *
 * The version sits in a span of its own so a number never breaks across two
 * lines, and the default matcher reads only an element's own text nodes — so
 * it sees "Update available:" and stops. This reads the sentence the way a
 * person does.
 */
function reads(whole: string) {
  return (_: string, el: Element | null) =>
    el?.textContent?.replace(/\s+/g, ' ').trim() === whole;
}

/** A release waiting, with a build this platform can actually install. */
const WAITING = {
  current: '0.3.0',
  latest: '0.4.0',
  update_available: true,
  download_url: 'https://github.com/example/releases/v0.4.0',
  release_notes: null,
  asset_url: 'https://github.com/example/releases/v0.4.0/atelier-linux-x64.tar.gz',
  checksums_url: 'https://github.com/example/releases/v0.4.0/SHA256SUMS.txt',
  skipped_version: null,
  install_method: 'standalone',
};

beforeEach(() => {
  vi.clearAllMocks();
  tellTheScreen = null;
  mockSaveSettings.mockResolvedValue({ skippedVersion: '0.4.0' });
});

describe('UpdateBanner', () => {
  it('does not render when update_available is false', async () => {
    mockCheck.mockResolvedValue({
      ...WAITING,
      latest: '0.3.0',
      update_available: false,
    });

    const { container } = render(<UpdateBanner />);

    // Wait for the async check to resolve
    await waitFor(() => {
      expect(mockCheck).toHaveBeenCalled();
    });

    // Banner should not be rendered
    expect(container.firstChild).toBeNull();
  });

  it('names the waiting version and points at the details', async () => {
    mockCheck.mockResolvedValue(WAITING);

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText(reads('Update available: v0.4.0'))).toBeInTheDocument();
    });

    // The release page and the notes are in About, which is also where an
    // update can be started long after this notice has been put away.
    expect(screen.getByRole('link', { name: 'Details' })).toHaveAttribute(
      'href',
      '/settings?section=about',
    );
  });

  it('hides banner when dismiss button is clicked', async () => {
    mockCheck.mockResolvedValue(WAITING);

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText(reads('Update available: v0.4.0'))).toBeInTheDocument();
    });

    const dismissButton = screen.getByRole('button', { name: 'Dismiss' });
    fireEvent.click(dismissButton);

    expect(screen.queryByText(reads('Update available: v0.4.0'))).not.toBeInTheDocument();
  });

  it('says why a download was refused, in the server\'s own words', async () => {
    // The server turns a download away when the file that arrived is not the
    // one the release publishes, and hands back why. That sentence is what a
    // reader needs — a refused replacement is not a hiccup to retry, it is a
    // reason to distrust the download — so it is shown, not swallowed
    // (bw-167m.2).
    mockCheck.mockResolvedValue(WAITING);
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
    expect(screen.queryByTestId('update-progress')).not.toBeInTheDocument();
    // And the button becomes the way to try it again, rather than staying
    // disabled on a failure that left the app exactly as it was.
    expect(await screen.findByRole('button', { name: /Try again/i })).toBeEnabled();
  });

  it('shows current version text', async () => {
    mockCheck.mockResolvedValue({ ...WAITING, download_url: null, asset_url: null });

    render(<UpdateBanner />);

    await waitFor(() => {
      expect(screen.getByText(reads("You're running v0.3.0"))).toBeInTheDocument();
    });
  });

  // ─── skipping ───────────────────────────────────────────────────────

  it('skips a version through the server, not just this browser', async () => {
    // Kept by the server because the app answers the whole network: a skip
    // pressed at the desk has to silence the phone too.
    mockCheck.mockResolvedValue(WAITING);

    render(<UpdateBanner />);

    fireEvent.click(await screen.findByTestId('update-skip'));

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith({ skippedVersion: '0.4.0' });
    });
    await waitFor(() => {
      expect(screen.queryByText(reads('Update available: v0.4.0'))).not.toBeInTheDocument();
    });
  });

  it('stays quiet about a version already skipped', async () => {
    mockCheck.mockResolvedValue({ ...WAITING, skipped_version: '0.4.0' });

    const { container } = render(<UpdateBanner />);

    await waitFor(() => {
      expect(mockCheck).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('speaks up again when a newer version than the skipped one ships', async () => {
    // A skip names one version, not the idea of updating.
    mockCheck.mockResolvedValue({ ...WAITING, latest: '0.5.0', skipped_version: '0.4.0' });

    render(<UpdateBanner />);

    expect(await screen.findByText(reads('Update available: v0.5.0'))).toBeInTheDocument();
  });

  it('does not offer to skip while an update is running', async () => {
    mockCheck.mockResolvedValue(WAITING);
    mockPerform.mockResolvedValue({ status: 'started' });

    render(<UpdateBanner />);
    await screen.findByTestId('update-skip');

    saysItIsAt({ phase: 'downloading', received: 10, total: 100 });

    expect(screen.queryByTestId('update-skip')).not.toBeInTheDocument();
  });

  // ─── progress ───────────────────────────────────────────────────────

  it('draws how much of the download has arrived', async () => {
    mockCheck.mockResolvedValue(WAITING);

    render(<UpdateBanner />);
    await screen.findByText(reads('Update available: v0.4.0'));

    saysItIsAt({ phase: 'downloading', received: 5 * 1024 * 1024, total: 10 * 1024 * 1024 });

    const bar = screen.getByTestId('update-progress');
    expect(bar).toHaveTextContent('Downloading — 5.0 MB of 10.0 MB');
    expect(bar.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '50');
  });

  it('leaves the bar indeterminate when nothing said how big the download is', async () => {
    // A Homebrew upgrade reports lines, not bytes, and no denominator is
    // invented to fill the bar with.
    mockCheck.mockResolvedValue({ ...WAITING, install_method: 'homebrew' });

    render(<UpdateBanner />);
    await screen.findByText(reads('Update available: v0.4.0'));

    saysItIsAt({ phase: 'downloading', received: 0, total: null, note: 'Refreshing Homebrew' });

    const bar = screen.getByTestId('update-progress');
    expect(bar).toHaveTextContent('Refreshing Homebrew');
    expect(bar.querySelector('[role="progressbar"]')).not.toHaveAttribute('aria-valuenow');
  });

  it('names the phase after the download, when there are no bytes left to count', async () => {
    mockCheck.mockResolvedValue(WAITING);

    render(<UpdateBanner />);
    await screen.findByText(reads('Update available: v0.4.0'));

    saysItIsAt({ phase: 'unpacking', received: 100, total: 100, note: 'Unpacking the new version' });

    expect(screen.getByTestId('update-progress')).toHaveTextContent('Unpacking the new version');
  });
});
