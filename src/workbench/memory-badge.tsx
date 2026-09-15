'use client';

import { useCallback, useEffect, useState } from 'react';

import { MemoryStick } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { request } from '@/lib/api';

interface MemoryReport {
  totalBytes: number;
  metric: 'pss';
  processCount: number;
  chats: Array<{ sessionId: string; title: string; bytes: number; processes: number }>;
  processDetails: Array<{ pid: number; parentPid: number | null; name: string; bytes: number; sessionId: string | null; chatTitle: string | null }>;
}
function isMemoryReport(value: unknown): value is MemoryReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<MemoryReport>;
  return typeof report.totalBytes === 'number' && report.metric === 'pss'
    && typeof report.processCount === 'number' && Array.isArray(report.chats) && Array.isArray(report.processDetails);
}
export function memoryWords(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
export function MemoryBadge() {
  const [report, setReport] = useState<MemoryReport | null>(null);
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
      <div className="border-b px-3 py-2"><p className="text-sm font-medium">RAM usage</p><p className="text-xs text-muted-foreground">Proportional memory across {report.processCount} processes</p></div>
      <div className="max-h-80 overflow-y-auto p-2 text-sm">
        {report.chats.length > 0 && <><p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Active chats</p>
          {report.chats.map(chat => <div key={chat.sessionId} className="flex items-center gap-3 rounded px-2 py-1.5" data-testid="memory-chat-row"><span className="min-w-0 flex-1 truncate">{chat.title}<span className="ml-1 text-xs text-muted-foreground">({chat.processes})</span></span><span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(chat.bytes)}</span></div>)}
          <div className="my-1 border-t" /></>}
        <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Processes</p>
        {report.processDetails.map(process => <div key={process.pid} className="flex items-center gap-3 rounded px-2 py-1.5" data-testid="memory-process-row">
          <span className="min-w-0 flex-1"><span className="block truncate">{process.name || 'Process'}</span><span className="block truncate text-xs text-muted-foreground">PID {process.pid}{process.chatTitle ? ` · ${process.chatTitle}` : ' · Atelier'}</span></span>
          <span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(process.bytes)}</span>
        </div>)}
      </div>
      <div className="flex items-center justify-between border-t px-4 py-2 text-sm font-medium"><span>Total</span><span className="tabular-nums">{memoryWords(report.totalBytes)}</span></div>
    </PopoverContent>
  </Popover>;
}
