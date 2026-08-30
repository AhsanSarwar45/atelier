/** Deterministic capture plus isolated visual judgment for `atelier tool screen-check`. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { imageKind, importImageBytes } from './present.ts';
import { captureBrowserRecipe, parseBrowserRecipe } from './screen-check-browser.ts';
import { nativeWindowAdapter, stableWindowCapture } from './screen-check-window.ts';

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

const OPTIONS = new Set(['--type', '--target', '--window-id', '--before', '--after', '--expect', '--provider', '--viewport', '--theme', '--recipe', '--stable-ms', '--stable-retries']);

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
  if (!['windows', 'plan', 'capture', 'check', 'compare'].includes(action)) throw new Error('usage: atelier tool screen-check windows|plan|capture|check|compare [options]');
  validateArgs(args);
  const type = value(args, '--type') ?? (action === 'compare' ? 'image' : 'auto');
  if (!['auto', 'web', 'window', 'image'].includes(type)) throw new Error('--type must be auto, web, window, or image');
  const provider = value(args, '--provider') ?? 'claude';
  if (!['claude', 'codex'].includes(provider)) throw new Error('--provider must be claude or codex');
  const expect = value(args, '--expect');
  if (['check', 'compare'].includes(action) && !expect) throw new Error('--expect is required');
  const theme = value(args, '--theme');
  if (theme && !['light', 'dark', 'system'].includes(theme)) throw new Error('--theme must be light, dark, or system');
  if (action === 'compare' && (value(args, '--target') || value(args, '--window-id') || type !== 'image')) {
    throw new Error('compare accepts only uploaded --before and --after images');
  }
  return { action, type, provider: provider as 'claude' | 'codex', expect };
}

function capturePlan(args: string[], files: Uploaded): Record<string, unknown> {
  const recipeName = value(args, '--recipe'); const target = value(args, '--target'); const windowId = value(args, '--window-id');
  if (recipeName) {
    const recipe = parseBrowserRecipe(uploaded(recipeName, files, '--recipe'));
    return { recommended_type: 'web-recipe', reason: 'The request includes explicit browser state and actions.',
      next_command: `atelier tool screen-check capture --recipe ${recipeName}`,
      preparation: { authenticated: Boolean(recipe.auth), actions: recipe.actions?.length ?? 0 },
      safeguards: ['fresh browser profile', 'bounded actions only', 'recipe-local files only', 'secrets omitted from diagnostics'] };
  }
  if (windowId) return { recommended_type: 'window', reason: 'An explicit native window ID was supplied.',
    next_command: `atelier tool screen-check capture --type window --window-id ${windowId}`,
    safeguards: ['one explicit window only', 'no whole-display fallback', 'permission failures stop capture'] };
  if (target && /^https?:\/\//.test(target)) return { recommended_type: 'web', reason: 'A direct public URL needs no prepared interaction state.',
    next_command: `atelier tool screen-check capture --type web --target ${target}`,
    upgrade_when: 'Use --recipe FILE when authentication, navigation, clicks, typing, uploads, or application-specific waits are needed.',
    safeguards: ['fresh browser profile', 'no inherited cookies'] };
  if (target && files[target]) return { recommended_type: 'image', reason: 'The target is an explicitly uploaded image.',
    next_command: `atelier tool screen-check capture --type image --target ${target}`,
    safeguards: ['input magic validated', 'content-addressed durable evidence'] };
  return { recommended_type: 'choose', reason: 'No unambiguous capture target was supplied.',
    choices: [
      { use: 'web recipe', when: 'authentication, interaction, state preparation, deterministic waits, element or full-page capture is required' },
      { use: 'web URL', when: 'a public page is already in the exact state to capture' },
      { use: 'window', when: 'a native, simulator, remote-desktop or already-authenticated browser window must be captured' },
      { use: 'image', when: 'another authorized tool already prepared the pixels' },
    ] };
}

function uploaded(path: string | undefined, files: Uploaded, label: string): Buffer {
  if (!path) throw new Error(`${label} is required`);
  const bytes = files[path];
  if (!bytes) throw new Error(`screen-check command did not upload ${path}`);
  return bytes;
}

async function webCapture(url: string, viewport: string, theme: string): Promise<Capture> {
  if (!/^https?:\/\//.test(url)) throw new Error('web target must be an http or https URL');
  const match = /^(\d+)x(\d+)$/.exec(viewport);
  if (!match) throw new Error('--viewport must be WIDTHxHEIGHT');
  const width = Number(match[1]); const height = Number(match[2]);
  if (width < 100 || width > 7680 || height < 100 || height > 4320) throw new Error('--viewport dimensions are out of range');
  const result = await captureBrowserRecipe({ url, viewport: { width, height }, theme: theme as 'light' | 'dark' | 'system' }, {});
  return { bytes: result.bytes, label: `Web screen ${result.finalUrl}`, diagnostics: result.diagnostics };
}

async function windowCapture(id: string | undefined, args: string[]): Promise<Capture> {
  if (!id) throw new Error('--window-id is required');
  const interval = Number(value(args, '--stable-ms') ?? 200); const retries = Number(value(args, '--stable-retries') ?? 5);
  if (!Number.isInteger(interval) || interval < 50 || interval > 5000) throw new Error('--stable-ms must be an integer from 50 through 5000');
  if (!Number.isInteger(retries) || retries < 2 || retries > 20) throw new Error('--stable-retries must be an integer from 2 through 20');
  const result = await stableWindowCapture(id, nativeWindowAdapter(), interval, retries);
  return { bytes: result.bytes, label: `${result.window.owner}: ${result.window.title || id}`, diagnostics: result.diagnostics };
}

async function capture(args: string[], files: Uploaded): Promise<Capture> {
  let type = value(args, '--type') ?? 'auto'; const target = value(args, '--target');
  const recipeName = value(args, '--recipe');
  if (recipeName) {
    if (type !== 'auto' && type !== 'web') throw new Error('--recipe requires web capture');
    const recipe = parseBrowserRecipe(uploaded(recipeName, files, '--recipe'));
    const result = await captureBrowserRecipe(recipe, files);
    return { bytes: result.bytes, label: `Web screen ${result.finalUrl}`, diagnostics: result.diagnostics };
  }
  if (type === 'auto') type = target && /^https?:\/\//.test(target) ? 'web' : target && files[target] ? 'image' : '';
  if (type === 'image') return { bytes: uploaded(target, files, '--target'), label: basename(target!), diagnostics: [] };
  if (type === 'web') return webCapture(target ?? '', value(args, '--viewport') ?? '1280x800', value(args, '--theme') ?? 'system');
  if (type === 'window') return windowCapture(value(args, '--window-id'), args);
  throw new Error('ambiguous target; use --type web, window, or image');
}

export async function screenCheckUploaded(args: string[], files: Uploaded, media: string, judge: VisualJudge = defaultVisualJudge): Promise<Record<string, unknown>> {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { help: SCREEN_CHECK_HELP };
  if (args.length === 1 && args[0] === '--schema') return { schema: SCREEN_CHECK_SCHEMA };
  const request = parsed(args);
  if (request.action === 'windows') return { windows: nativeWindowAdapter().list(), safeguards: ['explicit ID required', 'capture permission is preflighted', 'hidden, minimized, and non-foreground windows are refused', 'two matching frames required', 'no whole-display fallback'] };
  if (request.action === 'plan') return capturePlan(args, files);
  let captures: Capture[];
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
  actions: ['windows', 'plan', 'capture', 'check', 'compare'], capture_types: ['auto', 'web', 'window', 'image'],
  providers: ['claude', 'codex'], verdicts: ['PASS', 'FAIL', 'INDETERMINATE'],
  required: { capture: ['target or window-id'], check: ['expect', 'target or window-id'], compare: ['expect', 'before', 'after'] },
  browser_recipe: { required: ['url'], optional: ['timeout_ms', 'viewport', 'device', 'locale', 'timezone', 'theme', 'auth', 'actions', 'settle', 'capture'],
    auth: ['storage_state', 'headers', 'http_credentials'],
    actions: ['goto', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'upload', 'wait', 'wait_for', 'wait_for_text'],
    devices: ['desktop', 'tablet', 'mobile'], capture_modes: ['viewport', 'full_page', 'element', 'clip'],
    settling: ['load', 'network quiet', 'fonts', 'images', 'selector', 'text', 'animations', 'layout', 'matching frames'],
    limits: { actions: 50, timeout_ms: 120000, wait_ms: 30000, matching_frames: 5 } },
};

export const SCREEN_CHECK_HELP = `atelier tool screen-check windows
atelier tool screen-check plan [--target URL|FILE] [--window-id ID] [--recipe FILE]
atelier tool screen-check capture|check [--type auto|web|window|image] [--target URL|FILE] [--window-id ID] [--recipe FILE]
  [--expect TEXT] [--provider claude|codex] [--viewport WIDTHxHEIGHT] [--theme light|dark|system] [--stable-ms 200] [--stable-retries 5]
atelier tool screen-check compare --before FILE --after FILE --expect TEXT [--provider claude|codex]
Use plan when the capture route is unclear and --schema for the complete machine-readable contract.
A browser recipe supports explicit authentication and bounded navigation, click, fill, type, key, selection, check, hover, upload and wait steps.
Every web capture waits for load, network, fonts, images, layout stability and matching frames. Recipes add semantic waits, device presets and viewport, full-page, element or clipped capture.
Window capture always requires an explicit window ID. No mode inherits a personal browser profile or captures a whole display.`;
