import { expect, test } from '@playwright/test';

test('the embedded frontend carries every typeface its themes name', async ({ page }) => {
  await page.goto('/');
  const loaded = await page.evaluate(async () => {
    const families = [
      'Inter Variable',
      'Space Grotesk Variable',
      'Space Mono',
      'Plus Jakarta Sans Variable',
    ];
    return Object.fromEntries(
      await Promise.all(
        families.map(async (family) => [
          family,
          (await document.fonts.load(`16px "${family}"`, 'Atelier typography')).length,
        ]),
      ),
    );
  });

  expect(loaded).toEqual({
    'Inter Variable': 1,
    'Space Grotesk Variable': 1,
    'Space Mono': 1,
    'Plus Jakarta Sans Variable': 1,
  });
});
