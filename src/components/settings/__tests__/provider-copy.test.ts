import { describe, expect, it } from 'vitest';

import { CLAUDE_PAGES, CODEX_PAGES } from '@/components/settings/provider-schema';

describe('provider setting descriptions', () => {
  it('explains every setting beside its control', () => {
    for (const page of [...CLAUDE_PAGES, ...CODEX_PAGES]) {
      for (const group of page.groups) {
        for (const setting of group.settings) {
          expect(setting.description.trim(), `${page.label} / ${group.title} / ${setting.label}`).not.toBe('');
        }
      }
    }
  });
});
