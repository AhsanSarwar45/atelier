import { expect, type Page } from '@playwright/test';

/**
 * Put the chat in front, on the projects that have a tab strip to do it with.
 *
 * The strip is drawn only for a project that uses Beads, and while the project
 * is still being fetched `usesBeads` reads as true — so for a fixture that is a
 * bare directory with no board the strip is on screen for a moment and then
 * gone for good. A bare `click()` carries no deadline of its own, so a case that
 * lost that race waited for an element that was never coming back and died on
 * the whole test's deadline saying only "Test timeout exceeded", naming neither
 * a line nor a locator. Two live cases spent five and ten minutes each failing
 * that way, and the page they left behind looked like an app that had done
 * nothing at all (bw-t26l.20).
 *
 * The project's own name settles the question: it is drawn from the same fetch,
 * so once it is on screen the strip's presence is final and asking whether the
 * tab is there is a question with an answer.
 */
export async function openChatTab(page: Page): Promise<void> {
  await expect(page.getByTestId('project-name')).not.toHaveText('', { timeout: 30_000 });
  const tab = page.getByTestId('tab-chat');
  if ((await tab.count()) > 0) {
    await tab.click();
  }
}
