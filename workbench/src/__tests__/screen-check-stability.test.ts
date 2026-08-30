/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserExecutable, captureBrowserRecipe, parseBrowserRecipe, type BrowserRecipe } from '../screen-check-browser';

const A = Buffer.from('frame-a'); const B = Buffer.from('frame-b');

function harness(frames: Buffer[] = [A, A]) {
  const calls: Array<{ name: string; value?: any }> = []; const handlers: Record<string, Array<(value: any) => void>> = {};
  const locator: any = {
    first: () => locator,
    waitFor: async (value: any) => calls.push({ name: 'selector', value }),
    screenshot: async (value: any) => { calls.push({ name: 'element-shot', value }); return frames.shift() ?? A; },
  };
  const page: any = {
    on: (name: string, handler: (value: any) => void) => { (handlers[name] ??= []).push(handler); },
    goto: async () => {
      const request = { resourceType: () => 'document' }; handlers.request?.forEach((handler) => handler(request));
      await new Promise((resolve) => setTimeout(resolve, 2)); handlers.requestfinished?.forEach((handler) => handler(request));
    },
    waitForTimeout: async (ms: number) => { calls.push({ name: 'wait', value: ms }); if (ms) await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 2))); },
    waitForLoadState: async (state: string) => calls.push({ name: 'load', value: state }),
    addStyleTag: async (value: any) => calls.push({ name: 'style', value }),
    locator: (selector: string) => { calls.push({ name: 'locator', value: selector }); return locator; },
    getByText: (text: string) => { calls.push({ name: 'text', value: text }); return locator; },
    evaluate: async (input: unknown) => { calls.push({ name: typeof input === 'string' ? 'layout' : 'resources' }); return typeof input === 'string' ? 'same-layout' : undefined; },
    screenshot: async (value: any) => { calls.push({ name: 'page-shot', value }); return frames.shift() ?? A; },
    url: () => 'https://app.test/ready',
  };
  const context: any = { newPage: async () => page, close: vi.fn() };
  const browser: any = { newContext: vi.fn(async () => context), close: vi.fn() };
  return { runtime: { launch: vi.fn(async () => browser) }, browser, calls };
}

const settled = { network_idle_ms: 0, layout_stable_ms: 0, matching_frames: 2 } as BrowserRecipe['settle'];

describe('deterministic browser capture', () => {
  it.runIf(Boolean(browserExecutable()))('settles delayed semantic state, images, layout and animation in a real browser', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==', 'base64');
    const server = createServer((request, response) => {
      if (request.url === '/slow.png') { setTimeout(() => { response.writeHead(200, { 'content-type': 'image/png' }); response.end(png); }, 75); return; }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(`<!doctype html><style>@keyframes pulse{to{opacity:.5}}#box{animation:pulse 1s infinite}</style><main id="box"><span>Waiting</span><img src="/slow.png"></main><script>setTimeout(()=>{box.classList.add('ready');box.style.width='240px';box.querySelector('span').textContent='Complete'},50)</script>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      const result = await captureBrowserRecipe({ url: `http://127.0.0.1:${address.port}`, timeout_ms: 10_000,
        settle: { selector: '#box.ready', text: 'Complete', layout_stable_ms: 100 }, capture: { mode: 'full_page' } }, {});
      expect(result.bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(result.diagnostics).toEqual(expect.arrayContaining(['fonts=ready', 'images=ready', 'animations=disabled', 'capture=full_page']));
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
  }, 20_000);

  it('waits for load, network, semantic targets, resources, layout and matching frames while disabling motion', async () => {
    const fixture = harness([A, B, B]);
    const result = await captureBrowserRecipe({ url: 'https://app.test', settle: { ...settled, layout_stable_ms: 1, selector: '#ready', text: 'Complete' } }, {}, fixture.runtime);
    expect(fixture.calls.map((call) => call.name)).toEqual(expect.arrayContaining(['load', 'selector', 'text', 'resources', 'layout', 'style']));
    expect(fixture.calls.find((call) => call.name === 'style')?.value.content).toContain('animation-play-state:paused');
    expect(result.diagnostics).toEqual(expect.arrayContaining(['load=complete', 'network-idle-ms=0', 'fonts=ready', 'images=ready', 'layout-stable-ms=1', 'matching-frame-attempts=3']));
    expect(result.bytes).toBe(B);
  });

  it('supports viewport, full-page, element and clipped-region captures', async () => {
    const cases: Array<[BrowserRecipe['capture'], string, (value: any) => void]> = [
      [{ mode: 'viewport' }, 'page-shot', (value) => expect(value.fullPage).toBeUndefined()],
      [{ mode: 'full_page' }, 'page-shot', (value) => expect(value.fullPage).toBe(true)],
      [{ mode: 'element', selector: '#card' }, 'element-shot', () => undefined],
      [{ mode: 'clip', clip: { x: 1, y: 2, width: 30, height: 40 } }, 'page-shot', (value) => expect(value.clip).toEqual({ x: 1, y: 2, width: 30, height: 40 })],
    ];
    for (const [capture, callName, assertion] of cases) {
      const fixture = harness(); await captureBrowserRecipe({ url: 'https://app.test', settle: settled, capture }, {}, fixture.runtime);
      assertion(fixture.calls.find((call) => call.name === callName)?.value);
    }
  });

  it('applies reproducible desktop, tablet and mobile context presets', async () => {
    const expected = { desktop: [1280, 800, 1, false], tablet: [820, 1180, 2, true], mobile: [390, 844, 3, true] } as const;
    for (const device of ['desktop', 'tablet', 'mobile'] as const) {
      const fixture = harness(); await captureBrowserRecipe({ url: 'https://app.test', device, settle: settled }, {}, fixture.runtime);
      const options = fixture.browser.newContext.mock.calls[0][0];
      expect([options.viewport.width, options.viewport.height, options.deviceScaleFactor, options.isMobile]).toEqual(expected[device]);
      expect(options).toEqual(expect.objectContaining({ locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' }));
    }
  });

  it('strictly validates settling, device and capture configuration', () => {
    const recipe = parseBrowserRecipe(Buffer.from(JSON.stringify({ url: 'https://app.test', device: 'mobile', locale: 'en-GB', timezone: 'Europe/London', settle: { network_idle_ms: 250, layout_stable_ms: 300, matching_frames: 3, disable_animations: true, selector: '#ready', text: 'Done' }, capture: { mode: 'element', selector: '#card' } })));
    expect(recipe.device).toBe('mobile'); expect(recipe.capture?.mode).toBe('element');
    expect(() => parseBrowserRecipe(Buffer.from('{"url":"https://app.test","device":"watch"}'))).toThrow('device');
    expect(() => parseBrowserRecipe(Buffer.from('{"url":"https://app.test","device":"mobile","viewport":{"width":390,"height":844}}'))).toThrow('mutually exclusive');
    expect(() => parseBrowserRecipe(Buffer.from('{"url":"https://app.test","capture":{"mode":"element"}}'))).toThrow('capture.selector');
    expect(() => parseBrowserRecipe(Buffer.from('{"url":"https://app.test","capture":{"mode":"clip","clip":{"x":0,"y":0,"width":0,"height":10}}}'))).toThrow('capture.clip.width');
  });
});
