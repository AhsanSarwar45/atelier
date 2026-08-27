/** @vitest-environment node */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { materializeComparisons } from '../materialize-chat-media';

describe('materializing chat comparison files', () => {
  it('reads image pairs inside the project and refuses paths outside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-media-'));
    const pictures = join(root, 'shots');
    mkdirSync(pictures);
    writeFileSync(join(pictures, 'before.png'), Buffer.from('before'));
    writeFileSync(join(pictures, 'after.png'), Buffer.from('after'));
    try {
      const valid = '```atelier-image-compare\n{"mode":"side_by_side","before":{"path":"shots/before.png"},"after":{"path":"shots/after.png"}}\n```';
      expect(materializeComparisons(valid, root)).toEqual([expect.objectContaining({
        mode: 'side_by_side', before: expect.objectContaining({ alt: 'Before' }), after: expect.objectContaining({ alt: 'After' }),
      })]);

      const escaped = '```atelier-image-compare\n{"mode":"wipe","before":{"path":"../secret.png"},"after":{"path":"shots/after.png"}}\n```';
      expect(materializeComparisons(escaped, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads Codex chat attachments from their generated temp directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'project-'));
    const attachments = mkdtempSync(join(tmpdir(), 'atelier-codex-images-'));
    writeFileSync(join(attachments, 'before.png'), Buffer.from('before'));
    writeFileSync(join(root, 'after.png'), Buffer.from('after'));
    try {
      const source = `\`\`\`atelier-image-compare\n{"before":{"path":"${join(attachments, 'before.png')}"},"after":{"path":"after.png"}}\n\`\`\``;
      expect(materializeComparisons(source, root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(attachments, { recursive: true, force: true });
    }
  });
});
