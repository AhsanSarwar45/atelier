import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';

export type BrowserAction =
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'type'; selector: string; text: string; delay_ms?: number }
  | { action: 'press'; selector: string; key: string }
  | { action: 'select'; selector: string; values: string[] }
  | { action: 'check' | 'uncheck' | 'hover'; selector: string }
  | { action: 'upload'; selector: string; file: string }
  | { action: 'wait'; milliseconds: number }
  | { action: 'wait_for'; selector: string; state?: 'attached' | 'detached' | 'visible' | 'hidden' }
  | { action: 'wait_for_text'; text: string };

export type BrowserRecipe = {
  url: string;
  timeout_ms?: number;
  viewport?: { width: number; height: number };
  device?: 'desktop' | 'tablet' | 'mobile';
  locale?: string;
  timezone?: string;
  theme?: 'light' | 'dark' | 'system';
  auth?: {
    storage_state?: string;
    headers?: Record<string, string>;
    http_credentials?: { username: string; password: string };
  };
  actions?: BrowserAction[];
  settle?: {
    network_idle_ms?: number;
    layout_stable_ms?: number;
    matching_frames?: number;
    disable_animations?: boolean;
    selector?: string;
    text?: string;
  };
  capture?: {
    mode?: 'viewport' | 'full_page' | 'element' | 'clip';
    selector?: string;
    clip?: { x: number; y: number; width: number; height: number };
  };
};

export type BrowserCapture = {
  bytes: Buffer;
  diagnostics: string[];
  finalUrl: string;
  comparisonUrl: string;
  evidence: {
    source: 'browser';
    final_url: string;
    status: number | null;
    redirects: Array<{ url: string; status: number }>;
    timing_ms: { total: number; actions: number; settle: number };
    browser: { engine: 'chromium'; version: string };
    dimensions: { width: number; height: number; device_scale_factor: number; mode: string };
    console: { error_count: number };
    network: { failure_count: number };
    visible_text: { source: 'dom'; text: string };
    accessibility: { source: 'dom-accessibility-outline'; nodes: Array<{ role: string; name: string }> };
  };
};

type Runtime = {
  launch(executablePath: string): Promise<Browser>;
};

const ALLOWED_RECIPE = new Set(['url', 'timeout_ms', 'viewport', 'device', 'locale', 'timezone', 'theme', 'auth', 'actions', 'settle', 'capture']);
const ALLOWED_AUTH = new Set(['storage_state', 'headers', 'http_credentials']);
const ALLOWED_SETTLE = new Set(['network_idle_ms', 'layout_stable_ms', 'matching_frames', 'disable_animations', 'selector', 'text']);
const ALLOWED_CAPTURE = new Set(['mode', 'selector', 'clip']);
const ACTION_FIELDS: Record<BrowserAction['action'], Set<string>> = {
  goto: new Set(['action', 'url']), click: new Set(['action', 'selector']),
  fill: new Set(['action', 'selector', 'value']), type: new Set(['action', 'selector', 'text', 'delay_ms']),
  press: new Set(['action', 'selector', 'key']), select: new Set(['action', 'selector', 'values']),
  check: new Set(['action', 'selector']), uncheck: new Set(['action', 'selector']), hover: new Set(['action', 'selector']),
  upload: new Set(['action', 'selector', 'file']), wait: new Set(['action', 'milliseconds']),
  wait_for: new Set(['action', 'selector', 'state']), wait_for_text: new Set(['action', 'text']),
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 10_000) throw new Error(`${label} must be a non-empty bounded string`);
  return value;
}

