import { expect, type Page } from '@playwright/test';

/**
 * Put the chat in front.
 *
 * Every project draws the tab strip, so the Chat tab is always there to click.
 * The wait carries its own deadline, so a page that never drew the strip fails
 * here, naming the locator, instead of on the whole test's deadline.
 */
export async function openChatTab(page: Page): Promise<void> {
  const tab = page.getByTestId('tab-chat');
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.click();
}
