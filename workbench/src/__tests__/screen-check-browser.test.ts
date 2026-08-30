/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { browserExecutable, captureBrowserRecipe, parseBrowserRecipe } from '../screen-check-browser';

const PNG = Buffer.from('png');

function fakeRuntime() {
  const calls: string[] = [];
  const locator: any = {
    first: () => locator,
    click: async () => calls.push('click'), fill: async (value: string) => calls.push(`fill:${value}`),
    pressSequentially: async (value: string) => calls.push(`type:${value}`), press: async (value: string) => calls.push(`press:${value}`),
    selectOption: async (value: string[]) => calls.push(`select:${value.join(',')}`), check: async () => calls.push('check'),
    uncheck: async () => calls.push('uncheck'), hover: async () => calls.push('hover'), waitFor: async () => calls.push('wait-for'),
    setInputFiles: async (value: any) => calls.push(`upload:${value.name}:${value.buffer.toString()}`),
  };
  const page: any = {
    on: vi.fn(), goto: async (url: string) => calls.push(`goto:${url}`), locator: () => locator,
    getByText: () => locator, waitForTimeout: async (ms: number) => calls.push(`wait:${ms}`),
    screenshot: async () => PNG, url: () => 'https://app.test/home',
  };
  const context: any = { newPage: async () => page, close: vi.fn() };
  const browser: any = { newContext: vi.fn(async () => context), close: vi.fn() };
  return { runtime: { launch: vi.fn(async () => browser) }, browser, calls };
}

describe('screen-check browser recipes', () => {
  it.runIf(Boolean(browserExecutable()))('drives an authenticated isolated browser fixture', async () => {
    const server = createServer((request, response) => {
      if (request.headers['x-screen-auth'] !== 'allowed') { response.writeHead(401).end('unauthorized'); return; }
      response.setHeader('content-type', 'text/html'); response.end(`<!doctype html><html><body>
        <input id="name"><select id="role"><option value="reader">Reader</option><option value="owner">Owner</option></select>
        <label><input id="agree" type="checkbox">Agree</label><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value+' '+document.querySelector('#role').value+' '+document.querySelector('#agree').checked">Save</button>
        <output id="result"></output></body></html>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      const result = await captureBrowserRecipe({
        url: `http://127.0.0.1:${address.port}`,
        auth: { headers: { 'x-screen-auth': 'allowed' } },
        actions: [
          { action: 'fill', selector: '#name', value: 'Ada' },
          { action: 'select', selector: '#role', values: ['owner'] },
          { action: 'check', selector: '#agree' }, { action: 'click', selector: '#save' },
          { action: 'wait_for_text', text: 'Ada owner true' },
        ],
      }, {});
      expect(result.bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(result.finalUrl).toBe(`http://127.0.0.1:${address.port}/`);
      expect(JSON.stringify(result)).not.toContain('allowed');
    } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
  }, 20_000);

  it('prepares explicit authentication and runs every bounded interaction', async () => {
    const recipe = parseBrowserRecipe(Buffer.from(JSON.stringify({
      url: 'https://app.test/login', auth: { storage_state: 'state.json', headers: { 'x-test': 'safe' }, http_credentials: { username: 'u', password: 'p' } },
      actions: [
        { action: 'fill', selector: '#email', value: 'person@example.test' }, { action: 'type', selector: '#name', text: 'Ada' },
        { action: 'press', selector: '#name', key: 'Enter' }, { action: 'click', selector: 'button' },
        { action: 'select', selector: 'select', values: ['one'] }, { action: 'check', selector: '#yes' },
        { action: 'uncheck', selector: '#no' }, { action: 'hover', selector: '#menu' },
        { action: 'upload', selector: 'input[type=file]', file: 'proof.txt' }, { action: 'wait_for', selector: '#ready' },
        { action: 'wait_for_text', text: 'Welcome' }, { action: 'wait', milliseconds: 10 },
        { action: 'goto', url: 'https://app.test/home' },
      ],
    })));
    const { runtime, browser, calls } = fakeRuntime();
    const result = await captureBrowserRecipe(recipe, { 'state.json': Buffer.from('{"cookies":[],"origins":[]}'), 'proof.txt': Buffer.from('hello') }, runtime);
    expect(result.bytes).toBe(PNG);
    expect(calls).toEqual(expect.arrayContaining(['fill:person@example.test', 'type:Ada', 'press:Enter', 'click', 'select:one', 'check', 'uncheck', 'hover', 'upload:proof.txt:hello', 'wait-for', 'wait:10', 'goto:https://app.test/home']));
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { 'x-test': 'safe' }, httpCredentials: { username: 'u', password: 'p' } }));
    expect(JSON.stringify(result)).not.toContain('person@example.test');
    expect(JSON.stringify(result)).not.toContain('safe');
  });

  it('rejects arbitrary code, unknown fields, oversized recipes and missing auth files', async () => {
    expect(() => parseBrowserRecipe(Buffer.from('{"url":"https://x","evaluate":"steal()"}'))).toThrow('unknown field');
    expect(() => parseBrowserRecipe(Buffer.from(JSON.stringify({ url: 'https://x', actions: [{ action: 'evaluate', text: 'x' }] })))).toThrow('unsupported action');
    expect(() => parseBrowserRecipe(Buffer.from(JSON.stringify({ url: 'file:///secret' })))).toThrow('http or https');
    expect(() => parseBrowserRecipe(Buffer.from(JSON.stringify({ url: 'https://x', actions: Array(51).fill({ action: 'wait', milliseconds: 1 }) })))).toThrow('at most 50');
    const { runtime } = fakeRuntime();
    await expect(captureBrowserRecipe({ url: 'https://x', auth: { storage_state: 'missing.json' } }, {}, runtime)).rejects.toThrow('not supplied');
  });
});
