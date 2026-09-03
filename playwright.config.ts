import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Not tests/results: that folder holds the screenshots a run saves as
  // evidence and they are committed, while this one is emptied before every
  // run — pointing both at the same place destroys the proof of the last job
  // whenever a single test is run on its own.
  outputDir: './tests/.artifacts',
  snapshotDir: './tests/snapshots',
  fullyParallel: true,
  retries: 0,
  // Every fixture project deletes itself in its own test's `finally`; this is
  // the sweep for whatever a killed run left behind (bw-6m6w.10).
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    // Overridable so a worktree can drive its own instance without touching
    // the one serving the owner's board on 3008.
    baseURL: process.env.BEADS_E2E_URL ?? 'http://localhost:3008',
    // No single action waits forever. Without a bound here a click on an
    // element that is never coming back is limited only by the whole test's
    // deadline, and the failure that arrives says "Test timeout exceeded"
    // naming neither the line nor the locator — five and ten minutes spent, and
    // nothing learned from either (bw-t26l.20).
    actionTimeout: 30_000,
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
    {
      // The scrollbar rules are written twice, once for each engine, because
      // each engine reads only its own half — and a rule nothing runs is a rule
      // nobody has checked. Only the chrome file needs the second engine; the
      // rest of the suite drives the app's behaviour, which does not change
      // with the browser.
      name: 'firefox',
      use: { browserName: 'firefox' },
      testMatch: /chrome\.spec\.ts/,
    },
  ],
});