function httpUrl(value: unknown, label: string): string {
  const url = text(value, label);
  if (!/^https?:\/\//.test(url)) throw new Error(`${label} must be an http or https URL`);
  return url;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  return Number(value);
}

export function parseBrowserRecipe(bytes: Buffer): BrowserRecipe {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('browser recipe must be valid JSON'); }
  const recipe = object(parsed, 'browser recipe'); exact(recipe, ALLOWED_RECIPE, 'browser recipe');
  httpUrl(recipe.url, 'url');
  if (recipe.timeout_ms !== undefined && (!Number.isInteger(recipe.timeout_ms) || Number(recipe.timeout_ms) < 100 || Number(recipe.timeout_ms) > 120_000)) {
    throw new Error('timeout_ms must be an integer from 100 through 120000');
  }
  if (recipe.viewport !== undefined) {
    const viewport = object(recipe.viewport, 'viewport'); exact(viewport, new Set(['width', 'height']), 'viewport');
    integer(viewport.width, 'viewport.width', 100, 7680); integer(viewport.height, 'viewport.height', 100, 4320);
  }
  if (recipe.device !== undefined && !['desktop', 'tablet', 'mobile'].includes(String(recipe.device))) throw new Error('device must be desktop, tablet, or mobile');
  if (recipe.viewport !== undefined && recipe.device !== undefined) throw new Error('viewport and device are mutually exclusive');
  if (recipe.locale !== undefined) text(recipe.locale, 'locale');
  if (recipe.timezone !== undefined) text(recipe.timezone, 'timezone');
  if (recipe.theme !== undefined && !['light', 'dark', 'system'].includes(String(recipe.theme))) throw new Error('theme must be light, dark, or system');
  if (recipe.auth !== undefined) {
    const auth = object(recipe.auth, 'auth'); exact(auth, ALLOWED_AUTH, 'auth');
    if (auth.storage_state !== undefined) text(auth.storage_state, 'auth.storage_state');
    if (auth.headers !== undefined) {
      const headers = object(auth.headers, 'auth.headers');
      if (Object.keys(headers).length > 50 || Object.values(headers).some((item) => typeof item !== 'string')) throw new Error('auth.headers must contain at most 50 string values');
    }
    if (auth.http_credentials !== undefined) {
      const credentials = object(auth.http_credentials, 'auth.http_credentials');
      exact(credentials, new Set(['username', 'password']), 'auth.http_credentials');
      text(credentials.username, 'auth.http_credentials.username'); text(credentials.password, 'auth.http_credentials.password');
    }
  }
  if (recipe.actions !== undefined) {
    if (!Array.isArray(recipe.actions) || recipe.actions.length > 50) throw new Error('actions must contain at most 50 entries');
    recipe.actions.forEach((candidate, at) => {
      const action = object(candidate, `actions[${at}]`); const name = text(action.action, `actions[${at}].action`) as BrowserAction['action'];
      const fields = ACTION_FIELDS[name]; if (!fields) throw new Error(`actions[${at}] has unsupported action: ${name}`);
      exact(action, fields, `actions[${at}]`);
      if ('selector' in action) text(action.selector, `actions[${at}].selector`);
      if (name === 'goto') httpUrl(action.url, `actions[${at}].url`);
      if (name === 'fill') text(action.value, `actions[${at}].value`);
      if (name === 'type') { text(action.text, `actions[${at}].text`); if (action.delay_ms !== undefined && (!Number.isInteger(action.delay_ms) || Number(action.delay_ms) < 0 || Number(action.delay_ms) > 1000)) throw new Error(`actions[${at}].delay_ms is out of range`); }
      if (name === 'press') text(action.key, `actions[${at}].key`);
      if (name === 'select' && (!Array.isArray(action.values) || action.values.length > 20 || action.values.some((item) => typeof item !== 'string'))) throw new Error(`actions[${at}].values must be bounded strings`);
      if (name === 'upload') text(action.file, `actions[${at}].file`);
      if (name === 'wait' && (!Number.isInteger(action.milliseconds) || Number(action.milliseconds) < 0 || Number(action.milliseconds) > 30_000)) throw new Error(`actions[${at}].milliseconds is out of range`);
      if (name === 'wait_for' && action.state !== undefined && !['attached', 'detached', 'visible', 'hidden'].includes(String(action.state))) throw new Error(`actions[${at}].state is invalid`);
      if (name === 'wait_for_text') text(action.text, `actions[${at}].text`);
    });
  }
  if (recipe.settle !== undefined) {
    const settle = object(recipe.settle, 'settle'); exact(settle, ALLOWED_SETTLE, 'settle');
    if (settle.network_idle_ms !== undefined) integer(settle.network_idle_ms, 'settle.network_idle_ms', 0, 5000);
    if (settle.layout_stable_ms !== undefined) integer(settle.layout_stable_ms, 'settle.layout_stable_ms', 100, 5000);
    if (settle.matching_frames !== undefined) integer(settle.matching_frames, 'settle.matching_frames', 2, 5);
    if (settle.disable_animations !== undefined && typeof settle.disable_animations !== 'boolean') throw new Error('settle.disable_animations must be a boolean');
    if (settle.selector !== undefined) text(settle.selector, 'settle.selector');
    if (settle.text !== undefined) text(settle.text, 'settle.text');
  }
  if (recipe.capture !== undefined) {
    const capture = object(recipe.capture, 'capture'); exact(capture, ALLOWED_CAPTURE, 'capture');
    const mode = capture.mode ?? 'viewport';
    if (!['viewport', 'full_page', 'element', 'clip'].includes(String(mode))) throw new Error('capture.mode is invalid');
    if (mode === 'element') text(capture.selector, 'capture.selector');
    if (mode === 'clip') {
      const clip = object(capture.clip, 'capture.clip'); exact(clip, new Set(['x', 'y', 'width', 'height']), 'capture.clip');
      for (const field of ['x', 'y', 'width', 'height'] as const) {
        if (typeof clip[field] !== 'number' || !Number.isFinite(clip[field]) || Number(clip[field]) < (field === 'width' || field === 'height' ? 1 : 0)) throw new Error(`capture.clip.${field} is invalid`);
      }
    }
    if (mode !== 'element' && capture.selector !== undefined) throw new Error('capture.selector requires element mode');
    if (mode !== 'clip' && capture.clip !== undefined) throw new Error('capture.clip requires clip mode');
  }
  return parsed as BrowserRecipe;
}

