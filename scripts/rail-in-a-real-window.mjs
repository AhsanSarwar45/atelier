/**
 * The scrollbars, measured, coloured and pictured in a browser with a real window.
 *
 * Headless chromium draws overlay rails: a pane that scrolls reports
 * `offsetWidth - clientWidth === 0` and no rail ever lands in a screenshot. So a
 * headless run can say what a pane ASKS for and never what it GETS, and that gap
 * is how the app once shipped a 15px default rail behind a check that read
 * "thin" off the document. This opens a window off the side of the screen,
 * reports the width every scrolling pane actually gets, reads the rail's colour
 * back out of the picture it took, and saves the picture.
 *
 * The theme matters to what this proves. The default palette's quiet ink is a
 * neutral grey, and a grey rail is one no browser default can be told apart
 * from — so the picture would show the rail got thinner and nothing about whose
 * colour it is. A theme with a tinted quiet ink is the default here, and the
 * sampled colour is checked against what that theme's ink comes to over the
 * pane behind it.
 *
 *   UI=http://127.0.0.1:3007 OUT=/tmp/rail.png node scripts/rail-in-a-real-window.mjs
 *
 * UI      the screen to read (a live preview, or the installed board)
 * BOARD   where the projects, cards and chats come from; a preview serves none
 * PROJECT the project to open; the first one the board lists by default
 * THEME   the skin to wear; one whose quiet ink is tinted, so the rail's colour
 *         is evidence. `default` for no skin at all.
 * ENGINE  chromium (the default) or firefox. The two read different halves of
 *         the rules, so a claim about the rail holds for one engine only until
 *         it has been looked at in the other.
 * OUT     where the picture goes; a close-up of one rail is saved beside it
 */
import { readFileSync } from 'node:fs';

import { chromium, firefox } from 'playwright';

const UI = process.env.UI ?? 'http://127.0.0.1:3007';
const BOARD = process.env.BOARD ?? 'http://127.0.0.1:3008';
const THEME = process.env.THEME ?? 'catppuccin-mocha';
const ENGINE = process.env.ENGINE ?? 'chromium';
const OUT = process.env.OUT ?? '/tmp/rail-in-a-real-window.png';
const CLOSE_UP = OUT.replace(/(\.png)?$/i, '-close-up.png');

async function firstProject() {
  try {
    const listed = await (await fetch(`${BOARD.replace(/\/$/, '')}/api/projects`)).json();
    return listed?.[0]?.id;
  } catch {
    return undefined;
  }
}

const project = process.env.PROJECT ?? (await firstProject());
if (!project) {
  console.error(`no project to open: pass PROJECT=<id>, or point BOARD at an instance that lists one (${BOARD})`);
  process.exit(1);
}

// Off the side of the screen: this is run while someone is working, and a window
// that steals the front is worse than no picture.
const browser =
  ENGINE === 'firefox'
    ? // Firefox takes no window-placement switches, and headless Firefox hides
      // scrollbars wholesale — every element reports `none` however the page
      // asks — so this one has to take the front of the screen for a moment.
      await firefox.launch({ headless: false, args: ['-width', '1440', '-height', '900'] })
    : await chromium.launch({
        headless: false,
        args: ['--window-position=-4000,-4000', '--window-size=1440,900'],
      });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
