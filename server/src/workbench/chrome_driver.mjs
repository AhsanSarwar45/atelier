// Minimal Chrome DevTools driver for the private Chrome that
// `atelier tool chrome up` starts. Node 22 or later.
//
//   eval "$(atelier tool chrome env)"   # ATELIER_CHROME_PORT, ATELIER_CHROME_DRIVER
//   import { newContext, Session } from process.env.ATELIER_CHROME_DRIVER;
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.ATELIER_CHROME_PORT || process.env.QA_CDP_PORT;
if (!PORT) throw new Error('ATELIER_CHROME_PORT unset — run: eval "$(atelier tool chrome env)"');
const base = `http://127.0.0.1:${PORT}`;

export async function targets() {
  return (await fetch(`${base}/json/list`)).json();
}

export async function newTab(url = 'about:blank') {
  const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}

/**
 * An isolated browser context has its own cookie jar and storage, so several
 * simulated users can be signed in at once without overwriting each other.
 */
export async function newContext(url = 'about:blank') {
  const list = await targets();
  const anyPage = list.find(t => t.type === 'page');
  const bws = (await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl;
  const ws = new WebSocket(bws);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (() => {
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    return (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 30000);
    });
  })();
  const { browserContextId } = await send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await send('Target.createTarget', { url, browserContextId });
  ws.close();
  return { targetId, browserContextId };
}

/** Close one user's context and every page in it. */
export async function disposeContext(browserContextId) {
  const bws = (await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl;
  const ws = new WebSocket(bws);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await new Promise((res) => {
    ws.onmessage = () => res();
    ws.send(JSON.stringify({ id: 1, method: 'Target.disposeBrowserContext', params: { browserContextId } }));
    setTimeout(res, 5000);
  });
  ws.close();
}

export class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; this.size = { width: 1600, height: 1000 }; }

  static async attach(targetIdOrUrlPart) {
    const list = await targets();
    const page = list.find(t => t.type === 'page' && (t.id === targetIdOrUrlPart || (t.url || '').includes(targetIdOrUrlPart ?? '')))
      || list.find(t => t.type === 'page');
    if (!page) throw new Error('no page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Session(ws);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && s.pending.has(msg.id)) {
        const { res, rej } = s.pending.get(msg.id);
        s.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) s.events.push(msg);
    };
    s.target = page;
    await s.send('Page.enable');
    // Headless Chrome answers `(hover: none)` because it has no real pointer,
    // and some apps then hide their desktop interface. Tell the page it has a
    // mouse. This only changes those media queries; no app code is patched.
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        const mm = window.matchMedia.bind(window);
        window.matchMedia = (q) => {
          const r = mm(q);
          if (/hover:\\s*none|pointer:\\s*coarse/.test(q)) {
            return { ...r, matches: false, media: q,
              addEventListener: r.addEventListener.bind(r),
              removeEventListener: r.removeEventListener.bind(r),
              addListener: () => {}, removeListener: () => {}, onchange: null };
          }
          return r;
        };
      `,
    });
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1600, screenHeight: 1000, positionX: 0, positionY: 0,
    });
    await s.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'hover', value: 'hover' },
        { name: 'any-hover', value: 'hover' },
        { name: 'pointer', value: 'fine' },
        { name: 'any-pointer', value: 'fine' },
      ],
    });
    await s.send('Runtime.enable');
    await s.send('Network.enable');
    return s;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 60000);
    });
  }

  async applyDesktopEmulation() {
    const { width, height } = this.size;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
      screenWidth: width, screenHeight: height, positionX: 0, positionY: 0,
    });
    await this.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [
        { name: 'hover', value: 'hover' },
        { name: 'any-hover', value: 'hover' },
        { name: 'pointer', value: 'fine' },
        { name: 'any-pointer', value: 'fine' },
      ],
    });
  }

  /** Viewport for responsive checks; kept across later goto() calls. */
  async resize(width, height) {
    this.size = { width, height };
    await this.applyDesktopEmulation();
  }

  async goto(url, { waitMs = 1500 } = {}) {
    await this.applyDesktopEmulation();
    await this.send('Page.navigate', { url });
    await this.waitForLoad();
    await sleep(waitMs);
  }

  // Redirect chains destroy the context mid-evaluate, which would
  // otherwise hang until the 60s command timeout. Probe briefly; done once the
  // page is complete on the same URL for 800ms.
  async waitForLoad(timeout = 30000) {
    const start = Date.now();
    let last = '', since = 0;
    while (Date.now() - start < timeout) {
      const v = await Promise.race([
        this.send('Runtime.evaluate', { expression: 'document.readyState + " " + location.href', returnByValue: true })
          .then(r => r.result?.value).catch(() => null),
        sleep(2000).then(() => null),
      ]);
      if (v?.startsWith('complete ')) {
        if (v !== last) { last = v; since = Date.now(); } else if (Date.now() - since >= 800) return;
      } else last = '';
      await sleep(200);
    }
  }

  async eval(expr, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async()=>{ ${expr} })()`,
      awaitPromise, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result.value;
  }

  /** Focus an element by CSS/predicate then type real keystrokes into it. */
  async typeInto(selectorJs, text) {
    const ok = await this.eval(`
      const el = ${selectorJs};
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el.isContentEditable) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      return true;
    `);
    if (!ok) return 'target not found';
    await this.send('Input.insertText', { text });
    return 'typed';
  }

  // Text dump of the visible page, good enough to assert on copy.
  text() { return this.eval('return document.body.innerText'); }
  url()  { return this.eval('return location.href'); }

  /** Record request bodies so a save can be inspected on the wire. */
  startRecording() {
    this.recorded = [];
    this._recOff = false;
    this.ws.addEventListener('message', (m) => {
      if (this._recOff) return;
      const msg = JSON.parse(m.data);
      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request;
        this.recorded.push({ url: r.url, method: r.method, body: r.postData ?? null, id: msg.params.requestId });
      }
      if (msg.method === 'Network.responseReceived') {
        const hit = this.recorded.find(x => x.id === msg.params.requestId);
        if (hit) hit.status = msg.params.response.status;
      }
    });
  }

  stopRecording() { this._recOff = true; return this.recorded || []; }

  async responseBody(requestId) {
    try { return (await this.send('Network.getResponseBody', { requestId })).body; }
    catch { return null; }
  }

  async shot(path, { fullPage = false } = {}) {
    const p = fullPage ? { captureBeyondViewport: true } : {};
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', ...p });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  async waitForText(needle, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const t = await this.text();
      if (t && t.includes(needle)) return true;
      await sleep(300);
    }
    throw new Error(`waitForText timeout: ${needle}`);
  }

  close() { this.ws.close(); }
}

export { sleep };
