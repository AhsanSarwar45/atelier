import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { patchCodexModelCatalog } from '../codex-model-catalog.mjs';

// ModelConfigOption.ts at the builder's pinned codex-acp revision.
const original = readFileSync(resolve('scripts/__tests__/fixtures/codex-model-config.ts.txt'), 'utf8');
const call = 'createModelConfigOption(sessionState.availableModels, currentModelId.model)';
const patched = patchCodexModelCatalog(original, call);
const compiled = ts.transpileModule(patched.model, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const exports: Record<string, (...args: unknown[]) => { options: { value: string }[]; currentValue: string }> = {};
new Function('exports', compiled)(exports);
const models = [
  { id: 'available-one', displayName: 'One', description: '' },
  { id: 'available-two', displayName: 'Two', description: '' },
];

describe('Codex account model catalogues', () => {
  it.each([null, 'openai'])('does not offer a stale configured model for %s', provider => {
    const menu = exports.createModelConfigOption(models, 'retired', provider);
    expect(menu.options.map(option => option.value)).toEqual(['available-one', 'available-two']);
    // Keep the actual selection visible to Atelier's existing fallback logic.
    expect(menu.currentValue).toBe('retired');
  });
  it('keeps a supported selection without adding a duplicate', () => {
    expect(exports.createModelConfigOption(models, 'available-two', 'openai').options).toHaveLength(2);
  });
  it('preserves unlisted model names for custom providers', () => {
    const menu = exports.createModelConfigOption(models, 'private-model', 'custom');
    expect(menu.options.map(option => option.value)).toEqual(['private-model', 'available-one', 'available-two']);
  });
  it('does not invent a model when the account catalogue is empty', () => {
    expect(exports.createModelConfigOption([], 'retired', 'openai').options).toEqual([]);
  });
  it('uses the session provider and refuses changed upstream anchors', () => {
    expect(patched.server).toContain('currentModelId.model, sessionState.authProvider)');
    expect(() => patchCodexModelCatalog(original, 'changed')).toThrow('anchors changed');
    expect(() => patchCodexModelCatalog(original + original, call)).toThrow('anchors changed');
  });
});