// The skin is read on load, so it is stored before the first one.
await page.addInitScript((theme) => {
  if (theme === 'default') localStorage.removeItem('beads-theme');
  else localStorage.setItem('beads-theme', theme);
}, THEME);
await page.goto(`${UI}/project?id=${project}&tab=board`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const rails = await page.evaluate(() =>
  [...document.querySelectorAll('*')]
    .filter((el) => el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4)
    .map((el) => {
      const box = el.getBoundingClientRect();
      return {
        what: el.getAttribute('data-testid') ?? el.tagName.toLowerCase(),
        /** What the rail actually takes out of the pane, sideways then downwards. */
        across: el.offsetWidth - el.clientWidth,
        down: el.offsetHeight - el.clientHeight,
        asked: getComputedStyle(el).scrollbarWidth,
        ink: getComputedStyle(el).scrollbarColor,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        /** Roughly how long the thumb is: the close-up wants the longest one. */
        thumbLength: Math.round((el.clientHeight * el.clientHeight) / Math.max(1, el.scrollHeight)),
      };
    })
    .filter((r) => r.across > 0 || r.down > 0),
);
console.log(JSON.stringify(rails.map(({ box, thumbLength, ...rest }) => rest), null, 2));

await page.screenshot({ path: OUT });

// The colour, read back out of the picture rather than off the rules: the rules
// say what was asked for, the pixels say what the reader sees.
// The pane with the longest thumb, out of the ones wholly on screen: a close-up
// of a twenty-pixel thumb shows nothing, a rail past the edge of the window is
// not in the picture at all, and every pane's rail is drawn the same way.
const seen = page.viewportSize();
const down = rails
  .filter(
    (r) =>
      r.across > 0 &&
      r.box.x >= 0 &&
      r.box.y >= 0 &&
      r.box.x + r.box.width <= seen.width &&
      r.box.y + r.box.height <= seen.height,
  )
  .sort((a, b) => b.thumbLength - a.thumbLength)[0];
if (down) {
  const shot = readFileSync(OUT).toString('base64');
  const colour = await page.evaluate(
    async ({ shot, box, across }) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${shot}`)).blob(),
      );
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0);
      const scale = bitmap.width / window.innerWidth;
      const context = canvas.getContext('2d');
      const at = (x, y) => [...context.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3);

      // Down the middle of the rail, the whole length of the pane. Two colours
      // come back: the track, which is most of it, and the thumb.
      const railX = box.x + box.width - across / 2;
      const tally = new Map();
      for (let y = box.y + 2; y < box.y + box.height - 2; y += 1) {
        const key = at(railX, y).join(',');
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      const seen = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const say = ([key, n]) => ({ colour: `rgb(${key.split(',').join(', ')})`, pixels: n });
      const [track, thumb] = [say(seen[0]), seen[1] ? say(seen[1]) : null];

      // Where down the rail the thumb is, so the close-up can be pointed at it.
      let band = null;
      if (thumb) {
        const key = seen[1][0];
        for (let y = box.y + 2; y < box.y + box.height - 2; y += 1) {
          if (at(railX, y).join(',') !== key) continue;
          band = band ? { top: band.top, bottom: y } : { top: y, bottom: y };
        }
      }

      // What the theme's quiet ink comes to at a quarter strength over what is
      // actually drawn beside the rail — both sides of the comparison read off
      // the picture, not off the rules.
      const behind = at(box.x + box.width - across - 3, box.y + box.height / 2);
      const probe = document.createElement('span');
      probe.style.color = `hsl(${getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim()})`;
      document.body.appendChild(probe);
      const ink = getComputedStyle(probe).color.match(/\d+/g).map(Number);
      probe.remove();
      // Each skin names how much of that ink its own slider is drawn in.
      const share = Number(getComputedStyle(document.documentElement).getPropertyValue('--rail-strength').trim() || 0.25);
      const wanted = ink.map((c, i) => Math.round(c * share + behind[i] * (1 - share)));

      return {
        theme: document.documentElement.dataset.theme ?? '(default)',
        track,
        thumb,
        besideTheRail: `rgb(${behind.join(', ')})`,
        wantedThumb: `rgb(${wanted.join(', ')})`,
        band,
        /** How far the drawn thumb is from the theme's ink, per channel. */
        off: thumb
          ? Math.max(...thumb.colour.match(/\d+/g).map((c, i) => Math.abs(Number(c) - wanted[i])))
          : null,
      };
    },
    { shot, box: down.box, across: down.across },
  );
  const { band, ...said } = colour;
  console.log(JSON.stringify(said, null, 2));

  // A close-up pointed at the thumb, because six pixels in a picture of a whole
  // screen is not a thing anyone can look at.
  const view = page.viewportSize();
  const top = band ? band.top : down.box.y + down.box.height * 0.1;
  const tall = band ? band.bottom - band.top : 0;
  const clip = {
    x: Math.max(0, Math.min(view.width - 40, down.box.x + down.box.width - 40)),
    y: Math.max(0, Math.min(view.height - 8, top - 24)),
    width: 40,
    height: tall + 48,
  };
  clip.height = Math.max(8, Math.min(view.height - clip.y, clip.height));
  await page.screenshot({ path: CLOSE_UP, clip, scale: 'device' });
  console.log(`close-up: ${CLOSE_UP}`);
}

console.log(`picture: ${OUT}`);
await browser.close();
