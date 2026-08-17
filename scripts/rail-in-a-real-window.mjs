/**
 * The scrollbars, measured and pictured in a browser that has a real window.
 *
 * Headless chromium draws overlay rails: a pane that scrolls reports
 * `offsetWidth - clientWidth === 0` and no rail ever lands in a screenshot. So a
 * headless run can say what a pane ASKS for and never what it GETS, and that gap
 * is how the app once shipped a 15px default rail behind a check that read
 * "thin" off the document. This opens a window off the side of the screen,
 * reports the width every scrolling pane actually gets, and saves the picture.
 *
 *   UI=http://127.0.0.1:3007 OUT=/tmp/rail.png node scripts/rail-in-a-real-window.mjs
 *
 * UI      the screen to read (a live preview, or the installed board)
 * BOARD   where the projects, cards and chats come from; a preview serves none
 * PROJECT the project to open; the first one the board lists by default
 * OUT     where the picture goes
 */
import { chromium } from 'playwright';

const UI = process.env.UI ?? 'http://127.0.0.1:3007';
const BOARD = process.env.BOARD ?? 'http://127.0.0.1:3008';
const OUT = process.env.OUT ?? '/tmp/rail-in-a-real-window.png';

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
const browser = await chromium.launch({
  headless: false,
  args: ['--window-position=-4000,-4000', '--window-size=1440,900'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
await page.goto(`${UI}/project?id=${project}&tab=board`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const rails = await page.evaluate(() =>
  [...document.querySelectorAll('*')]
    .filter((el) => el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4)
    .map((el) => ({
      what: el.getAttribute('data-testid') ?? el.tagName.toLowerCase(),
      /** What the rail actually takes out of the pane, sideways then downwards. */
      across: el.offsetWidth - el.clientWidth,
      down: el.offsetHeight - el.clientHeight,
      asked: getComputedStyle(el).scrollbarWidth,
      ink: getComputedStyle(el).scrollbarColor,
    }))
    .filter((r) => r.across > 0 || r.down > 0),
);
console.log(JSON.stringify(rails, null, 2));

await page.screenshot({ path: OUT });
console.log(`picture: ${OUT}`);
await browser.close();
