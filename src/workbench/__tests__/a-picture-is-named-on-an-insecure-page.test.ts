import { afterEach, describe, expect, it, vi } from 'vitest';
import { MARKER, imageIds, imageMarker, pictureId } from '@/workbench/composer-attachments';

describe('a picture attached on a plain-HTTP page (bw-8ig7)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is named without crypto.randomUUID, which only a secure page has', () => {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
    expect((globalThis.crypto as Crypto).randomUUID).toBeUndefined();
    const id = pictureId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(imageIds(`look ${imageMarker(id)}`)).toEqual([id]);
    expect(`${imageMarker(id)}`.match(MARKER)).not.toBeNull();
    expect(pictureId()).not.toBe(id);
  });
});
