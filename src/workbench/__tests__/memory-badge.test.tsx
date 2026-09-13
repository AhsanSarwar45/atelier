import { describe, expect, it } from 'vitest';
import { memoryWords } from '@/workbench/memory-badge';
describe('memory badge', () => {
  it('uses compact binary units', () => {
    expect(memoryWords(512 * 1024 ** 2)).toBe('512 MB');
    expect(memoryWords(1536 * 1024 ** 2)).toBe('1.5 GB');
  });
});