export function browserExecutable(): string | null {
  const names = process.platform === 'darwin'
    ? ['google-chrome', 'chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['google-chrome', 'chromium', 'chromium-browser'];
  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name;
    try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] || null; }
    catch { /* try next */ }
  }
  return null;
}

function remaining(deadline: number): number {
  const value = deadline - Date.now(); if (value < 1) throw new Error('WEB_CAPTURE_TIMEOUT: the recipe exceeded timeout_ms'); return value;
}

async function perform(page: Page, action: BrowserAction, files: Record<string, Buffer>, deadline: number): Promise<void> {
  const timeout = remaining(deadline);
  if (action.action === 'goto') { await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout }); return; }
  if (action.action === 'wait') {
    if (action.milliseconds > timeout) throw new Error('WEB_CAPTURE_TIMEOUT: wait exceeds the remaining recipe time');
    await page.waitForTimeout(action.milliseconds); return;
  }
  if (action.action === 'wait_for_text') { await page.getByText(action.text, { exact: false }).first().waitFor({ state: 'visible', timeout }); return; }
  const locator = page.locator(action.selector).first();
  if (action.action === 'click') await locator.click({ timeout });
  else if (action.action === 'fill') await locator.fill(action.value, { timeout });
  else if (action.action === 'type') await locator.pressSequentially(action.text, { delay: action.delay_ms ?? 0, timeout });
  else if (action.action === 'press') await locator.press(action.key, { timeout });
  else if (action.action === 'select') await locator.selectOption(action.values, { timeout });
  else if (action.action === 'check') await locator.check({ timeout });
  else if (action.action === 'uncheck') await locator.uncheck({ timeout });
  else if (action.action === 'hover') await locator.hover({ timeout });
  else if (action.action === 'wait_for') await locator.waitFor({ state: action.state ?? 'visible', timeout });
  else if (action.action === 'upload') {
    const bytes = files[action.file]; if (!bytes) throw new Error(`recipe upload was not supplied: ${action.file}`);
    await locator.setInputFiles({ name: action.file.split(/[\\/]/).at(-1) || 'upload', mimeType: 'application/octet-stream', buffer: bytes }, { timeout });
  }
}

