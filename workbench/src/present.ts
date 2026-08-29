#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { widgetBlock } from '../../src/workbench/chat-widgets.ts';
import { canonicalArtifact, visualArtifact } from '../../src/workbench/visual-artifacts.ts';

function inputFile(args: string[]): string | null {
  const at = args.indexOf('--input');
  if (at < 0) return null;
  const path = args[at + 1];
  if (!path || args.length !== 3) throw new Error('usage: atelier tool present widget [--input FILE]');
  return path;
}

function option(args: string[], name: string, required = false): string | undefined {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  if (required && !value) throw new Error(`${name} is required`);
  return value;
}

function validateOptions(args: string[], allowed: string[]): void {
  if ((args.length - 1) % 2 !== 0) throw new Error(`missing value for ${args.at(-1)}`);
  const seen = new Set<string>();
  for (let at = 1; at < args.length; at += 2) {
    const name = args[at];
    const value = args[at + 1];
    if (!allowed.includes(name)) throw new Error(`unknown option: ${name}`);
    if (seen.has(name)) throw new Error(`duplicate option: ${name}`);
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${name}`);
    seen.add(name);
  }
}

function imageKind(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function importImage(path: string): string {
  const bytes = readFileSync(path);
  if (bytes.length > 25 * 1024 * 1024) throw new Error(`${path} is larger than 25 MiB`);
  const kind = imageKind(bytes);
  if (!kind) throw new Error(`${path} is not a PNG, JPEG, GIF, or WebP image`);
  const directory = process.env.ATELIER_PRESENTATION_MEDIA_DIR;
  if (!directory) throw new Error('Atelier did not provide its presentation media directory');
  mkdirSync(directory, { recursive: true });
  const asset = `${createHash('sha256').update(bytes).digest('hex')}.${kind}`;
  try { writeFileSync(join(directory, asset), bytes, { flag: 'wx' }); } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return asset;
}

function importArtifact(path: string): { asset: string; title: string; kind: string } {
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new Error(`${path} is larger than 1 MiB`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const artifact = visualArtifact(value); const canonical = canonicalArtifact(value);
  if (!artifact || !canonical) throw new Error('artifact does not match Atelier’s visual artifact contract or contains unknown fields');
  const directory = process.env.ATELIER_PRESENTATION_MEDIA_DIR;
  if (!directory) throw new Error('Atelier did not provide its presentation media directory');
  mkdirSync(directory, { recursive: true });
  const asset = `${createHash('sha256').update(canonical).digest('hex')}.artifact.json`;
  try { writeFileSync(join(directory, asset), canonical, { flag: 'wx' }); } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return { asset, title: artifact.title, kind: artifact.kind };
}

const block = (value: unknown) => `\`\`\`atelier-widget\n${JSON.stringify(value)}\n\`\`\`\n`;

export function present(args: string[], stdin = ''): string {
  if (args[0] === 'widget') {
    const file = inputFile(args);
    const source = file ? readFileSync(file, 'utf8') : stdin;
    if (!source.trim()) throw new Error('widget input is empty; pass one object on stdin or with --input FILE');
    let value: unknown;
    try { value = JSON.parse(source); } catch (error) {
      throw new Error(`widget input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rendered = widgetBlock(value);
    if (!rendered) throw new Error('widget input does not match Atelier’s contract or contains unknown fields');
    return `${rendered}\n`;
  }
  if (args[0] === 'image') {
    validateOptions(args, ['--file', '--alt', '--caption']);
    const asset = importImage(option(args, '--file', true)!);
    const alt = option(args, '--alt', true)!;
    const caption = option(args, '--caption');
    return block({ type: 'image', asset, alt, ...(caption ? { caption } : {}) });
  }
  if (args[0] === 'compare') {
    validateOptions(args, ['--before', '--after', '--before-alt', '--after-alt', '--mode']);
    const before = importImage(option(args, '--before', true)!);
    const after = importImage(option(args, '--after', true)!);
    const beforeAlt = option(args, '--before-alt', true)!;
    const afterAlt = option(args, '--after-alt', true)!;
    const mode = option(args, '--mode') ?? 'side_by_side';
    if (!['side_by_side', 'wipe'].includes(mode)) throw new Error('--mode must be side_by_side or wipe');
    return block({ type: 'image_compare', mode, before: { asset: before, alt: beforeAlt }, after: { asset: after, alt: afterAlt } });
  }
  if (args[0] === 'artifact') {
    validateOptions(args, ['--file']);
    return block({ type: 'artifact', ...importArtifact(option(args, '--file', true)!) });
  }
  throw new Error('usage: atelier tool present widget|image|compare|artifact');
}

export function main(args = process.argv.slice(2)): number {
  try {
    process.stdout.write(present(args, readFileSync(0, 'utf8')));
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
