/**
 * About: what it says about the version, and what it lets a reader do.
 *
 * The notice in the corner can be dismissed and then never found again, so
 * this section is the place an update is always reachable from. These cases
 * are mostly about that: the update is offered, a skip can be taken back, and
 * a refusal is shown rather than swallowed.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AboutSettings } from '../about-settings';

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

/** The window's one connection, stood in for (src/workbench/live-wire.ts). */
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
 * A whole reading, however it is cut up.
 *
 * A version is drawn in a span of its own so a number never breaks across two
 * lines, and the default matcher reads only an element's own text nodes.
 */
function reads(whole: string) {
  return (_: string, el: Element | null) =>
    el?.textContent?.replace(/\s+/g, ' ').trim() === whole;
}

/** Nothing to do: the running copy is the published one. */
const UP_TO_DATE = {
  current: '0.4.0',
  latest: '0.4.0',
  update_available: false,
  download_url: 'https://github.com/example/releases/v0.4.0',
  release_notes: null,
  asset_url: null,
  checksums_url: null,
  skipped_version: null,
  install_method: 'standalone',
};

/** A release waiting, with a build this platform can install. */
const WAITING = {
  ...UP_TO_DATE,
  current: '0.3.0',
  update_available: true,
  asset_url: 'https://github.com/example/releases/v0.4.0/atelier-linux-x64.tar.gz',
  checksums_url: 'https://github.com/example/releases/v0.4.0/SHA256SUMS.txt',
};

beforeEach(() => {
  vi.clearAllMocks();
  tellTheScreen = null;
  mockSaveSettings.mockResolvedValue({ skippedVersion: null });
});

