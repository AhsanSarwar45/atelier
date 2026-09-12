import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const FIXTURE = join(__dirname, '..', '.workbench-run-split-choices');

/**
 * A choice and its default star are one control, not two (bw-ospn.1).
 *
 * The star used to float loose beside the button it spoke for, with a gap on
 * either side of it, so a row of four choices read as eight scattered things.
 * Joined into the shape the sidebar's New Chat button and its chevron already
 * have, the row reads as four controls that happen to have two halves.
 *
 * The picture is taken before anything is asserted, so a run against the old
 * screen still leaves the shot it is being compared with.
 */
test('every provider and account is one split control with its star', async ({ page, request }) => {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  await page.route(/\/api\/projects(\?[^/]*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const url = new URL(route.request().url());
    url.searchParams.set('include_test', 'true');
    await route.continue({ url: url.toString() });
  });
  const made = await request.post('/api/projects', {
    data: { name: 'split-choices', path: FIXTURE, isTest: true },
  });
  expect(made.status(), await made.text()).toBe(201);
  const project = (await made.json()) as { id: string };

  try {
    // Two accounts, because the Account section is only drawn when there is
    // more than one to choose between.
    await page.goto('/settings');
    for (const account of ['Azeem', 'Tapforce']) {
      await page.getByTestId('account-add-claude').click();
      await page.getByTestId('account-new-claude').fill(account);
      await page.getByTestId('account-new-confirm').click();
      await expect(page.getByTestId('account-new-dialog')).toHaveCount(0);
      // Naming an account runs straight on into signing it in. Nothing here is
      // signing in to anything, so that offer is closed again.
      await page.getByTestId('account-signin-close').click();
      await expect(page.getByTestId('account-signin-dialog')).toHaveCount(0);
    }

    await page.goto(`/project?id=${project.id}&tab=chat`);
    await page.getByTestId('new-chat-tool').click();
    const dialog = page.getByTestId('new-chat-provider-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('new-chat-profiles')).toBeVisible();

    mkdirSync('tests/results', { recursive: true });
    await dialog.screenshot({ path: 'tests/results/bw-ospn-3-after.png' });

    // One heading over each of the three questions, in one style: the dialog
    // used to title them three different ways (bw-ospn.3).
    const headings = dialog.locator('h3');
    await expect(headings).toHaveText(['Agent', 'Account', 'Worktree']);
    const faces = await headings.evaluateAll((all) =>
      all.map((one) => {
        const style = getComputedStyle(one);
        return [style.fontSize, style.fontWeight, style.textTransform, style.letterSpacing, style.color].join('/');
      }),
    );
    expect(new Set(faces).size).toBe(1);

    // The seam, on the pair the dialog opens holding and on a resting pair:
    // the choice is square on the side it shares, the star square on its own,
    // and the two are the same height.
    const claude = page.getByTestId('new-chat-provider-claude');
    const claudeStar = page.getByTestId('new-chat-provider-default-claude');
    await expect(claude).toHaveClass(/rounded-r-none/);
    await expect(claudeStar).toHaveClass(/rounded-l-none/);
    const account = page.getByTestId('new-chat-profile-system');
    const accountStar = page.getByTestId('new-chat-profile-default-system');
    await expect(account).toHaveClass(/rounded-r-none/);
    await expect(accountStar).toHaveClass(/rounded-l-none/);

    // Attached, with nothing between them: the star begins where the choice
    // ends, and they start and end at the same heights.
    for (const [left, right] of [[claude, claudeStar], [account, accountStar]] as const) {
      const one = await left.boundingBox();
      const two = await right.boundingBox();
      expect(one && two).toBeTruthy();
      expect(Math.abs(two!.x - (one!.x + one!.width))).toBeLessThanOrEqual(1);
      expect(Math.abs(two!.y - one!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(two!.height - one!.height)).toBeLessThanOrEqual(1);
    }

    // The star is still its own button: with an account picked, starring a
    // different one moves the default and leaves the pick alone.
    await page.getByTestId('new-chat-profile-azeem').click();
    await expect(page.getByTestId('new-chat-profile-azeem')).toHaveClass(/bg-primary/);
    const star = page.getByTestId('new-chat-profile-default-tapforce');
    await star.click();
    await expect(star).toHaveAttribute('data-default', 'true');
    await expect(page.getByTestId('new-chat-profile-azeem')).toHaveClass(/bg-primary/);
    await expect(page.getByTestId('new-chat-profile-tapforce')).not.toHaveClass(/bg-primary/);
  } finally {
    await request.delete(`/api/projects/${project.id}`);
    rmSync(FIXTURE, { recursive: true, force: true });
  }
});
