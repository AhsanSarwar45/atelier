/** Deterministic capture plus isolated visual judgment for `atelier tool screen-check`. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { imageKind, importImageBytes } from './present.ts';

type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export type VisualVerdict = { verdict: Verdict; summary: string; observations: string[] };
export type VisualJudge = (input: { expect: string; images: Buffer[]; provider: 'claude' | 'codex' }) => Promise<VisualVerdict>;
type Uploaded = Record<string, Buffer>;
type Capture = { bytes: Buffer; label: string; diagnostics: string[] };

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'observations'],
  properties: {
    verdict: { enum: ['PASS', 'FAIL', 'INDETERMINATE'] }, summary: { type: 'string' },
    observations: { type: 'array', items: { type: 'string' } },
  },
};

const FALLBACK_JUDGMENT = `You inspect screenshots against one stated expectation. Return only the requested JSON.
Inspect frame, layout, visible text, colour, selection/loading/focus state, overlaps, clipping, and what is missing.
PASS only when the expectation is visibly satisfied and no visible regression contradicts it.
FAIL only for a visible contradiction. Use INDETERMINATE when the pixels cannot settle the claim. Never guess.`;

function judgmentInstructions(): string {
  const rules = process.env.ATELIER_RULES_DIR;
  const candidates = [
    rules ? join(rules, 'machinery', 'workers', 'screen-check.md') : '',
    join(process.cwd(), 'machinery', 'workers', 'screen-check.md'),
  ];
  for (const path of candidates) {
    if (path && existsSync(path)) return readFileSync(path, 'utf8');
  }
  return FALLBACK_JUDGMENT;
}

function mime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const kind = imageKind(bytes);
  if (!kind) throw new Error('visual evidence is not a PNG, JPEG, GIF, or WebP image');
  return kind === 'jpg' ? 'image/jpeg' : `image/${kind}`;
}

function parseResult(value: unknown): VisualVerdict {
  if (!value || typeof value !== 'object') throw new Error('visual worker returned no verdict object');
  const got = value as Record<string, unknown>;
  if (!['PASS', 'FAIL', 'INDETERMINATE'].includes(String(got.verdict))
      || typeof got.summary !== 'string'
      || !Array.isArray(got.observations) || got.observations.some((item) => typeof item !== 'string')) {
    throw new Error('visual worker returned a malformed verdict');
  }
  return got as VisualVerdict;
}

async function claudeJudge(input: { expect: string; images: Buffer[] }): Promise<VisualVerdict> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  async function* prompt() {
    yield {
      type: 'user' as const, session_id: '', parent_tool_use_id: null,
      message: { role: 'user' as const, content: [
        ...input.images.map((bytes) => ({ type: 'image' as const, source: {
          type: 'base64' as const, media_type: mime(bytes), data: bytes.toString('base64'),
        } })),
        { type: 'text' as const, text: `Expectation: ${input.expect}` },
      ] },
    };
  }
  for await (const message of query({ prompt: prompt(), options: {
    model: 'sonnet', effort: 'high', maxTurns: 1, tools: [], permissionMode: 'dontAsk',
    settingSources: [], strictMcpConfig: true, persistSession: false,
    systemPrompt: judgmentInstructions(), outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
  } })) {
    if (message.type === 'result') {
      if (message.subtype !== 'success') throw new Error(`visual worker failed: ${message.subtype}`);
      return parseResult(message.structured_output ?? JSON.parse(message.result));
    }
  }
  throw new Error('visual worker ended without a result');
}

function codexJudge(input: { expect: string; images: Buffer[] }): VisualVerdict {
  const root = mkdtempSync(join(tmpdir(), 'atelier-screen-judge-'));
  try {
    const schema = join(root, 'schema.json'); const output = join(root, 'result.json');
    writeFileSync(schema, JSON.stringify(RESULT_SCHEMA));
    const paths = input.images.map((bytes, at) => {
      const kind = imageKind(bytes);
      if (!kind) throw new Error('visual evidence is not a PNG, JPEG, GIF, or WebP image');
      const path = join(root, `capture-${at}.${kind}`); writeFileSync(path, bytes); return path;
    });
    const command = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--output-schema', schema, '--output-last-message', output];
    for (const path of paths) command.push('--image', path);
    command.push(`${judgmentInstructions()}\nExpectation: ${input.expect}`);
    const run = spawnSync(process.env.CODEX_PATH || 'codex', command, { encoding: 'utf8', timeout: 600_000 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Codex visual worker failed (${run.status}): ${(run.stderr || '').trim()}`);
    return parseResult(JSON.parse(readFileSync(output, 'utf8')));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

export const defaultVisualJudge: VisualJudge = async (input) => input.provider === 'codex'
  ? codexJudge(input) : claudeJudge(input);

function value(args: string[], name: string): string | undefined {
  const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1];
}

const OPTIONS = new Set(['--type', '--target', '--window-id', '--before', '--after', '--expect', '--provider', '--viewport', '--theme']);

function validateArgs(args: string[]): void {
  const seen = new Set<string>();
  for (let at = 1; at < args.length; at += 2) {
    const name = args[at]; const next = args[at + 1];
    if (!OPTIONS.has(name)) throw new Error(`unknown option: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    if (!next || next.startsWith('--')) throw new Error(`missing value for ${name}`);
    seen.add(name);
  }
  if ((args.length - 1) % 2 !== 0) throw new Error(`missing value for ${args.at(-1)}`);
}

function parsed(args: string[]): { action: string; type: string; provider: 'claude' | 'codex'; expect?: string } {
  const action = args[0] ?? '';
  if (!['capture', 'check', 'compare'].includes(action)) throw new Error('usage: atelier tool screen-check capture|check|compare [options]');
  validateArgs(args);
  const type = value(args, '--type') ?? (action === 'compare' ? 'image' : 'auto');
  if (!['auto', 'web', 'window', 'image'].includes(type)) throw new Error('--type must be auto, web, window, or image');
  const provider = value(args, '--provider') ?? 'claude';
  if (!['claude', 'codex'].includes(provider)) throw new Error('--provider must be claude or codex');
  const expect = value(args, '--expect');
  if (action !== 'capture' && !expect) throw new Error('--expect is required');
  const theme = value(args, '--theme');
  if (theme && !['light', 'dark', 'system'].includes(theme)) throw new Error('--theme must be light, dark, or system');
  if (action === 'compare' && (value(args, '--target') || value(args, '--window-id') || type !== 'image')) {
    throw new Error('compare accepts only uploaded --before and --after images');
  }
  return { action, type, provider: provider as 'claude' | 'codex', expect };
}

function uploaded(path: string | undefined, files: Uploaded, label: string): Buffer {
  if (!path) throw new Error(`${label} is required`);
  const bytes = files[path];
  if (!bytes) throw new Error(`screen-check command did not upload ${path}`);
  return bytes;
}

function executable(names: string[]): string | null {
  for (const name of names) {
    if (isAbsolute(name) && existsSync(name)) return name;
    try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] || null; }
    catch { /* try the next browser */ }
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('could not allocate a browser port'));
      const port = address.port; server.close(() => resolvePort(port));
    });
  });
}