describe('AboutSettings', () => {
  it('names the running version and says it is up to date', async () => {
    mockCheck.mockResolvedValue(UP_TO_DATE);

    render(<AboutSettings />);

    // The running version and the published one, both named, both the same.
    expect(await screen.findAllByText(reads('v0.4.0'), { selector: 'span' })).toHaveLength(2);
    expect(screen.getByText('Up to date')).toBeInTheDocument();
    // Nothing to install, so nothing is offered.
    expect(screen.queryByTestId('about-update')).not.toBeInTheDocument();
  });

  it('says how this copy was installed', async () => {
    mockCheck.mockResolvedValue({ ...UP_TO_DATE, install_method: 'homebrew' });

    render(<AboutSettings />);

    expect(await screen.findByText('Installed with Homebrew')).toBeInTheDocument();
  });

  it('asks the server to look again when told to', async () => {
    mockCheck.mockResolvedValue(UP_TO_DATE);

    render(<AboutSettings />);
    await screen.findByText('Up to date');

    // The first look is allowed to be the cached answer; pressing Check now
    // is a reader saying that answer is stale.
    expect(mockCheck).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByTestId('about-check'));
    await waitFor(() => expect(mockCheck).toHaveBeenLastCalledWith(true));
  });

  it('offers the update when one is waiting', async () => {
    mockCheck.mockResolvedValue(WAITING);

    render(<AboutSettings />);

    expect(await screen.findByTestId('about-update-now')).toBeEnabled();
    expect(screen.getByText('An update is ready')).toBeInTheDocument();
  });

  it('offers GitHub when there is no build for this platform', async () => {
    // A release with nothing built for the running machine cannot be
    // installed in place, and saying so is better than a button that fails.
    mockCheck.mockResolvedValue({ ...WAITING, asset_url: null, checksums_url: null });

    render(<AboutSettings />);

    expect(await screen.findByText('No build for this platform yet')).toBeInTheDocument();
    expect(screen.queryByTestId('about-update-now')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Get it from GitHub/ })).toHaveAttribute(
      'href',
      WAITING.download_url,
    );
  });

  it('offers the update to a Homebrew copy, which needs no asset of its own', async () => {
    // brew upgrade fetches its own tarball, so a missing per-platform asset on
    // the release is not a reason to refuse.
    mockCheck.mockResolvedValue({
      ...WAITING,
      asset_url: null,
      checksums_url: null,
      install_method: 'homebrew',
    });

    render(<AboutSettings />);

    expect(await screen.findByTestId('about-update-now')).toBeEnabled();
    expect(screen.getByText('Runs through Homebrew, then restarts')).toBeInTheDocument();
  });

  it('draws how far the update has got', async () => {
    mockCheck.mockResolvedValue(WAITING);
    mockPerform.mockResolvedValue({ status: 'started' });

    render(<AboutSettings />);
    fireEvent.click(await screen.findByTestId('about-update-now'));

    saysItIsAt({ phase: 'downloading', received: 3 * 1024 * 1024, total: 12 * 1024 * 1024 });

    const bar = await screen.findByTestId('about-progress');
    expect(bar).toHaveTextContent('Downloading — 3.0 MB of 12.0 MB');
    expect(bar).toHaveTextContent('25%');
    expect(bar.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '25');
  });

  it('shows no percentage when nothing said how big the download is', async () => {
    // brew reports lines, not bytes. A bar that cannot be filled honestly is
    // drawn as moving rather than given a made-up number.
    mockCheck.mockResolvedValue({ ...WAITING, install_method: 'homebrew' });
    mockPerform.mockResolvedValue({ status: 'started' });

    render(<AboutSettings />);
    fireEvent.click(await screen.findByTestId('about-update-now'));

    saysItIsAt({ phase: 'downloading', total: null, note: 'Upgrading through Homebrew' });

    const bar = await screen.findByTestId('about-progress');
    expect(bar).toHaveTextContent('Upgrading through Homebrew');
    expect(bar).not.toHaveTextContent('%');
    expect(bar.querySelector('[role="progressbar"]')).not.toHaveAttribute('aria-valuenow');
  });

  it("says why an update failed, in the server's own words, and offers a retry", async () => {
    // A download turned away because it is not the file we published is not a
    // hiccup. The sentence saying so is the message (bw-167m.2), and the app
    // is untouched, so trying again is a fair thing to offer.
    mockCheck.mockResolvedValue(WAITING);
    const refusal =
      'Refused: the downloaded atelier-linux-x64 is not the one we published. ' +
      'Nothing was replaced and the download was deleted.';
    mockPerform.mockRejectedValue(new Error(`API error: 502 ${refusal}`));

    render(<AboutSettings />);
    fireEvent.click(await screen.findByTestId('about-update-now'));

    const said = await screen.findByTestId('about-update-error');
    expect(said).toHaveTextContent(refusal);
    expect(said).not.toHaveTextContent('API error');
    expect(await screen.findByRole('button', { name: /Try again/ })).toBeEnabled();
  });

  it('keeps a skip on the server, and takes it back', async () => {
    // Kept by the server rather than the browser, because the app answers the
    // whole network: skipping at the desk has to quieten the phone too.
    mockCheck.mockResolvedValue(WAITING);

    render(<AboutSettings />);
    fireEvent.click(await screen.findByTestId('about-skip'));

    await waitFor(() =>
      expect(mockSaveSettings).toHaveBeenCalledWith({ skippedVersion: '0.4.0' }),
    );

    // The row appears without another trip to the server, and un-skipping is
    // right beside it — the whole point of keeping this reachable.
    const skipped = await screen.findByTestId('about-skipped');
    expect(skipped).toHaveTextContent('v0.4.0');

    fireEvent.click(screen.getByTestId('about-unskip'));
    await waitFor(() =>
      expect(mockSaveSettings).toHaveBeenLastCalledWith({ skippedVersion: null }),
    );
    await waitFor(() => expect(screen.queryByTestId('about-skipped')).not.toBeInTheDocument());
  });

  it('still offers to skip when it is an older version that was skipped', async () => {
    // The setting holds one version. An older one sitting in it says nothing
    // about the release being offered now, and used to hide the control that
    // would have quietened it.
    mockCheck.mockResolvedValue({ ...WAITING, skipped_version: '0.3.9' });

    render(<AboutSettings />);

    expect(await screen.findByTestId('about-skip')).toHaveTextContent('Skip v0.4.0');
  });

  it('does not offer to skip a version already skipped', async () => {
    mockCheck.mockResolvedValue({ ...WAITING, skipped_version: '0.4.0' });

    render(<AboutSettings />);

    expect(await screen.findByTestId('about-skipped')).toBeInTheDocument();
    expect(screen.queryByTestId('about-skip')).not.toBeInTheDocument();
    // Skipped is about being told, not about being able to. The update is
    // still offered here.
    expect(screen.getByTestId('about-update-now')).toBeEnabled();
  });

  it('shows the release notes when there are some', async () => {
    mockCheck.mockResolvedValue({ ...WAITING, release_notes: 'Fixed the thing.' });

    render(<AboutSettings />);

    expect(await screen.findByTestId('about-notes')).toHaveTextContent('Fixed the thing.');
  });

  it('says when it could not reach the release at all', async () => {
    mockCheck.mockRejectedValue(new Error('API error: 503 GitHub did not answer'));

    render(<AboutSettings />);

    expect(await screen.findByTestId('about-error')).toHaveTextContent('GitHub did not answer');
    expect(screen.getByText('Could not check')).toBeInTheDocument();
  });
});
