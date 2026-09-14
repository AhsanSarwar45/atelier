import { expect, type Page } from '@playwright/test';

/**
 * Put the chat's right column in front, on its Git tab.
 *
 * Git used to be a button on the tab bar that did two jobs at once: it opened
 * the column and it chose what was in it. It is a tab inside the column now
 * (bw-rpgh.4), so reaching the Git view is two steps — open the column if it is
 * shut, then press Git. Every spec that used to press [chat-git-toggle] calls
 * this instead, so the two steps are written once.
 */
export async function openGitView(page: Page): Promise<void> {
  const rail = page.getByTestId('chat-right-rail');
  if ((await rail.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('chat-right-rail-toggle').click();
    await expect(rail).toHaveAttribute('data-open', 'true', { timeout: 15_000 });
  }
  await page.getByTestId('rail-tab-git').click();
  await expect(rail).toHaveAttribute('data-view', 'git', { timeout: 15_000 });
}

/** Whether this screen has a Git view to open at all. */
export async function gitViewExists(page: Page): Promise<boolean> {
  return (await page.getByTestId('chat-right-rail-toggle').count()) > 0;
}
