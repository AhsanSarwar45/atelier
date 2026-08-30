#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

export function imageKind(bytes: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

type ReadPresentationFile = (path: string) => Buffer;

function importImage(path: string, read: ReadPresentationFile, directory: string): string {
  return importImageBytes(read(path), path, directory);
}

export function importImageBytes(bytes: Buffer, label: string, directory: string): string {
  if (bytes.length > 25 * 1024 * 1024) throw new Error(`${label} is larger than 25 MiB`);
  const kind = imageKind(bytes);
  if (!kind) throw new Error(`${label} is not a PNG, JPEG, GIF, or WebP image`);
  mkdirSync(directory, { recursive: true });
  const asset = `${createHash('sha256').update(bytes).digest('hex')}.${kind}`;
  try { writeFileSync(join(directory, asset), bytes, { flag: 'wx' }); } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return asset;
}

const ASSET = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

function existingImage(asset: string, directory: string): string {
  const match = ASSET.exec(asset);
  if (!match) throw new Error('--asset must name a stored PNG, JPEG, GIF, or WebP');
  const path = join(directory, asset);
  if (!existsSync(path)) throw new Error(`presentation asset does not exist: ${asset}`);
  const bytes = readFileSync(path);
  const kind = imageKind(bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (kind !== match[1] || `${digest}.${kind}` !== asset) throw new Error(`presentation asset failed content validation: ${asset}`);
  return asset;
}

function imageAsset(args: string[], fileFlag: string, assetFlag: string, read: ReadPresentationFile, directory: string): string {
  const file = option(args, fileFlag);
  const asset = option(args, assetFlag);
  if (Boolean(file) === Boolean(asset)) throw new Error(`provide exactly one of ${fileFlag} or ${assetFlag}`);
  return asset ? existingImage(asset, directory) : importImage(file!, read, directory);
}

function importArtifact(path: string, read: ReadPresentationFile, directory: string): { asset: string; title: string; kind: string } {
  const bytes = read(path);
  if (bytes.length > 1024 * 1024) throw new Error(`${path} is larger than 1 MiB`);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  const artifact = visualArtifact(value); const canonical = canonicalArtifact(value);
  if (!artifact || !canonical) throw new Error('Invalid visual artifact');
  mkdirSync(directory, { recursive: true });
  const asset = `${createHash('sha256').update(canonical).digest('hex')}.artifact.json`;
  try { writeFileSync(join(directory, asset), canonical, { flag: 'wx' }); } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return { asset, title: artifact.title, kind: artifact.kind };
}

const block = (value: unknown) => `\`\`\`atelier-widget\n${JSON.stringify(value)}\n\`\`\`\n`;

function rendered(args: string[], stdin: string, read: ReadPresentationFile, directory: string): string {
  if (args[0] === 'widget') {
    const file = inputFile(args);
    const source = file ? read(file).toString('utf8') : stdin;
    if (!source.trim()) throw new Error('Widget input required on stdin or with --input');
    let value: unknown;
    try { value = JSON.parse(source); } catch (error) {
      throw new Error(`widget input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const rendered = widgetBlock(value);
    if (!rendered) throw new Error('Invalid widget input');
    return `${rendered}\n`;
  }
  if (args[0] === 'image') {
    validateOptions(args, ['--file', '--asset', '--alt', '--caption']);
    const asset = imageAsset(args, '--file', '--asset', read, directory);
    const alt = option(args, '--alt', true)!;
    const caption = option(args, '--caption');
    return block({ type: 'image', asset, alt, ...(caption ? { caption } : {}) });
  }
  if (args[0] === 'compare') {
    validateOptions(args, ['--before', '--before-asset', '--after', '--after-asset', '--before-alt', '--after-alt', '--mode']);
    const before = imageAsset(args, '--before', '--before-asset', read, directory);
    const after = imageAsset(args, '--after', '--after-asset', read, directory);
    const beforeAlt = option(args, '--before-alt', true)!;
    const afterAlt = option(args, '--after-alt', true)!;
    const mode = option(args, '--mode') ?? 'side_by_side';
    if (!['side_by_side', 'wipe'].includes(mode)) throw new Error('--mode must be side_by_side or wipe');
    return block({ type: 'image_compare', mode, before: { asset: before, alt: beforeAlt }, after: { asset: after, alt: afterAlt } });
  }
  if (args[0] === 'artifact') {
    validateOptions(args, ['--file']);
    return block({ type: 'artifact', ...importArtifact(option(args, '--file', true)!, read, directory) });
  }
  throw new Error('usage: atelier tool present widget|image|compare|artifact');
}

export function present(args: string[], stdin = ''): string {
  const directory = process.env.ATELIER_PRESENTATION_MEDIA_DIR;
  if (!directory && args[0] !== 'widget') throw new Error('Atelier did not provide its presentation media directory');
  return rendered(args, stdin, readFileSync, directory ?? '');
}

/** Run a presentation request inside Atelier from files uploaded by its command. */
export function presentUploaded(args: string[], stdin: string, files: Record<string, Buffer>, directory: string): string {
  return rendered(args, stdin, (path) => {
    const bytes = files[path];
    if (!bytes) throw new Error(`the presentation command did not upload ${path}`);
    return bytes;
  }, directory);
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
