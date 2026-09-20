import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * The project's name in the bar as the way to another project.
 *
 * The manager asked for it off the running app: "the project name should be
 * [name] v (chevron) that will open a popup where we show the recent projects
 * (5 or something) where we can quick switch between projects" (bw-r8dg).
 *
 * So the case is the whole of that sentence on a phone: the name carries a
 * chevron, pressing it brings a sheet up from the bottom edge, the sheet holds
 * the projects most recently visited — five of them at most, and never the one
 * already open, which the bar above is already naming — and pressing one lands
 * on that project's own screen.
 *
 * Seven projects are registered, each touched in turn, so the list has both
 * more than it may show and an order it did not arrive in.
 *
 *   scripts/workbench-e2e.sh tests/e2e/the-bar-name-switches-project.spec.ts
 */
const SHOTS = join(process.cwd(), 'tests', 'results');
const PHONE = { width: 390, height: 844 };

/** What the sheet may hold (src/lib/recent-projects.ts). */
const RECENT = 5;

/**
 * Named for this case alone. The stack is shared with whatever else is running
 * against it, and a project another case registered while this one is open is
 * a perfectly correct row in a list of recent projects — so the rows are read
 * back through these names rather than assumed to be the only ones there.
 */
const NAMES = [
  'Switch Keystone',
  'Switch Ledger',
  'Switch Atlas',
  'Switch Beacon',
  'Switch Cartogram',
  'Switch Drydock',
  'Switch Eventide',
];

test.use({ hasTouch: true, isMobile: true });

test('the name in the bar opens the recent projects and switches to one', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const fixture = join(process.cwd(), 'tests', '.workbench-run-bar-switch');
  rmSync(fixture, { recursive: true, force: true });
  const made: { id: string; name: string }[] = [];

  try {
    // Registered oldest first and each one touched as it is made, so the
    // server's `last_opened` order is the reverse of this list and the sheet
    // has to have sorted rather than simply kept what it was handed.
    for (const name of NAMES) {
      const path = join(fixture, name);
      mkdirSync(path, { recursive: true });
      const response = await request.post('/api/projects', { data: { name, path } });
      expect(response.status(), await response.text()).toBe(201);
      const project = (await response.json()) as { id: string };
      const touched = await request.post(`/api/projects/${project.id}/touch`);
      expect(touched.ok(), await touched.text()).toBeTruthy();
      made.push({ id: project.id, name });
    }
    // The one the reader is in is the one touched longest ago, so it would be
    // last in the list if it were in the list at all.
    const open = made[0];
    const newest = [...made].slice(1).reverse();

    await page.setViewportSize(PHONE);
    await page.goto(`/project?id=${open.id}`);
    const name = page.getByTestId('project-switch');
    await expect(name).toContainText(open.name, { timeout: 60_000 });

    // The chevron is part of the control, not a second button beside it.
    await expect(name.locator('svg')).toBeVisible();

    // And the name is still what this screen IS. Making it a control is not
    // allowed to cost the screen its heading, which is what a reader arriving
    // by screen reader looks for first (bw-r8dg.2).
    await expect(
      page.getByRole('heading', { name: open.name }),
      'the project screen has no heading naming the project',
    ).toBeVisible();

    await name.click();
    const panel = page.getByTestId('project-switch-panel');
    await expect(panel, 'the name did not open anything').toBeVisible({ timeout: 30_000 });

    const rows = panel.getByTestId('project-switch-row');
    await expect(rows).toHaveCount(RECENT, { timeout: 30_000 });
    await expect(rows.first()).not.toBeEmpty();

    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOTS, 'project-switch-sheet.png') });

    // Most recently opened first, and the open project is not among them. Read
    // through this case's own names, so a project belonging to another case
    // running on the same stack is passed over rather than failing this one.
    const listed = (await rows.allInnerTexts()).map((t) => t.trim());
    const mine = listed.filter((t) => NAMES.includes(t));
    expect(
      mine,
      `the sheet listed ${listed.join(', ')}, which is not the order they were last opened in`,
    ).toEqual(newest.map((p) => p.name).filter((n) => mine.includes(n)));
    expect(mine.length, 'the sheet listed none of this case’s projects').toBeGreaterThan(1);
    expect(
      listed,
      'the project already open was offered as somewhere to go',
    ).not.toContain(open.name);

    // It comes up from the bottom edge, where a thumb is.
    const sheet = (await panel.boundingBox())!;
    expect(
      Math.round(sheet.y + sheet.height),
      'the sheet does not sit on the bottom edge of the screen',
    ).toBe(PHONE.height);

    // And it takes the reader there.
    const going = newest.find((p) => mine.includes(p.name))!;
    await rows.filter({ hasText: going.name }).click();
    await expect(page).toHaveURL(new RegExp(`id=${going.id}`), { timeout: 30_000 });
    await expect(page.getByTestId('project-switch')).toContainText(going.name, { timeout: 60_000 });
    await expect(panel, 'the sheet stayed up over the project it opened').toBeHidden();
  } finally {
    for (const project of made) await request.delete(`/api/projects/${project.id}`);
    rmSync(fixture, { recursive: true, force: true });
  }
});