const DEVICES = {
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: undefined },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
} as const;

async function contextFor(browser: Browser, recipe: BrowserRecipe, files: Record<string, Buffer>): Promise<BrowserContext> {
  const stateName = recipe.auth?.storage_state;
  let storageState: BrowserContextOptions['storageState'];
  if (stateName) {
    const bytes = files[stateName]; if (!bytes) throw new Error(`storage state was not supplied: ${stateName}`);
    try { storageState = JSON.parse(bytes.toString('utf8')) as BrowserContextOptions['storageState']; } catch { throw new Error('storage state must be valid JSON'); }
  }
  const device = DEVICES[recipe.device ?? 'desktop'];
  return browser.newContext({
    ...device, viewport: recipe.viewport ?? device.viewport, locale: recipe.locale ?? 'en-US', timezoneId: recipe.timezone ?? 'UTC',
    reducedMotion: recipe.settle?.disable_animations === false ? 'no-preference' : 'reduce',
    colorScheme: recipe.theme === 'system' || !recipe.theme ? 'no-preference' : recipe.theme,
    storageState, extraHTTPHeaders: recipe.auth?.headers,
    httpCredentials: recipe.auth?.http_credentials ? { username: recipe.auth.http_credentials.username, password: recipe.auth.http_credentials.password } : undefined,
  });
}

function networkTracker(page: Page): { wait(idleMs: number, deadline: number): Promise<void> } {
  const active = new Set<unknown>(); let lastChange = Date.now();
  const tracked = (request: any) => !['websocket', 'eventsource'].includes(String(request.resourceType?.() ?? ''));
  page.on('request', (request) => { if (tracked(request)) { active.add(request); lastChange = Date.now(); } });
  const complete = (request: unknown) => { if (active.delete(request)) lastChange = Date.now(); };
  page.on('requestfinished', complete); page.on('requestfailed', complete);
  return { wait: async (idleMs, deadline) => {
    while (active.size || Date.now() - lastChange < idleMs) {
      remaining(deadline); await page.waitForTimeout(Math.min(50, remaining(deadline)));
    }
  } };
}

const STABILITY_CSS = `*,*::before,*::after{animation-play-state:paused!important;animation-delay:0s!important;animation-duration:0s!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}`;
const LAYOUT_SNAPSHOT = `JSON.stringify({scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,clientWidth:document.documentElement.clientWidth,clientHeight:document.documentElement.clientHeight,rects:Array.from(document.querySelectorAll('body *')).slice(0,500).map(e=>{const r=e.getBoundingClientRect();return [Math.round(r.x*10)/10,Math.round(r.y*10)/10,Math.round(r.width*10)/10,Math.round(r.height*10)/10]})})`;

