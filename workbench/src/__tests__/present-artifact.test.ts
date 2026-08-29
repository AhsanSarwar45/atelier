/** @vitest-environment node */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { widgetSpecs } from '../../../src/workbench/chat-widgets';
import { present } from '../present';

describe('artifact presenter', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atelier-artifact-')); process.env.ATELIER_PRESENTATION_MEDIA_DIR = join(root, 'media'); });
  afterEach(() => { delete process.env.ATELIER_PRESENTATION_MEDIA_DIR; rmSync(root, { recursive: true, force: true }); });

  it('validates, canonicalizes, stores, and emits one durable artifact widget', () => {
    const file = join(root, 'diagram.json');
    writeFileSync(file, JSON.stringify({ source: 'flowchart LR\nA-->B', title: 'System', kind: 'mermaid', version: 1 }));
    const output = present(['artifact', '--file', file]);
    const [widget] = widgetSpecs(output);
    expect(widget).toEqual(expect.objectContaining({ type: 'artifact', kind: 'mermaid', title: 'System' }));
    const [asset] = readdirSync(join(root, 'media'));
    expect(asset).toMatch(/^[a-f0-9]{64}\.artifact\.json$/);
    expect(readFileSync(join(root, 'media', asset!), 'utf8')).toBe('{"kind":"mermaid","source":"flowchart LR\\nA-->B","title":"System","version":1}\n');
  });

  it('refuses invalid and unknown artifact input', () => {
    const file = join(root, 'bad.json');
    writeFileSync(file, JSON.stringify({ version: 1, kind: 'mermaid', title: 'Bad', source: 'x', script: 'alert(1)' }));
    expect(() => present(['artifact', '--file', file])).toThrow('does not match');
    expect(() => present(['artifact', '--file', file, '--extra', 'x'])).toThrow('unknown option');
  });
});
