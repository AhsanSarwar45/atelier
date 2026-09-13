'use client';
import { MemoryStick } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { BadgeButton } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { apiUrl } from '@/lib/api-base';

interface MemoryReport { totalBytes: number; appBytes: number; processes: number; chats: Array<{ sessionId: string; title: string; bytes: number; processes: number }> }
function isMemoryReport(value: unknown): value is MemoryReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<MemoryReport>;
  return typeof report.totalBytes === 'number' && typeof report.appBytes === 'number'
    && typeof report.processes === 'number' && Array.isArray(report.chats);
}
export function memoryWords(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
export function MemoryBadge() {
  const [report, setReport] = useState<MemoryReport | null>(null);
  const read = useCallback(() => { void fetch(apiUrl('/api/workbench/memory'), { cache: 'no-store' })
    .then(async response => { if (!response.ok) throw new Error(await response.text()); return response.json() as Promise<unknown>; })
    .then(value => { if (isMemoryReport(value)) setReport(value); }).catch(() => {}); }, []);
  useEffect(() => { read(); const timer = window.setInterval(read, 3_000); return () => window.clearInterval(timer); }, [read]);
  if (!report) return null;
  return <Popover onOpenChange={open => open && read()}>
    <PopoverTrigger asChild><BadgeButton data-testid="memory-badge" aria-label={`Atelier RAM usage: ${memoryWords(report.totalBytes)}`} className="hidden shrink-0 gap-1 md:inline-flex">
      <MemoryStick className="size-3" aria-hidden="true" /><span>{memoryWords(report.totalBytes)}</span>
    </BadgeButton></PopoverTrigger>
    <PopoverContent align="start" className="w-80 p-0" data-testid="memory-popup">
      <div className="border-b px-3 py-2"><p className="text-sm font-medium">RAM usage</p><p className="text-xs text-muted-foreground">Atelier and all {report.processes} processes</p></div>
      <div className="max-h-72 overflow-y-auto p-2 text-sm">
        {report.chats.map(chat => <div key={chat.sessionId} className="flex items-center gap-3 rounded px-2 py-1.5" data-testid="memory-chat-row"><span className="min-w-0 flex-1 truncate">{chat.title}</span><span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(chat.bytes)}</span></div>)}
        <div className="flex items-center gap-3 rounded px-2 py-1.5"><span className="min-w-0 flex-1 truncate">App and shared services</span><span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(report.appBytes)}</span></div>
      </div>
      <div className="flex items-center justify-between border-t px-4 py-2 text-sm font-medium"><span>Total</span><span className="tabular-nums">{memoryWords(report.totalBytes)}</span></div>
    </PopoverContent>
  </Popover>;
}