async function settlePage(page: Page, recipe: BrowserRecipe, tracker: ReturnType<typeof networkTracker>, deadline: number): Promise<string[]> {
  const options = recipe.settle ?? {}; const diagnostics: string[] = [];
  await page.waitForLoadState('load', { timeout: remaining(deadline) }); diagnostics.push('load=complete');
  await tracker.wait(options.network_idle_ms ?? 500, deadline); diagnostics.push(`network-idle-ms=${options.network_idle_ms ?? 500}`);
  if (options.disable_animations !== false) { await page.addStyleTag({ content: STABILITY_CSS }); diagnostics.push('animations=disabled'); }
  if (options.selector) await page.locator(options.selector).first().waitFor({ state: 'visible', timeout: remaining(deadline) });
  if (options.text) await page.getByText(options.text, { exact: false }).first().waitFor({ state: 'visible', timeout: remaining(deadline) });
  const resourceTimeout = Math.max(1, Math.min(remaining(deadline), 30_000));
  await page.evaluate(async (timeout) => {
    let timer: ReturnType<typeof setTimeout>; const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('font/image readiness timed out')), timeout); });
    const fonts = (document as any).fonts?.ready ?? Promise.resolve();
    const images = Promise.all(Array.from(document.images).map((image) => image.complete ? image.decode().catch(() => undefined) : new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true });
    })));
    try { await Promise.race([Promise.all([fonts, images]), limit]); } finally { clearTimeout(timer!); }
  }, resourceTimeout);
  diagnostics.push('fonts=ready', 'images=ready');
  const stableMs = options.layout_stable_ms ?? 300; let prior = ''; let stableSince = Date.now();
  while (Date.now() - stableSince < stableMs) {
    const snapshot = await page.evaluate(LAYOUT_SNAPSHOT) as string;
    if (snapshot !== prior) { prior = snapshot; stableSince = Date.now(); }
    remaining(deadline); await page.waitForTimeout(Math.min(100, remaining(deadline)));
  }
  diagnostics.push(`layout-stable-ms=${stableMs}`); return diagnostics;
}

async function screenshot(page: Page, recipe: BrowserRecipe): Promise<Buffer> {
  const capture = recipe.capture ?? {}; const mode = capture.mode ?? 'viewport';
  const animations = recipe.settle?.disable_animations === false ? 'allow' : 'disabled';
  if (mode === 'element') return page.locator(capture.selector!).first().screenshot({ type: 'png', animations });
  if (mode === 'full_page') return page.screenshot({ type: 'png', fullPage: true, animations });
  if (mode === 'clip') return page.screenshot({ type: 'png', clip: capture.clip!, animations });
  return page.screenshot({ type: 'png', animations });
}

