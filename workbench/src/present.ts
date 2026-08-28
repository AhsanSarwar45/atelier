#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { widgetBlock } from '../../src/workbench/chat-widgets.ts';

function inputFile(args: string[]): string | null {
  const at = args.indexOf('--input');
  if (at < 0) return null;
  const path = args[at + 1];
  if (!path || args.length !== 3) throw new Error('usage: atelier tool present widget [--input FILE]');
  return path;
}

export function present(args: string[], stdin = ''): string {
  if (args[0] !== 'widget') throw new Error('usage: atelier tool present widget [--input FILE]');
  const file = inputFile(args);
  const source = file ? readFileSync(file, 'utf8') : stdin;
  if (!source.trim()) throw new Error('widget input is empty; pass one object on stdin or with --input FILE');
  let value: unknown;
  try { value = JSON.parse(source); } catch (error) {
    throw new Error(`widget input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const block = widgetBlock(value);
  if (!block) throw new Error('widget input does not match Atelier’s contract or contains unknown fields');
  return `${block}\n`;
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
