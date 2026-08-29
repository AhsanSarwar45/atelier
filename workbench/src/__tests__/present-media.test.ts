/** @vitest-environment node */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { present, presentUploaded } from '../present';
import { widgetSpecs } from '../../../src/workbench/chat-widgets';

describe('managed presentation media', () => {
  let root: string;
  let media: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atelier-present-'));
    media = join(root, 'media');
    process.env.ATELIER_PRESENTATION_MEDIA_DIR = media;
  });
  afterEach(() => {
    delete process.env.ATELIER_PRESENTATION_MEDIA_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  const png = () => {
    const path = join(root, 'picture.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    return path;
  };

  it('imports one image by content and emits a durable widget', () => {
    const path = png();
    const output = present(['image', '--file', path, '--alt', 'Architecture', '--caption', 'Request path']);
    const [widget] = widgetSpecs(output);
    expect(widget).toEqual(expect.objectContaining({ type: 'image', alt: 'Architecture', caption: 'Request path' }));
    expect(readdirSync(media)).toEqual([(widget as { asset: string }).asset]);
    present(['image', '--file', path, '--alt', 'Again']);
    expect(readdirSync(media)).toHaveLength(1);
  });

  it('lets the app persist bytes uploaded from an agent temporary path', () => {
    const path = png();
    delete process.env.ATELIER_PRESENTATION_MEDIA_DIR;
    const output = presentUploaded(['image', '--file', path, '--alt', 'Temporary proof'], '', { [path]: readFileSync(path) }, media);
    const [widget] = widgetSpecs(output);
    expect(readdirSync(media)).toEqual([(widget as { asset: string }).asset]);
  });

  it('imports both sides of a wipe comparison', () => {
    const before = png();
    const after = join(root, 'after.gif');
    writeFileSync(after, Buffer.from('GIF89a pixels'));
    const output = present(['compare', '--before', before, '--after', after, '--before-alt', 'Before', '--after-alt', 'After', '--mode', 'wipe']);
    expect(widgetSpecs(output)).toEqual([expect.objectContaining({ type: 'image_compare', mode: 'wipe' })]);
    expect(readdirSync(media)).toHaveLength(2);
  });

  it('refuses files whose bytes are not a supported image', () => {
    const path = join(root, 'pretend.png');
    writeFileSync(path, 'not an image');
    expect(() => present(['image', '--file', path, '--alt', 'Nope'])).toThrow('is not a PNG');
  });

  it('refuses unknown, duplicate, and incomplete options', () => {
    const path = png();
    expect(() => present(['image', '--file', path, '--alt', 'Image', '--surprise', 'yes'])).toThrow('unknown option');
    expect(() => present(['image', '--file', path, '--file', path, '--alt', 'Image'])).toThrow('duplicate option');
    expect(() => present(['image', '--file', path, '--alt'])).toThrow('missing value');
  });
});
