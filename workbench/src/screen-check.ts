/** Deterministic capture plus isolated visual judgment for `atelier tool screen-check`. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { imageKind, importImageBytes } from './present.ts';
import { captureBrowserRecipe, parseBrowserRecipe, type BrowserCapture } from './screen-check-browser.ts';
import { comparePng, staticEvidence, type StaticEvidence } from './screen-check-evidence.ts';
import { nativeWindowAdapter, stableWindowCapture } from './screen-check-window.ts';

type Verdict = 'PASS' | 'FAIL' | 'INDETERMINATE';
export type VisualVerdict = { verdict: Verdict; summary: string; observations: string[]; visible_text: { source: 'vision'; lines: string[] } };
export type VisualJudge = (input: { expect: string; images: Buffer[]; evidence: Array<BrowserCapture['evidence'] | StaticEvidence>; provider: 'claude' | 'codex' }) => Promise<VisualVerdict>;
type Uploaded = Record<string, Buffer>;
type Capture = { bytes: Buffer; label: string; diagnostics: string[]; evidence: BrowserCapture['evidence'] | StaticEvidence; comparisonUrl?: string };

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'summary', 'observations', 'visible_text'],
  properties: {
    verdict: { enum: ['PASS', 'FAIL', 'INDETERMINATE'] }, summary: { type: 'string', maxLength: 2000 },
    observations: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 1000 } },
    visible_text: { type: 'object', additionalProperties: false, required: ['source', 'lines'], properties: {
      source: { const: 'vision' }, lines: { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 1000 } },
    } },
  },
};

const FALLBACK_JUDGMENT = `You inspect screenshots against one stated expectation. Return only the requested JSON.
Inspect frame, layout, visible text, colour, selection/loading/focus state, overlaps, clipping, and what is missing.
Transcribe readable visible text into visible_text.lines and set visible_text.source to vision.
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
      || !Array.isArray(got.observations) || got.observations.some((item) => typeof item !== 'string')
      || !got.visible_text || typeof got.visible_text !== 'object'
      || (got.visible_text as Record<string, unknown>).source !== 'vision'
      || !Array.isArray((got.visible_text as Record<string, unknown>).lines)
      || ((got.visible_text as Record<string, unknown>).lines as unknown[]).some((item) => typeof item !== 'string')) {
    throw new Error('visual worker returned a malformed verdict');
  }
  return got as VisualVerdict;
}

async function claudeJudge(input: { expect: string; images: Buffer[]; evidence: unknown[] }): Promise<VisualVerdict> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  async function* prompt() {
    yield {
      type: 'user' as const, session_id: '', parent_tool_use_id: null,
      message: { role: 'user' as const, content: [
        ...input.images.map((bytes) => ({ type: 'image' as const, source: {
          type: 'base64' as const, media_type: mime(bytes), data: bytes.toString('base64'),
        } })),
        { type: 'text' as const, text: `Expectation: ${input.expect}\nCapture metadata and semantic evidence: ${JSON.stringify(input.evidence).slice(0, 30_000)}` },
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

function codexJudge(input: { expect: string; images: Buffer[]; evidence: unknown[] }): VisualVerdict {
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
    command.push(`${judgmentInstructions()}\nExpectation: ${input.expect}\nCapture metadata and semantic evidence: ${JSON.stringify(input.evidence).slice(0, 30_000)}`);
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

const OPTIONS = new Set(['--type', '--target', '--window-id', '--before', '--after', '--before-recipe', '--after-recipe', '--expect', '--provider', '--viewport', '--theme', '--recipe', '--stable-ms', '--stable-retries']);

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
  if (action === 'compare') {
    const recipes = Boolean(value(args, '--before-recipe') || value(args, '--after-recipe'));
    if (recipes && (!value(args, '--before-recipe') || !value(args, '--after-recipe'))) throw new Error('compare requires both --before-recipe and --after-recipe');
    if (value(args, '--target') || value(args, '--window-id') || type !== 'image' || (recipes && (value(args, '--before') || value(args, '--after')))) {
      throw new Error('compare accepts either uploaded --before/--after images or a --before-recipe/--after-recipe pair');
    }
  }
  return { action, type, provider: provider as 'claude' | 'codex', expect };
}

function comparisonConfiguration(recipe: ReturnType<typeof parseBrowserRecipe>): { serialized: string; fingerprint: string } {
  const capture = recipe.capture ?? {}; const config = { url: recipe.url, viewport: recipe.viewport ?? null, device: recipe.device ?? 'desktop', locale: recipe.locale ?? 'en-US', timezone: recipe.timezone ?? 'UTC', theme: recipe.theme ?? 'system',
    capture: { mode: capture.mode ?? 'viewport', selector: capture.selector ?? null, clip: capture.clip ?? null } };
  const serialized = JSON.stringify(config); return { serialized, fingerprint: createHash('sha256').update(serialized).digest('hex').slice(0, 16) };
}

async function captureRecipe(name: string, files: Uploaded, label: string): Promise<Capture> {
  const recipe = parseBrowserRecipe(uploaded(name, files, label)); const scoped = { ...files };
  const references = [recipe.auth?.storage_state, ...(recipe.actions ?? []).filter((action) => action.action === 'upload').map((action) => action.file)].filter((item): item is string => Boolean(item));
  for (const reference of references) if (files[`${name}::${reference}`]) scoped[reference] = files[`${name}::${reference}`];
  const result = await captureBrowserRecipe(recipe, scoped);
  return { bytes: result.bytes, label, diagnostics: result.diagnostics, evidence: result.evidence, comparisonUrl: result.comparisonUrl };
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
  return { bytes: result.bytes, label: `Web screen ${result.finalUrl}`, diagnostics: result.diagnostics, evidence: result.evidence };
}

async function windowCapture(id: string | undefined, args: string[]): Promise<Capture> {
  if (!id) throw new Error('--window-id is required');
  const interval = Number(value(args, '--stable-ms') ?? 200); const retries = Number(value(args, '--stable-retries') ?? 5);
  if (!Number.isInteger(interval) || interval < 50 || interval > 5000) throw new Error('--stable-ms must be an integer from 50 through 5000');
  if (!Number.isInteger(retries) || retries < 2 || retries > 20) throw new Error('--stable-retries must be an integer from 2 through 20');
  const result = await stableWindowCapture(id, nativeWindowAdapter(), interval, retries);
  return { bytes: result.bytes, label: `${result.window.owner}: ${result.window.title || id}`, diagnostics: result.diagnostics, evidence: staticEvidence('window', result.bytes) };
}

async function capture(args: string[], files: Uploaded): Promise<Capture> {
  let type = value(args, '--type') ?? 'auto'; const target = value(args, '--target');
  const recipeName = value(args, '--recipe');
  if (recipeName) {
    if (type !== 'auto' && type !== 'web') throw new Error('--recipe requires web capture');
    const recipe = parseBrowserRecipe(uploaded(recipeName, files, '--recipe'));
    const result = await captureBrowserRecipe(recipe, files);
    return { bytes: result.bytes, label: `Web screen ${result.finalUrl}`, diagnostics: result.diagnostics, evidence: result.evidence };
  }
  if (type === 'auto') type = target && /^https?:\/\//.test(target) ? 'web' : target && files[target] ? 'image' : '';
  if (type === 'image') { const bytes = uploaded(target, files, '--target'); return { bytes, label: basename(target!), diagnostics: [], evidence: staticEvidence('image', bytes) }; }
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
  let captures: Capture[]; let pairConfiguration = 'uploaded-pair; pixel alignment verified from decoded dimensions';
  const beforeRecipe = value(args, '--before-recipe'); const afterRecipe = value(args, '--after-recipe');
  if (request.action === 'compare' && beforeRecipe && afterRecipe) {
    const beforeParsed = parseBrowserRecipe(uploaded(beforeRecipe, files, '--before-recipe')); const afterParsed = parseBrowserRecipe(uploaded(afterRecipe, files, '--after-recipe'));
    const beforeConfig = comparisonConfiguration(beforeParsed); const afterConfig = comparisonConfiguration(afterParsed);
    if (beforeConfig.serialized !== afterConfig.serialized) throw new Error('COMPARISON_NOT_ALIGNED: paired recipes must use the same URL, device/viewport, locale, timezone, theme and capture mode');
    captures = [await captureRecipe(beforeRecipe, files, 'Before'), await captureRecipe(afterRecipe, files, 'After')];
    const beforeUrl = captures[0].comparisonUrl; const afterUrl = captures[1].comparisonUrl;
    if (beforeUrl !== afterUrl) throw new Error('COMPARISON_NOT_ALIGNED: paired recipes ended at different URLs');
    pairConfiguration = `paired-browser-recipes; configuration=${beforeConfig.fingerprint}`;
  } else if (request.action === 'compare') captures = [
    (() => { const bytes = uploaded(value(args, '--before'), files, '--before'); return { bytes, label: 'Before', diagnostics: [], evidence: staticEvidence('image', bytes) }; })(),
    (() => { const bytes = uploaded(value(args, '--after'), files, '--after'); return { bytes, label: 'After', diagnostics: [], evidence: staticEvidence('image', bytes) }; })(),
  ]; else captures = [await capture(args, files)];
  const stored = captures.map((item) => ({ asset: importImageBytes(item.bytes, item.label, media), label: item.label, evidence: item.evidence }));
  const base: Record<string, unknown> = { check_id: `check_${stored.map((item) => item.asset.slice(0, 12)).join('_')}`,
    diagnostics: captures.flatMap((item) => item.diagnostics), captures: stored };
  if (request.action === 'compare') {
    const measured = comparePng(captures[0].bytes, captures[1].bytes); const { diff, ...comparison } = measured;
    base.comparison = { ...comparison, capture_configuration: pairConfiguration };
    if (diff) base.diff_asset = importImageBytes(diff, 'Objective pixel difference', media);
  }
  if (request.action === 'capture') return base;
  return { ...base, ...await judge({ expect: request.expect!, images: captures.map((item) => item.bytes), evidence: captures.map((item) => item.evidence), provider: request.provider }) };
}

export const SCREEN_CHECK_SCHEMA = {
  actions: ['windows', 'plan', 'capture', 'check', 'compare'], capture_types: ['auto', 'web', 'window', 'image'],
  providers: ['claude', 'codex'], verdicts: ['PASS', 'FAIL', 'INDETERMINATE'],
  required: { capture: ['target or window-id'], check: ['expect', 'target or window-id'], compare: ['expect', 'before+after or before-recipe+after-recipe'] },
  browser_recipe: { required: ['url'], optional: ['timeout_ms', 'viewport', 'device', 'locale', 'timezone', 'theme', 'auth', 'actions', 'settle', 'capture'],
    auth: ['storage_state', 'headers', 'http_credentials'],
    actions: ['goto', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'upload', 'wait', 'wait_for', 'wait_for_text'],
    devices: ['desktop', 'tablet', 'mobile'], capture_modes: ['viewport', 'full_page', 'element', 'clip'],
    settling: ['load', 'network quiet', 'fonts', 'images', 'selector', 'text', 'animations', 'layout', 'matching frames'],
    limits: { actions: 50, timeout_ms: 120000, wait_ms: 30000, matching_frames: 5 } },
  evidence: { browser: ['final_url', 'status', 'redirects', 'timing_ms', 'browser', 'dimensions', 'console', 'network', 'visible_text:dom', 'accessibility'],
    visual_judgment: ['visible_text:vision'], comparison: ['aligned', 'threshold', 'changed_pixels', 'total_pixels', 'difference_ratio', 'diff_asset', 'capture_configuration'] },
};

export const SCREEN_CHECK_HELP = `atelier tool screen-check windows
atelier tool screen-check plan [--target URL|FILE] [--window-id ID] [--recipe FILE]
atelier tool screen-check capture|check [--type auto|web|window|image] [--target URL|FILE] [--window-id ID] [--recipe FILE]
  [--expect TEXT] [--provider claude|codex] [--viewport WIDTHxHEIGHT] [--theme light|dark|system] [--stable-ms 200] [--stable-retries 5]
atelier tool screen-check compare --before FILE --after FILE --expect TEXT [--provider claude|codex]
atelier tool screen-check compare --before-recipe FILE --after-recipe FILE --expect TEXT [--provider claude|codex]
Use plan when the capture route is unclear and --schema for the complete machine-readable contract.
A browser recipe supports explicit authentication and bounded navigation, click, fill, type, key, selection, check, hover, upload and wait steps.
Every web capture waits for load, network, fonts, images, layout stability and matching frames. Recipes add semantic waits, device presets and viewport, full-page, element or clipped capture.
Window capture always requires an explicit window ID. No mode inherits a personal browser profile or captures a whole display.`;
