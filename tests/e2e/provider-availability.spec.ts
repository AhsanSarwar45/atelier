import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-provider-availability');

/**
 * Which agents a new chat offers is a fact about the shipped ACP bundle, not
 * about what happens to be installed on the machine: `providers.list` reads the
 * pinned adapters beside the executable and says why when one is missing.
 *
 * The bundle is a release artifact, so a worktree build has none until the
 * harness links one into the release position. Skip on the harness's word that
 * it linked nothing — never on the availability being asked about here, which
 * would let the case pass by agreeing with the bug (bw-t26l.20).
 */
test('bundled Claude and Codex ACP agents are selectable in a new chat', async ({ page, request }) => {
  test.skip(
    process.env.BEADS_E2E_ACP_BUNDLE !== '1',
    'the run linked no ACP adapter bundle; name one with BEADS_E2E_ACP_ADAPTERS',
  );
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  // Not marked `isTest`: such a project is left out of `GET /api/projects`,
  // which is the only list the project screen reads, so the screen it is opened
  // on draws "This project could not be read" instead of a chat (bw-1cqk). The
  // folder is under the run's own tests directory, so the sweep still finds it.
  const made = await request.post('/api/projects', {
    data: { name: 'provider-availability', path: FIXTURE },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    const listed = await request.post('/api/workbench/command', {
      data: { type: 'providers.list' },
    });
    expect(listed.ok(), await listed.text()).toBe(true);
    const providers = ((await listed.json()) as {
      providers: Array<{ brand: string; available: boolean; availabilityReason?: string }>;
    }).providers;
    for (const brand of ['claude', 'codex']) {
      const provider = providers.find((entry) => entry.brand === brand);
      expect(provider, `${brand} was omitted from providers.list`).toBeDefined();
      expect(provider?.available, provider?.availabilityReason).toBe(true);
    }

    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    await expect(page.getByTestId('new-chat-provider-claude')).toBeEnabled();
    await expect(page.getByTestId('new-chat-provider-codex')).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Start chat' })).toBeEnabled();
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
