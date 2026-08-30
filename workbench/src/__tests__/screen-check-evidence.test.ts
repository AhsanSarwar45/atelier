/** @vitest-environment node */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserExecutable, captureBrowserRecipe } from '../screen-check-browser';
import { comparePng } from '../screen-check-evidence';
import { screenCheckUploaded, type VisualJudge } from '../screen-check';

function png(colors: Array<[number, number, number, number]>): Buffer {
  const image = new PNG({ width: colors.length, height: 1 });
  colors.forEach((color, at) => color.forEach((value, channel) => { image.data[at * 4 + channel] = value; }));
  return PNG.sync.write(image);
}

describe('screen-check evidence', () => {
  let media: string; let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atelier-evidence-')); media = join(root, 'media'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.runIf(Boolean(browserExecutable()))('reports final navigation, redirects, timing, browser, dimensions, console, network, accessibility and visible DOM text', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/') { response.writeHead(302, { location: '/final' }); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' }); response.end('<main><h1>Evidence Ready</h1><button aria-label="Save changes">Save</button><img src="http://127.0.0.1:1/unavailable.png"><script>console.error("fixture")</script></main>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      const result = await captureBrowserRecipe({ url: `http://127.0.0.1:${address.port}/`, timeout_ms: 10_000, settle: { network_idle_ms: 10, layout_stable_ms: 100 } }, {});
      expect(result.evidence).toEqual(expect.objectContaining({ source: 'browser', status: 200,
        browser: expect.objectContaining({ engine: 'chromium', version: expect.any(String) }),
        dimensions: expect.objectContaining({ width: 1280, height: 800, device_scale_factor: 1 }),
        visible_text: expect.objectContaining({ source: 'dom', text: expect.stringContaining('Evidence Ready') }),
        accessibility: expect.objectContaining({ source: 'dom-accessibility-outline', nodes: expect.arrayContaining([expect.objectContaining({ role: 'button', name: 'Save changes' })]) }) }));
      expect(result.evidence.redirects).toEqual([expect.objectContaining({ status: 302 })]);
      expect(result.evidence.console.error_count).toBeGreaterThanOrEqual(1); expect(result.evidence.network.failure_count).toBeGreaterThanOrEqual(1);
      expect(result.evidence.timing_ms.total).toBeGreaterThanOrEqual(result.evidence.timing_ms.settle);
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
  }, 20_000);

  it('measures aligned PNG pixels and persists a content-addressed diff with OCR provenance', async () => {
    const before = png([[255, 0, 0, 255], [0, 0, 0, 255]]); const after = png([[255, 0, 0, 255], [255, 255, 255, 255]]);
    const objective = comparePng(before, after); expect(objective).toEqual(expect.objectContaining({ aligned: true, changed_pixels: 1, total_pixels: 2, difference_ratio: 0.5 }));
    const judge = vi.fn<VisualJudge>().mockResolvedValue({ verdict: 'PASS', summary: 'Changed.', observations: ['Second pixel changed.'], visible_text: { source: 'vision', lines: ['Ready'] } });
    const result = await screenCheckUploaded(['compare', '--before', 'before.png', '--after', 'after.png', '--expect', 'The state changed'], { 'before.png': before, 'after.png': after }, media, judge);
    expect(result.comparison).toEqual(expect.objectContaining({ method: 'pixelmatch', aligned: true, changed_pixels: 1, difference_ratio: 0.5, capture_configuration: expect.stringContaining('alignment verified') }));
    expect(result.diff_asset).toMatch(/\.png$/); expect(result.visible_text).toEqual({ source: 'vision', lines: ['Ready'] });
    expect((result.captures as any[])[0].evidence).toEqual(expect.objectContaining({ source: 'image', dimensions: { width: 2, height: 1 }, visible_text: { source: 'vision-required', text: '' } }));
  });

  it('refuses objective alignment when decoded PNG dimensions differ', () => {
    const result = comparePng(png([[0, 0, 0, 255]]), png([[0, 0, 0, 255], [0, 0, 0, 255]]));
    expect(result).toEqual(expect.objectContaining({ aligned: false, alignment: expect.objectContaining({ reason: expect.stringContaining('dimension mismatch') }) }));
  });

  it.runIf(Boolean(browserExecutable()))('captures a live before/after pair only under one reproducible browser configuration', async () => {
    const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<main id="state">Before</main><button onclick="state.textContent=\'After\';state.style.background=\'red\'">Change</button>'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture did not bind'); const url = `http://127.0.0.1:${address.port}/`;
    const before = Buffer.from(JSON.stringify({ url, settle: { network_idle_ms: 0, layout_stable_ms: 100 } }));
    const after = Buffer.from(JSON.stringify({ url, actions: [{ action: 'click', selector: 'button' }], settle: { network_idle_ms: 0, layout_stable_ms: 100 } }));
    const judge = vi.fn<VisualJudge>().mockResolvedValue({ verdict: 'PASS', summary: 'Changed.', observations: [], visible_text: { source: 'vision', lines: ['After'] } });
    try {
      const result = await screenCheckUploaded(['compare', '--before-recipe', 'before.json', '--after-recipe', 'after.json', '--expect', 'State changes'], { 'before.json': before, 'after.json': after }, media, judge);
      expect(result.comparison).toEqual(expect.objectContaining({ aligned: true, capture_configuration: expect.stringMatching(/^paired-browser-recipes; configuration=/) }));
      expect((result.captures as any[]).map((capture) => capture.evidence.final_url)).toEqual([url, url]);
      const incompatible = Buffer.from(JSON.stringify({ url, device: 'mobile' }));
      await expect(screenCheckUploaded(['compare', '--before-recipe', 'before.json', '--after-recipe', 'mobile.json', '--expect', 'State changes'], { 'before.json': before, 'mobile.json': incompatible }, media, judge)).rejects.toThrow('COMPARISON_NOT_ALIGNED');
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
  }, 20_000);
});