async function stableScreenshot(page: Page, recipe: BrowserRecipe, deadline: number): Promise<{ bytes: Buffer; attempts: number }> {
  const required = recipe.settle?.matching_frames ?? 2; let matching = 0; let priorHash = ''; let bytes: Buffer = Buffer.alloc(0);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    bytes = await screenshot(page, recipe); const hash = createHash('sha256').update(bytes).digest('hex');
    matching = hash === priorHash ? matching + 1 : 1; priorHash = hash;
    if (matching >= required) return { bytes, attempts: attempt };
    await page.waitForTimeout(Math.min(100, remaining(deadline)));
  }
  throw new Error(`WEB_CAPTURE_UNSTABLE: 10 screenshots did not produce ${required} matching frames`);
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw); url.username = ''; url.password = '';
    for (const key of Array.from(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
    url.hash = '';
    return url.toString();
  } catch { return raw.split(/[?#]/, 1)[0]; }
}

async function semanticEvidence(page: Page): Promise<{ visible_text: { source: 'dom'; text: string }; accessibility: { source: 'dom-accessibility-outline'; nodes: Array<{ role: string; name: string }> } }> {
  const result = await page.evaluate(() => {
    const visible = (element: Element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0; };
    const role = (element: Element) => {
      const explicit = element.getAttribute('role'); if (explicit) return explicit;
      if (element.tagName === 'INPUT') return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' } as Record<string, string>)[(element as HTMLInputElement).type] || 'textbox';
      return ({ A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', NAV: 'navigation', MAIN: 'main' } as Record<string, string>)[element.tagName] || '';
    };
    const nodes = Array.from(document.querySelectorAll('[role],a,button,input,select,textarea,img,h1,h2,h3,nav,main')).filter(visible).slice(0, 500).map((element) => {
      const input = element as HTMLInputElement; const label = input.labels?.[0]?.innerText;
      const name = element.getAttribute('aria-label') || element.getAttribute('alt') || label || (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) ? '' : (element as HTMLElement).innerText) || element.getAttribute('title') || '';
      return { role: role(element), name: String(name).replace(/\s+/g, ' ').trim().slice(0, 500) };
    }).filter((node) => node.role || node.name).slice(0, 200).map((node) => ({ ...node, name: node.name.slice(0, 200) }));
    return { text: document.body?.innerText?.replace(/\s+\n/g, '\n').trim().slice(0, 10_000) || '', nodes };
  });
  return { visible_text: { source: 'dom', text: result.text }, accessibility: { source: 'dom-accessibility-outline', nodes: result.nodes } };
}

export async function captureBrowserRecipe(recipe: BrowserRecipe, files: Record<string, Buffer>, runtime?: Runtime): Promise<BrowserCapture> {
  const executable = browserExecutable(); if (!executable) throw new Error('WEB_CAPTURE_UNAVAILABLE: Chrome or Chromium not found');
  const driver = runtime ?? { launch: async (path: string) => (await import('playwright-core')).chromium.launch({ executablePath: path, headless: true }) };
  const browser = await driver.launch(executable); const timeout = recipe.timeout_ms ?? 30_000; const deadline = Date.now() + timeout;
  try {
    const context = await contextFor(browser, recipe, files);
    try {
      const page = await context.newPage(); const errors: string[] = []; const tracker = networkTracker(page); const started = Date.now();
      const navigationResponses: Array<{ request: any; url: string; status: number }> = []; let status: number | null = null; let networkFailures = 0; let consoleErrors = 0;
      page.on('console', (message) => { if (message.type() === 'error') { consoleErrors += 1; if (errors.length < 100) errors.push('console-error=reported'); } });
      page.on('requestfailed', (request) => { networkFailures += 1; if (errors.length < 100) errors.push(`network-error=${request.failure()?.errorText ?? 'request failed'}`); });
      page.on('response', (response) => {
        const request = response.request(); if (!request.isNavigationRequest() || response.frame() !== page.mainFrame()) return;
        status = response.status(); navigationResponses.push({ request, url: safeUrl(response.url()), status });
      });
      await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout: remaining(deadline) });
      for (const action of recipe.actions ?? []) await perform(page, action, files, deadline);
      const actionsDone = Date.now(); const settled = await settlePage(page, recipe, tracker, deadline); const settleDone = Date.now();
      const shot = await stableScreenshot(page, recipe, deadline); const semantic = await semanticEvidence(page);
      const mode = recipe.capture?.mode ?? 'viewport';
      const viewport = page.viewportSize() ?? recipe.viewport ?? DEVICES[recipe.device ?? 'desktop'].viewport;
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      const comparisonUrl = page.url(); const finalUrl = safeUrl(comparisonUrl);
      const redirects = navigationResponses.filter((entry) => entry.request.redirectedTo()).map(({ url, status: redirectStatus }) => ({ url, status: redirectStatus }));
      return { bytes: shot.bytes, finalUrl, comparisonUrl,
        diagnostics: [`final-url=${finalUrl}`, `status=${status ?? 'unknown'}`, `actions=${recipe.actions?.length ?? 0}`, `device=${recipe.device ?? 'desktop'}`, `capture=${mode}`, ...settled, `matching-frame-attempts=${shot.attempts}`, ...errors],
        evidence: { source: 'browser', final_url: finalUrl, status, redirects,
          timing_ms: { total: Date.now() - started, actions: actionsDone - started, settle: settleDone - actionsDone },
          browser: { engine: 'chromium', version: browser.version() }, dimensions: { width: viewport.width, height: viewport.height, device_scale_factor: dpr, mode },
          console: { error_count: consoleErrors }, network: { failure_count: networkFailures }, ...semantic } };
    } finally { await context.close(); }
  } finally { await browser.close(); }
}
