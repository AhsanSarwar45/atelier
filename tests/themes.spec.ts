import { test, expect } from '@playwright/test';

/**
 * Theme visual regression tests.
 *
 * Prerequisite: atelier running on localhost:3008 with at least one project.
 *
 * Run: npx playwright test tests/themes.spec.ts
 * Update snapshots: npx playwright test tests/themes.spec.ts --update-snapshots
 */

const THEMES = [
  { id: 'default', name: 'Default Dark', mode: 'dark' },
  { id: 'glassmorphism', name: 'Glassmorphism', mode: 'dark' },
  { id: 'neo-brutalist', name: 'Neo-Brutalist', mode: 'dark' },
  { id: 'linear-minimal', name: 'Linear Minimal', mode: 'dark' },
  { id: 'soft-light', name: 'Soft Light', mode: 'light' },
  { id: 'notion-warm', name: 'Notion Warm', mode: 'light' },
  { id: 'github-clean', name: 'GitHub Clean', mode: 'light' },
] as const;

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'settings', path: '/settings' },
] as const;

/**
 * Apply a theme by setting localStorage and data-theme attribute,
 * then reload so the theme-init script picks it up.
 */
async function applyTheme(page: import('@playwright/test').Page, themeId: string, mode: string) {
  await page.evaluate(({ themeId, mode }) => {
    localStorage.setItem('beads-theme', themeId);

    const html = document.documentElement;
    if (themeId === 'default') {
      html.removeAttribute('data-theme');
    } else {
      html.setAttribute('data-theme', themeId);
    }

    if (mode === 'dark') {
      html.classList.add('dark');
      html.classList.remove('light');
    } else {
      html.classList.remove('dark');
      html.classList.add('light');
    }

    window.dispatchEvent(new CustomEvent('theme-change'));
  }, { themeId, mode });

  // Wait for any transitions to settle
  await page.waitForTimeout(500);
}

// ─── Screenshot tests for each theme × page ───

for (const theme of THEMES) {
  for (const pageDef of PAGES) {
    test(`${theme.name} - ${pageDef.name}`, async ({ page }) => {
      // Navigate first
      await page.goto(pageDef.path, { waitUntil: 'networkidle' });

      // Apply theme
      await applyTheme(page, theme.id, theme.mode);

      // Screenshot
      await expect(page).toHaveScreenshot(
        `${theme.id}-${pageDef.name}.png`,
        { fullPage: true, maxDiffPixelRatio: 0.02 }
      );
    });
  }
}

// ─── Project board test (requires a project in DB) ───

test.describe('project board themes', () => {
  test.beforeEach(async ({ page }) => {
    // Go to home and find first project link
    await page.goto('/', { waitUntil: 'networkidle' });
    const projectLink = page.locator('a[href*="/project?id="]').first();

    // Skip if no projects available
    const count = await projectLink.count();
    if (count === 0) {
      test.skip(true, 'No projects in database');
      return;
    }

    await projectLink.click();
    await page.waitForLoadState('networkidle');
  });

  for (const theme of THEMES) {
    test(`${theme.name} - board`, async ({ page }) => {
      await applyTheme(page, theme.id, theme.mode);

      await expect(page).toHaveScreenshot(
        `${theme.id}-board.png`,
        { fullPage: true, maxDiffPixelRatio: 0.02 }
      );
    });
  }
});
