import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync('src/workbench/chat-tab.tsx', 'utf8');

describe('model and reasoning defaults', () => {
  it('keeps a separate persisted default for each provider and passes both into new chats', () => {
    expect(source).toContain("const MODEL_DEFAULTS = 'workbench.model-defaults'");
    expect(source).toContain("const EFFORT_DEFAULTS = 'workbench.effort-defaults'");
    expect(source).toContain('model: modelDefaults[brand]');
    expect(source).toContain('effort: effortDefaults[brand]');
  });

  it('puts a default action beside every model and effort selector row', () => {
    expect(source).toContain('data-testid={`${testid}-default-${o.value}`}');
    expect(source).toContain("defaultValue={view.brand ? modelDefaults[view.brand] ?? null : null}");
    expect(source).toContain("defaultValue={view.brand ? effortDefaults[view.brand] ?? null : null}");
  });
});
