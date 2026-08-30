/** @vitest-environment node */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { screenCheckUploaded, type VisualJudge } from '../screen-check';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('screen-check', () => {
  let root: string;
  let media: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'atelier-screen-check-')); media = join(root, 'media'); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('captures an uploaded image into content-addressed evidence without invoking a model', async () => {
    const judge = vi.fn<VisualJudge>();
    const result = await screenCheckUploaded(
      ['capture', '--type', 'image', '--target', '/private/temporary.png'],
      { '/private/temporary.png': PNG }, media, judge,
    );
    const capture = (result.captures as Array<{ asset: string; label: string }>)[0];
    expect(capture.label).toBe('temporary.png');
    expect(existsSync(join(media, capture.asset))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PNG.toString('base64'));
    expect(JSON.stringify(result)).not.toContain('/private/');
    expect(judge).not.toHaveBeenCalled();
  });

  it('returns the isolated visual worker verdict and forwards provider choice', async () => {
    const judge = vi.fn<VisualJudge>().mockResolvedValue({ verdict: 'PASS', summary: 'Visible.', observations: ['Button is shown.'], visible_text: { source: 'vision', lines: ['Save'] } });
    const result = await screenCheckUploaded(
      ['check', '--type', 'image', '--target', 'screen.png', '--expect', 'Save is visible', '--provider', 'codex'],
      { 'screen.png': PNG }, media, judge,
    );
    expect(result).toEqual(expect.objectContaining({ verdict: 'PASS', summary: 'Visible.' }));
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ expect: 'Save is visible', provider: 'codex', images: [PNG] }));
  });

  it('compares before and after in stable order', async () => {
    const after = Buffer.concat([PNG, Buffer.from([4])]);
    const judge = vi.fn<VisualJudge>().mockResolvedValue({ verdict: 'FAIL', summary: 'Clipped.', observations: [], visible_text: { source: 'vision', lines: [] } });
    const result = await screenCheckUploaded(
      ['compare', '--before', 'before.png', '--after', 'after.png', '--expect', 'No clipping'],
      { 'before.png': PNG, 'after.png': after }, media, judge,
    );
    expect(result.verdict).toBe('FAIL');
    expect((result.captures as unknown[])).toHaveLength(2);
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ images: [PNG, after], evidence: expect.any(Array) }));
  });

  it('refuses ambiguous and unsafe capture requests before doing work', async () => {
    await expect(screenCheckUploaded(['capture'], {}, media)).rejects.toThrow('ambiguous');
    await expect(screenCheckUploaded(['capture', '--type', 'window'], {}, media)).rejects.toThrow('--window-id is required');
    await expect(screenCheckUploaded(['check', '--type', 'image', '--target', 'x.png'], { 'x.png': PNG }, media)).rejects.toThrow('--expect is required');
    await expect(screenCheckUploaded(['check', '--type', 'image', '--target', 'x.png', '--expect', 'x', '--provider', 'other'], { 'x.png': PNG }, media)).rejects.toThrow('--provider');
  });

  it('rejects unknown, duplicate, incomplete, and nonsensical options', async () => {
    await expect(screenCheckUploaded(['capture', '--surprise', 'yes'], {}, media)).rejects.toThrow('unknown option');
    await expect(screenCheckUploaded(['capture', '--type', 'image', '--type', 'web'], {}, media)).rejects.toThrow('duplicate option');
    await expect(screenCheckUploaded(['capture', '--type'], {}, media)).rejects.toThrow('missing value');
    await expect(screenCheckUploaded(['compare', '--type', 'web', '--before', 'a', '--after', 'b', '--expect', 'x'], { a: PNG, b: PNG }, media)).rejects.toThrow('accepts either uploaded');
  });

  it('exposes concise help and a machine-readable schema without capture', async () => {
    expect((await screenCheckUploaded(['--help'], {}, media)).help).toContain('window-id');
    expect((await screenCheckUploaded(['--schema'], {}, media)).schema).toEqual(expect.objectContaining({ verdicts: ['PASS', 'FAIL', 'INDETERMINATE'] }));
  });
});