async function webCapture(url: string, viewport: string, theme: string): Promise<Capture> {
  if (!/^https?:\/\//.test(url)) throw new Error('web target must be an http or https URL');
  const browser = executable(process.platform === 'darwin'
    ? ['google-chrome', 'chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? ['chrome.exe', 'msedge.exe'] : ['google-chrome', 'chromium', 'chromium-browser']);
  if (!browser || !existsSync(browser)) throw new Error('WEB_CAPTURE_UNAVAILABLE: no supported Chrome or Chromium executable was found');
  const match = /^(\d+)x(\d+)$/.exec(viewport);
  if (!match) throw new Error('--viewport must be WIDTHxHEIGHT');
  const port = await freePort(); const profile = mkdtempSync(join(tmpdir(), 'atelier-screen-web-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*', `--user-data-dir=${profile}`, `--window-size=${match[1]},${match[2]}`, 'about:blank'],
  { stdio: 'ignore' });
  try {
    let tabs: any[] | null = null;
    for (let n = 0; n < 60 && !tabs; n += 1) {
      try { tabs = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()) as any[]; }
      catch { await new Promise((resolveWait) => setTimeout(resolveWait, 100)); }
    }
    if (!tabs) throw new Error('WEB_CAPTURE_UNAVAILABLE: browser did not expose its debugging endpoint');
    const endpoint = tabs.find((tab) => tab.type === 'page')?.webSocketDebuggerUrl;
    if (!endpoint) throw new Error('WEB_CAPTURE_UNAVAILABLE: browser exposed no page');
    const Socket = (globalThis as any).WebSocket;
    if (!Socket) throw new Error('WEB_CAPTURE_UNAVAILABLE: this Node runtime has no WebSocket client');
    const ws = new Socket(endpoint); let next = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const diagnostics: string[] = [];
    await new Promise<void>((resolveOpen, reject) => { ws.onopen = () => resolveOpen(); ws.onerror = reject; });
    ws.onmessage = (event: any) => {
      const message = JSON.parse(String(event.data)); const waiting = pending.get(message.id);
      if (waiting) {
        clearTimeout(waiting.timer); pending.delete(message.id);
        if (message.error) waiting.reject(new Error(`browser ${message.error.message ?? 'command failed'}`));
        else waiting.resolve(message.result ?? {});
      } else if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
        diagnostics.push(`console-error=${String(message.params.entry.text).slice(0, 500)}`);
      } else if (message.method === 'Network.loadingFailed') {
        diagnostics.push(`network-error=${String(message.params?.errorText ?? 'request failed').slice(0, 500)}`);
      }
    };
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolveReply, rejectReply) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); rejectReply(new Error(`browser timed out during ${method}`)); }, 10_000);
      pending.set(id, { resolve: resolveReply, reject: rejectReply, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: Number(match[1]), height: Number(match[2]), deviceScaleFactor: 1, mobile: false });
    if (theme !== 'system') await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    await send('Page.navigate', { url });
    let readyState = 'unknown';
    for (let n = 0; n < 50; n += 1) {
      const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      readyState = String(state?.result?.value ?? 'unknown');
      if (readyState === 'complete') break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    ws.close();
    return { bytes: Buffer.from(shot.data, 'base64'), label: `Web screen ${url}`,
      diagnostics: [`viewport=${viewport}`, `theme=${theme}`, `readyState=${readyState}`, ...diagnostics] };
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(resolveExit, 2_000);
        child.once('exit', () => { clearTimeout(timer); resolveExit(); });
      });
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function windowCapture(id: string | undefined): Capture {
  if (!id) throw new Error('--window-id is required; full-desktop capture is never implicit');
  const out = join(mkdtempSync(join(tmpdir(), 'atelier-screen-window-')), 'window.png');
  try {
    let run;
    if (process.platform === 'darwin') run = spawnSync('screencapture', ['-x', '-l', id, out]);
    else if (process.platform === 'linux') run = spawnSync('import', ['-window', id, out]);
    else throw new Error('WINDOW_CAPTURE_UNAVAILABLE: this platform has no Atelier window adapter');
    if (run.error || run.status !== 0) throw new Error('CAPTURE_PERMISSION_REQUIRED: the named window could not be captured');
    return { bytes: readFileSync(out), label: `Window ${id}`, diagnostics: [`window=${id}`] };
  } finally { rmSync(dirname(out), { recursive: true, force: true }); }
}

