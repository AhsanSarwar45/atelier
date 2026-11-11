'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import type { CompositionArtifact } from './composition-artifact';

// This policy precedes every author-controlled byte. Later policies can only
// restrict it. No origin permission, external resources, child frames, forms,
// popups, downloads, host commands or storage access are granted.
export const COMPOSITION_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function compositionDocument(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${COMPOSITION_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}
export function CompositionView({ artifact, fullScreen = false }: { artifact: CompositionArtifact; fullScreen?: boolean }) {
  const document = useMemo(() => compositionDocument(artifact.html), [artifact.html]);
  return <iframe data-testid="composition-artifact" title={artifact.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document}
    className="block w-full border-0 bg-black" style={{ aspectRatio: fullScreen ? undefined : `${artifact.width} / ${artifact.height}`, minHeight: fullScreen ? undefined : 360, height: fullScreen ? '100%' : undefined }} />;
}


/** Native fullscreen preserves the same browsing context and playback frame. */
export function CompositionPresentation({ artifact }: { artifact: CompositionArtifact }) {
  const root = useRef<HTMLDivElement>(null);
  const [fullScreen, setFullScreen] = useState(false);
  const [reset, setReset] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    const changed = () => setFullScreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const expand = async () => {
    try { await root.current?.requestFullscreen(); setError(false); }
    catch { setError(true); }
  };
  const close = async () => {
    try { await document.exitFullscreen(); setError(false); }
    catch { setError(true); }
  };
  return <div ref={root} data-testid="composition-presentation" className={`relative bg-black ${fullScreen ? 'h-screen w-screen' : ''}`}>
    <Panel tone="overlay" inset="bar" className="absolute right-2 top-2 z-10 flex gap-1">
      <Button type="button" size="icon" variant="ghost" aria-label={fullScreen ? 'Reset full-screen artifact' : 'Reset artifact'} onClick={() => setReset(n => n + 1)}><RotateCcw className="size-4" /></Button>
      {fullScreen
        ? <Button type="button" size="icon" variant="ghost" aria-label="Close full-screen artifact" onClick={close}><X className="size-4" /></Button>
        : <Button type="button" size="icon" variant="ghost" aria-label="Open artifact full screen" onClick={expand}><Maximize2 className="size-4" /></Button>}
    </Panel>
    {error && <p role="alert" className="absolute left-2 top-2 z-10 bg-background p-2 text-sm">Couldn't change full screen. Try again.</p>}
    <CompositionView key={reset} artifact={artifact} fullScreen={fullScreen} />
  </div>;
}
