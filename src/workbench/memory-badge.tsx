'use client';

import { useCallback, useEffect, useState } from 'react';

import { MemoryStick, Square } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { request } from '@/lib/api';

interface MemoryReport {
  totalBytes: number;
  /** The part of totalBytes the kernel has paged out rather than holding in RAM. */
  swapBytes: number;
  metric: 'pssWithSwap';
  processCount: number;
  chats: Array<{ sessionId: string; title: string; bytes: number; processes: number }>;
  processDetails: Array<{
    pid: number; parentPid: number | null; name: string; bytes: number; swapBytes: number;
    sessionId: string | null; chatTitle: string | null;
    role: 'app' | 'accountReader' | 'appService' | 'chatAdapter' | 'provider' | 'subprocess';
    killable: boolean; startTime: number;
  }>;
  /** The kernel's account of the app's own control group, absent outside one. */
  service?: { totalBytes: number; cacheBytes: number; pressure: number } | null;
}
function isMemoryReport(value: unknown): value is MemoryReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<MemoryReport>;
  return typeof report.totalBytes === 'number' && typeof report.swapBytes === 'number'
    && report.metric === 'pssWithSwap'
    && typeof report.processCount === 'number' && Array.isArray(report.chats) && Array.isArray(report.processDetails);
}
export function memoryWords(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
export function MemoryBadge() {
  const [report, setReport] = useState<MemoryReport | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => { void request('/api/workbench/memory', { cache: 'no-store' })
    .then(async response => { if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<unknown>; })
    .then(value => { if (isMemoryReport(value)) setReport(value); }).catch(() => {}); }, []);
  // Nobody reads a badge on a hidden tab, so a hidden tab does not ask; it
  // catches up the moment it is shown again.
  useEffect(() => {
    read();
    const timer = window.setInterval(() => { if (!document.hidden) read(); }, 3_000);
    const shown = () => { if (!document.hidden) read(); };
    document.addEventListener('visibilitychange', shown);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', shown); };
  }, [read]);
  if (!report) return null;
  const stop = (process: MemoryReport['processDetails'][number]) => {
    if (!process.sessionId || stopping !== null) return;
    if (confirming !== process.pid) { setConfirming(process.pid); setError(null); return; }
    setStopping(process.pid);
    setConfirming(null);
    void request('/api/workbench/memory/terminate', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: process.pid, startTime: process.startTime, sessionId: process.sessionId }),
    }).then(async response => {
      if (!response.ok) {
        const value = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(value?.error || 'Could not stop the process');
      }
      read();
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not stop the process'))
      .finally(() => setStopping(null));
  };
  const role = (process: MemoryReport['processDetails'][number]) => {
    if (process.chatTitle) return process.chatTitle;
    if (process.role === 'accountReader') return 'Account usage reader';
    if (process.role === 'app') return 'Atelier app';
    if (process.role === 'appService') return 'Atelier service';
    return 'Chat runtime';
  };
  return <Popover onOpenChange={open => open && read()}>
    <PopoverTrigger asChild>
      <Badge asChild appearance="outline" size="sm" shape="circle" className="hidden shrink-0 md:inline-flex">
        <Button variant="ghost" size="sm" data-testid="memory-badge" aria-label={`Atelier RAM usage: ${memoryWords(report.totalBytes)}`}>
          <MemoryStick className="size-3" aria-hidden="true" />
          <span>{memoryWords(report.totalBytes)}</span>
        </Button>
      </Badge>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-96 p-0" data-testid="memory-popup">
      <div className="border-b px-3 py-2"><p className="text-sm font-medium">RAM usage</p><p className="text-xs text-muted-foreground">Proportional memory across {report.processCount} processes, resident and swapped</p></div>
      <div className="max-h-80 overflow-y-auto p-2 text-sm">
        {report.chats.length > 0 && <><p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Active chats</p>
          {report.chats.map(chat => <div key={chat.sessionId} className="flex items-center gap-3 rounded px-2 py-1.5" data-testid="memory-chat-row"><span className="min-w-0 flex-1 truncate">{chat.title}<span className="ml-1 text-xs text-muted-foreground">({chat.processes})</span></span><span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(chat.bytes)}</span></div>)}
          <div className="my-1 border-t" /></>}
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Processes</p>
        {report.processDetails.map(process => <div key={process.pid} className="flex items-center gap-2 rounded px-2 py-1.5" data-testid="memory-process-row">
          <span className="min-w-0 flex-1"><span className="block truncate">{process.name || 'Process'}</span><span className="block truncate text-xs text-muted-foreground">PID {process.pid} · {role(process)}</span></span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(process.bytes)}</span>
          {process.killable && <Button variant={confirming === process.pid ? 'destructive' : 'ghost'} mode="icon" size="xs"
            disabled={stopping !== null} data-testid="memory-process-stop"
            aria-label={confirming === process.pid ? `Confirm stopping ${process.name}` : `Stop ${process.name}`}
            title={confirming === process.pid ? 'Click again to confirm' : 'Stop this subprocess without ending the chat'}
            onClick={() => stop(process)}><Square className="size-3" aria-hidden="true" /></Button>}
        </div>)}
        {error && <p className="px-2 py-1 text-xs text-destructive" role="alert">{error}</p>}
      </div>
      <div className="border-t px-4 py-2 text-sm">
        <div className="flex items-center justify-between font-medium"><span>Total</span><span className="tabular-nums">{memoryWords(report.totalBytes)}</span></div>
        {/* Pages the kernel has pushed to swap still cost the machine, so the
            total counts them. Naming the split keeps the total explainable
            when it runs ahead of the resident figure a system monitor shows,
            and says plainly that the app is under memory pressure. */}
        {report.swapBytes > 0 && <div className="flex items-center justify-between pt-0.5 text-xs font-normal text-muted-foreground" data-testid="memory-swap-line">
          <span>In RAM {memoryWords(report.totalBytes - report.swapBytes)}</span>
          <span className="tabular-nums">Swapped {memoryWords(report.swapBytes)}</span>
        </div>}
        {/* The group total is what a system monitor reading the service sees;
            most of the gap is file cache the kernel drops on demand. What gets
            the app killed is pressure, so that is shown beside it. */}
        {report.service && <div className="mt-1.5 space-y-0.5 border-t pt-1.5 text-xs text-muted-foreground" data-testid="memory-service">
          <div className="flex items-center justify-between"><span>Service total</span><span className="tabular-nums">{memoryWords(report.service.totalBytes)}</span></div>
          <div className="flex items-center justify-between"><span>Freeable cache</span><span className="tabular-nums">{memoryWords(report.service.cacheBytes)}</span></div>
          <div className={`flex items-center justify-between ${report.service.pressure >= 40 ? 'font-medium text-destructive' : ''}`} data-testid="memory-pressure">
            <span>Memory pressure</span><span className="tabular-nums">{Math.round(report.service.pressure)}%</span>
          </div>
        </div>}
      </div>
    </PopoverContent>
  </Popover>;
}
