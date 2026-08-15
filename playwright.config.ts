import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './tests/results',
  snapshotDir: './tests/snapshots',
  fullyParallel: true,
  retries: 0,
  use: {
    // Overridable so a worktree can drive its own instance without touching
    // the one serving the owner's board on 3008.
    baseURL: process.env.BEADS_E2E_URL ?? 'http://localhost:3008',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
