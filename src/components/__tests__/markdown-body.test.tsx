import { fireEvent, render, screen } from '@testing-library/react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownBody } from '@/components/markdown-body';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));
const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/lib/api', () => ({ fs: { openExternal } }));
vi.mock('@/hooks/use-toast', () => ({ toast }));

describe('Markdown file links', () => {
  beforeEach(() => {
    openExternal.mockReset();
    openExternal.mockResolvedValue({ success: true });
    toast.mockReset();
  });

  it('opens an absolute path with the system default application', () => {
    render(<MarkdownBody>{'[proof](</home/me/proof.webm>)'}</MarkdownBody>);
    const link = screen.getByTestId('markdown-file-link');
    expect(link).toHaveAttribute('data-file-kind', 'video');
    expect(link).toHaveClass('text-[#e06c75]');
    expect(link).toHaveTextContent('proof');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith('/home/me/proof.webm', 'finder');
  });

  it('opens an absolute path at its cited line in the editor', () => {
    render(<MarkdownBody>{'[source](</home/me/source.ts:42>)'}</MarkdownBody>);
    const link = screen.getByTestId('markdown-file-link');
    expect(link).toHaveAttribute('data-file-kind', 'code');
    expect(link).toHaveClass('text-[#519aba]');
    expect(link).toHaveTextContent('source');
    expect(link).toHaveTextContent(':42');
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith('/home/me/source.ts', 'vscode', 42);
  });

  it('uses the file type rather than the writer label to choose its icon', () => {
    render(<MarkdownBody>{'[download](</home/me/results.csv>)'}</MarkdownBody>);
    expect(screen.getByTestId('markdown-file-link')).toHaveAttribute('data-file-kind', 'table');
    expect(screen.getByTestId('markdown-file-link')).toHaveClass('text-[#8dc149]');
  });

  it('removes a cited column while opening at the cited line', () => {
    render(<MarkdownBody>{'[source](</home/me/source.ts:42:7>)'}</MarkdownBody>);
    fireEvent.click(screen.getByTestId('markdown-file-link'));
    expect(openExternal).toHaveBeenCalledWith('/home/me/source.ts', 'vscode', 42);
  });

  it('keeps spaces in an angle-bracket path while separating a cited line', () => {
    render(<MarkdownBody>{'[source](</home/me/My Source.ts:42>)'}</MarkdownBody>);
    fireEvent.click(screen.getByTestId('markdown-file-link'));
    expect(openExternal).toHaveBeenCalledWith('/home/me/My Source.ts', 'vscode', 42);
  });

  it('draws an external site immediately with an asynchronously decoded favicon and fallback icon', () => {
    render(<MarkdownBody>{'[site](https://example.com)'}</MarkdownBody>);
    const badge = screen.getByTestId('markdown-web-badge');
    expect(badge).toHaveAttribute('target', '_blank');
    expect(badge).toHaveAttribute('data-web-kind', 'site');
    expect(badge).toHaveClass('h-5');
    expect(screen.getByTestId('external-favicon')).toHaveAttribute('decoding', 'async');
    expect(screen.getByTestId('external-favicon')).toHaveAttribute('src', 'https://example.com/favicon.ico');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['commit', 'https://github.com/openai/codex/commit/1234567890abcdef', 'openai/codex@1234567'],
    ['pull', 'https://github.com/openai/codex/pull/42', 'openai/codex #42'],
    ['issue', 'https://github.com/openai/codex/issues/81', 'openai/codex #81'],
    ['pull', 'https://gitlab.com/group/project/-/merge_requests/7', 'group/project !7'],
    ['issue', 'https://gitlab.com/group/project/-/issues/9', 'group/project #9'],
  ])('draws a typed %s badge for %s', (kind, href, label) => {
    render(<MarkdownBody>{href}</MarkdownBody>);
    const badge = screen.getByTestId('markdown-web-badge');
    expect(badge).toHaveAttribute('data-web-kind', kind);
    expect(badge).toHaveTextContent(label);
  });

  it('preserves the writer label on a hosted issue badge', () => {
    render(<MarkdownBody>{'[the regression](https://github.com/openai/codex/issues/81)'}</MarkdownBody>);
    expect(screen.getByTestId('markdown-web-badge')).toHaveTextContent('the regression');
  });

  it('leaves an in-app address in the browser', () => {
    render(<MarkdownBody>{'[project](/project)'}</MarkdownBody>);
    expect(screen.getByTestId('markdown-link')).toHaveAttribute('href', '/project');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('leaves a temporary path in the browser because the backend forbids it', () => {
    render(<MarkdownBody>{'[proof](</tmp/proof.webm>)'}</MarkdownBody>);
    expect(screen.getByTestId('markdown-link')).toHaveAttribute('href', '/tmp/proof.webm');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('tells the reader when the system opener refuses the file', async () => {
    openExternal.mockRejectedValue(new Error('permission denied'));
    render(<MarkdownBody>{'[proof](</home/me/proof.webm>)'}</MarkdownBody>);
    fireEvent.click(screen.getByTestId('markdown-file-link'));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Could not open that file',
      description: 'permission denied',
      variant: 'destructive',
    })));
  });
});

describe('Markdown images', () => {
  it('serves an absolute local picture through the guarded media route', () => {
    render(<MarkdownBody>{'![Agent files desktop screen](</home/me/My Screenshot.png>)'}</MarkdownBody>);

    expect(screen.getByAltText('Agent files desktop screen')).toHaveAttribute(
      'src',
      '/api/fs/media?path=%2Fhome%2Fme%2FMy%20Screenshot.png',
    );
  });

  it('leaves a web picture at its original address', () => {
    render(<MarkdownBody>{'![Remote proof](https://example.com/proof.png)'}</MarkdownBody>);

    expect(screen.getByAltText('Remote proof')).toHaveAttribute('src', 'https://example.com/proof.png');
  });

  it('does not route a forbidden temporary path through local media', () => {
    render(<MarkdownBody>{'![Private file](</tmp/private.png>)'}</MarkdownBody>);

    expect(screen.getByAltText('Private file')).toHaveAttribute('src', '/tmp/private.png');
  });
});
