import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compositionArtifact, COMPOSITION_LIMIT } from '../composition-artifact';
import { CompositionView, CompositionPresentation, COMPOSITION_CSP } from '../composition-view';

const artifact = { version: 1, kind: 'composition', title: 'Meshlet culling', width: 1280, height: 720, html: '<script>window.ready=true</script>' } as const;

describe('isolated compositions', () => {
  it('allows authored executable content only behind an opaque-origin sandbox', () => {
    render(<CompositionView artifact={artifact} />);
    const frame = screen.getByTitle('Meshlet culling');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')).toBeNull();
    const html = frame.getAttribute('srcdoc')!;
    expect(html.indexOf(COMPOSITION_CSP)).toBeLessThan(html.indexOf(artifact.html));
    expect(COMPOSITION_CSP).toContain("connect-src 'none'");
    expect(COMPOSITION_CSP).toContain("frame-src 'none'");
    expect(COMPOSITION_CSP).toContain("form-action 'none'");
    expect(COMPOSITION_CSP).toContain("base-uri 'none'");
    expect(COMPOSITION_CSP).not.toMatch(/unsafe-eval|https:|http:|\*/);
  });
  it('preserves the same frame across native fullscreen changes', () => {
    const { container } = render(<CompositionPresentation artifact={artifact} />);
    const root = container.querySelector('[data-testid="composition-presentation"]')!;
    const frame = container.querySelector('iframe')!;
    expect(frame.style.minHeight).toBe('360px');
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: root });
    try {
      fireEvent(document, new Event('fullscreenchange'));
      expect(within(container).getByRole('button', { name: 'Close full-screen artifact' })).toBeTruthy();
      expect(container.querySelector('iframe')).toBe(frame);
      expect(frame.style.height).toBe('100%');
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      fireEvent(document, new Event('fullscreenchange'));
      expect(container.querySelector('iframe')).toBe(frame);
      expect(frame.style.minHeight).toBe('360px');
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
    }
  });
  it('counts UTF-8 bytes, including non-ASCII content, against the limit', () => {
    expect(compositionArtifact({ ...artifact, html: 'é'.repeat(COMPOSITION_LIMIT / 2) })).not.toBeNull();
    expect(compositionArtifact({ ...artifact, html: 'é'.repeat(COMPOSITION_LIMIT / 2 + 1) })).toBeNull();
  });
  it('rejects external-source shortcuts and invalid dimensions', () => {
    expect(compositionArtifact({ ...artifact, src: 'https://example.com' })).toBeNull();
    for (const width of [NaN, Infinity, 159, 4097, 160.5]) expect(compositionArtifact({ ...artifact, width })).toBeNull();
  });
});
