import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelIcon, modelFamily } from '@/workbench/model-icon';

describe('local model identity', () => {
  it.each([
    ['ollama::Qwen3.8 IQ3', 'qwen'],
    ['openai-compatible::Qwen3.8 Q3_K_XL', 'qwen'],
    ['ollama::gemma-26B', 'google'],
    ['ollama::DeepSeek-9B', 'deepseek'],
    ['openai-compatible::gpt-oss-20b', 'openai'],
  ] as const)('maps %s to its model family', (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it('does not invent a publisher for an unknown alias', () => {
    expect(modelFamily('my-finetune')).toBe('unknown');
    render(<ModelIcon model="my-finetune" />);
    expect(screen.getByLabelText('Local model')).toBeInTheDocument();
  });

  it('prefers authoritative family metadata', () => {
    render(<ModelIcon model="private-alias" identity="qwen" />);
    expect(screen.getByRole('img', { name: 'Qwen' })).toBeInTheDocument();
  });
});
