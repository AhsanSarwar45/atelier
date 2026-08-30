import { execFileSync } from 'node:child_process';
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
  theme?: 'light' | 'dark' | 'system';
  auth?: {
    storage_state?: string;
    headers?: Record<string, string>;
    http_credentials?: { username: string; password: string };
  };
  actions?: BrowserAction[];
};

export type BrowserCapture = {
  bytes: Buffer;
  diagnostics: string[];
  finalUrl: string;
};

type Runtime = {
  launch(executablePath: string): Promise<Browser>;
};

const ALLOWED_RECIPE = new Set(['url', 'timeout_ms', 'viewport', 'theme', 'auth', 'actions']);
const ALLOWED_AUTH = new Set(['storage_state', 'headers', 'http_credentials']);
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

export function parseBrowserRecipe(bytes: Buffer): BrowserRecipe {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('browser recipe must be valid JSON'); }
  const recipe = object(parsed, 'browser recipe'); exact(recipe, ALLOWED_RECIPE, 'browser recipe');
  httpUrl(recipe.url, 'url');
  if (recipe.timeout_ms !== undefined && (!Number.isInteger(recipe.timeout_ms) || Number(recipe.timeout_ms) < 100 || Number(recipe.timeout_ms) > 120_000)) {
    throw new Error('timeout_ms must be an integer from 100 through 120000');
  }
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

async function perform(page: Page, action: BrowserAction, files: Record<string, Buffer>, timeout: number): Promise<void> {
  if (action.action === 'goto') { await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout }); return; }
  if (action.action === 'wait') { await page.waitForTimeout(action.milliseconds); return; }
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

async function contextFor(browser: Browser, recipe: BrowserRecipe, files: Record<string, Buffer>): Promise<BrowserContext> {
  const stateName = recipe.auth?.storage_state;
  let storageState: BrowserContextOptions['storageState'];
  if (stateName) {
    const bytes = files[stateName]; if (!bytes) throw new Error(`storage state was not supplied: ${stateName}`);
    try { storageState = JSON.parse(bytes.toString('utf8')) as BrowserContextOptions['storageState']; } catch { throw new Error('storage state must be valid JSON'); }
  }
  return browser.newContext({
    viewport: recipe.viewport ?? { width: 1280, height: 800 }, colorScheme: recipe.theme === 'system' || !recipe.theme ? 'no-preference' : recipe.theme,
    storageState, extraHTTPHeaders: recipe.auth?.headers,
    httpCredentials: recipe.auth?.http_credentials ? { username: recipe.auth.http_credentials.username, password: recipe.auth.http_credentials.password } : undefined,
  });
}

export async function captureBrowserRecipe(recipe: BrowserRecipe, files: Record<string, Buffer>, runtime?: Runtime): Promise<BrowserCapture> {
  const executable = browserExecutable(); if (!executable) throw new Error('WEB_CAPTURE_UNAVAILABLE: Chrome or Chromium not found');
  const driver = runtime ?? { launch: async (path: string) => (await import('playwright-core')).chromium.launch({ executablePath: path, headless: true }) };
  const browser = await driver.launch(executable); const timeout = recipe.timeout_ms ?? 30_000;
  try {
    const context = await contextFor(browser, recipe, files);
    try {
      const page = await context.newPage(); const errors: string[] = [];
      page.on('console', (message) => { if (message.type() === 'error') errors.push(`console-error=${message.text().slice(0, 500)}`); });
      page.on('requestfailed', (request) => errors.push(`network-error=${request.failure()?.errorText ?? 'request failed'}`));
      await page.goto(recipe.url, { waitUntil: 'domcontentloaded', timeout });
      for (const action of recipe.actions ?? []) await perform(page, action, files, timeout);
      return { bytes: await page.screenshot({ type: 'png' }), finalUrl: page.url(),
        diagnostics: [`final-url=${page.url()}`, `actions=${recipe.actions?.length ?? 0}`, ...errors] };
    } finally { await context.close(); }
  } finally { await browser.close(); }
}
