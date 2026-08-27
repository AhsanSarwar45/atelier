import { fireEvent, render, screen } from '@testing-library/react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownBody } from '@/components/markdown-body';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
vi.mock('@/lib/api', () => ({ fs: { openExternal } }));

describe('Markdown file links', () => {
  beforeEach(() => openExternal.mockReset());

  it('opens an absolute path with the system default application', () => {
    render(<MarkdownBody>{'[proof](</home/me/proof.webm>)'}</MarkdownBody>);
    fireEvent.click(screen.getByTestId('markdown-file-link'));
    expect(openExternal).toHaveBeenCalledWith('/home/me/proof.webm', 'finder');
  });

  it('leaves web addresses as browser links', () => {
    render(<MarkdownBody>{'[site](https://example.com)'}</MarkdownBody>);
    expect(screen.getByTestId('markdown-link')).toHaveAttribute('target', '_blank');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('leaves an in-app address in the browser', () => {
    render(<MarkdownBody>{'[project](/project)'}</MarkdownBody>);
    expect(screen.getByTestId('markdown-link')).toHaveAttribute('href', '/project');
    expect(openExternal).not.toHaveBeenCalled();
  });
});