async function capture(args: string[], files: Uploaded): Promise<Capture> {
  let type = value(args, '--type') ?? 'auto'; const target = value(args, '--target');
  if (type === 'auto') type = target && /^https?:\/\//.test(target) ? 'web' : target && files[target] ? 'image' : '';
  if (type === 'image') return { bytes: uploaded(target, files, '--target'), label: basename(target!), diagnostics: [] };
  if (type === 'web') return webCapture(target ?? '', value(args, '--viewport') ?? '1280x800', value(args, '--theme') ?? 'system');
  if (type === 'window') return windowCapture(value(args, '--window-id'));
  throw new Error('screen target is ambiguous; pass --type web, window, or image');
}

export async function screenCheckUploaded(args: string[], files: Uploaded, media: string, judge: VisualJudge = defaultVisualJudge): Promise<Record<string, unknown>> {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { help: SCREEN_CHECK_HELP };
  if (args.length === 1 && args[0] === '--schema') return { schema: SCREEN_CHECK_SCHEMA };
  const request = parsed(args); let captures: Capture[];
  if (request.action === 'compare') captures = [
    { bytes: uploaded(value(args, '--before'), files, '--before'), label: 'Before', diagnostics: [] },
    { bytes: uploaded(value(args, '--after'), files, '--after'), label: 'After', diagnostics: [] },
  ]; else captures = [await capture(args, files)];
  const evidence = captures.map((item) => ({ asset: importImageBytes(item.bytes, item.label, media), label: item.label }));
  const base = { check_id: `check_${evidence.map((item) => item.asset.slice(0, 12)).join('_')}`,
    diagnostics: captures.flatMap((item) => item.diagnostics), captures: evidence };
  if (request.action === 'capture') return base;
  return { ...base, ...await judge({ expect: request.expect!, images: captures.map((item) => item.bytes), provider: request.provider }) };
}

export const SCREEN_CHECK_SCHEMA = {
  actions: ['capture', 'check', 'compare'], capture_types: ['auto', 'web', 'window', 'image'],
  providers: ['claude', 'codex'], verdicts: ['PASS', 'FAIL', 'INDETERMINATE'],
  required: { capture: ['target or window-id'], check: ['expect', 'target or window-id'], compare: ['expect', 'before', 'after'] },
};

export const SCREEN_CHECK_HELP = `atelier tool screen-check capture|check [--type auto|web|window|image] [--target URL|FILE] [--window-id ID]
  [--expect TEXT] [--provider claude|codex] [--viewport WIDTHxHEIGHT] [--theme light|dark|system]
atelier tool screen-check compare --before FILE --after FILE --expect TEXT [--provider claude|codex]
Use --schema for the machine-readable contract. Window capture always requires an explicit window ID.`;
