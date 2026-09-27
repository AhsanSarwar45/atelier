'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { AppWindow, Box, ChevronRight, MemoryStick, MessageSquare, Square } from 'lucide-react';

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
  chats: Array<{
    sessionId: string; title: string; bytes: number; processes: number;
    /** What the containers charged to this chat hold; absent from an older server. */
    containerBytes?: number; containers?: number;
  }>;
  processDetails: Array<{
    pid: number; parentPid: number | null; name: string; bytes: number; swapBytes: number;
    sessionId: string | null; chatTitle: string | null;
    role: 'app' | 'accountReader' | 'appService' | 'chatAdapter' | 'provider' | 'subprocess';
    killable: boolean; startTime: number;
  }>;
  /** The kernel's account of the app's own control group, absent outside one. */
  service?: {
    totalBytes: number; cacheBytes: number; pressure: number;
    /** Programs in the service the app did not start, such as a Dolt server; absent from an older server. */
    others?: Array<{ pid: number; name: string; bytes: number }>;
  } | null;
  /** Running Docker containers, each charged to the chat that started it when one did. */
  containers?: Array<{
    id: string; name: string; image: string; bytes: number; cacheBytes: number;
    sessionId: string | null; chatTitle: string | null;
    owner: 'label' | 'workingDir' | null; project: string | null; workingDir: string | null;
  }>;
}
function isMemoryReport(value: unknown): value is MemoryReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<MemoryReport>;
  return typeof report.totalBytes === 'number' && typeof report.swapBytes === 'number'
    && report.metric === 'pssWithSwap'
    && typeof report.processCount === 'number' && Array.isArray(report.chats) && Array.isArray(report.processDetails);
}
type Process = MemoryReport['processDetails'][number];
type Container = NonNullable<MemoryReport['containers']>[number];

/** One top-level entry of the popup: a chat, the app itself, or the containers nobody here started. */
interface Group {
  key: string;
  kind: 'chat' | 'app' | 'other';
  title: string;
  /** What the entry adds to the chip's total; the other containers add nothing. */
  bytes: number;
  processes: Process[];
  containers: Container[];
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const sum = (rows: Array<{ bytes: number }>) => rows.reduce((total, row) => total + row.bytes, 0);

/**
 * Sorts the report into one entry per chat, largest first, then the app's own
 * processes, then the containers no chat started. A process or container
 * charged to a chat the report no longer lists still gets an entry of its own,
 * so nothing drops out of the tree.
 */
export function memoryGroups(report: MemoryReport): Group[] {
  const chats = new Map<string, Group>();
  const chatFor = (sessionId: string, title: string | null) => {
    let group = chats.get(sessionId);
    if (!group) {
      group = { key: `chat:${sessionId}`, kind: 'chat', title: title || 'Closed chat', bytes: 0, processes: [], containers: [] };
      chats.set(sessionId, group);
    }
    return group;
  };
  for (const chat of report.chats) chatFor(chat.sessionId, chat.title);
  const app: Group = { key: 'app', kind: 'app', title: 'App', bytes: 0, processes: [], containers: [] };
  const other: Group = { key: 'other', kind: 'other', title: 'Other containers', bytes: 0, processes: [], containers: [] };
  for (const process of report.processDetails) {
    (process.sessionId ? chatFor(process.sessionId, process.chatTitle) : app).processes.push(process);
  }
  for (const container of report.containers ?? []) {
    (container.sessionId ? chatFor(container.sessionId, container.chatTitle) : other).containers.push(container);
  }
  for (const group of [...chats.values(), app]) group.bytes = sum(group.processes) + sum(group.containers);
  const listed = [...chats.values()].filter(group => group.processes.length + group.containers.length > 0)
    .sort((a, b) => b.bytes - a.bytes);
  return [...listed, ...(app.processes.length ? [app] : []), ...(other.containers.length ? [other] : [])];
}

interface Branch { process: Process; children: Branch[] }
/** Nests processes under their parents; a process whose parent is not in the list is a root. */
function processTree(processes: Process[]): Branch[] {
  const branches = new Map(processes.map(process => [process.pid, { process, children: [] as Branch[] }]));
  const roots: Branch[] = [];
  for (const branch of branches.values()) {
    const parent = branch.process.parentPid === null ? undefined : branches.get(branch.process.parentPid);
    (parent && parent !== branch ? parent.children : roots).push(branch);
  }
  const order = (list: Branch[]) => { list.sort((a, b) => b.process.bytes - a.process.bytes); list.forEach(branch => order(branch.children)); };
  order(roots);
  return roots;
}

const ROLE_WORDS: Record<Process['role'], string> = {
  app: 'Atelier app', accountReader: 'Usage reader', appService: 'Service',
  chatAdapter: 'Chat adapter', provider: 'Agent', subprocess: 'Subprocess',
};
const APP_PARTS: Array<{ key: string; title: string; roles: Array<Process['role']> }> = [
  { key: 'main', title: 'Atelier app', roles: ['app'] },
  { key: 'readers', title: 'Usage readers', roles: ['accountReader'] },
  { key: 'services', title: 'Services', roles: ['appService', 'chatAdapter', 'provider', 'subprocess'] },
];

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
  // Top-level entries start closed so a busy machine reads as a short list;
  // the parts inside an entry start open. Both survive the three-second
  // refresh and a closed popup, because the state lives here.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
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
  // A container is started by Docker, not by the chat's own processes, so it
  // is measured apart. The chip counts the ones a chat is responsible for;
  // containers nobody here started are listed but not charged to Atelier.
  const containers = report.containers ?? [];
  const chatContainerBytes = containers.reduce((total, container) => total + (container.sessionId ? container.bytes : 0), 0);
  // The service total is what the kernel and systemd-oomd hold the app to:
  // its processes, programs it did not start that run in its service, and
  // the disk cache it read in. The chip shows that when there is one, so the
  // number that gets the app killed is the number on the chip (bw-xeeqg.16).
  const shownBytes = (report.service ? report.service.totalBytes : report.totalBytes) + chatContainerBytes;
  const otherBytes = sum(report.service?.others ?? []);
  const groups = memoryGroups(report);
  const flip = (set: ReadonlySet<string>, key: string) => { const next = new Set(set); if (!next.delete(key)) next.add(key); return next; };
  const stop = (process: Process) => {
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
  const branchRows = (branches: Branch[], depth: number): ReactNode[] => branches.flatMap(({ process, children }) => [
    <div key={process.pid} className="flex items-center gap-2 rounded py-1 pr-1 hover:bg-muted/50" style={{ paddingLeft: `${0.5 + depth * 0.875}rem` }}
      data-testid="memory-process-row" data-depth={depth}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{depth > 0 && <span className="mr-1 text-muted-foreground/60" aria-hidden="true">└</span>}{process.name || 'Process'}</span>
        <span className="block truncate text-xs text-muted-foreground" style={{ paddingLeft: depth > 0 ? '0.875rem' : undefined }}>{ROLE_WORDS[process.role]} · PID {process.pid}</span>
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(process.bytes)}</span>
      {process.killable ? <Button variant={confirming === process.pid ? 'destructive' : 'ghost'} mode="icon" size="xs"
        disabled={stopping !== null} data-testid="memory-process-stop"
        aria-label={confirming === process.pid ? `Confirm stopping ${process.name}` : `Stop ${process.name}`}
        title={confirming === process.pid ? 'Confirm' : 'Stop process'}
        onClick={() => stop(process)}><Square className="size-3" aria-hidden="true" /></Button> : <span className="size-6 shrink-0" aria-hidden="true" />}
    </div>,
    ...branchRows(children, depth + 1),
  ]);
  const containerRows = (list: Container[]) => [...list].sort((a, b) => b.bytes - a.bytes).map(container =>
    <div key={container.id} className="flex items-center gap-2 rounded py-1 pl-2 pr-1 hover:bg-muted/50" data-testid="memory-container-row">
      <span className="min-w-0 flex-1"><span className="block truncate">{container.name}</span>
        <span className="block truncate text-xs text-muted-foreground">{container.image}</span></span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{memoryWords(container.bytes)}</span>
      <span className="size-6 shrink-0" aria-hidden="true" />
    </div>);
  const part = (key: string, title: string, bytes: number, count: string, rows: ReactNode) => {
    const open = !folded.has(key);
    return <div key={key} data-testid="memory-subgroup">
      <Button variant="ghost" size="none" className="flex w-full items-center justify-start gap-1.5 rounded py-1 pl-1 pr-8 text-left text-xs font-normal text-muted-foreground hover:bg-muted/50"
        aria-expanded={open} onClick={() => setFolded(set => flip(set, key))}>
        <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium uppercase tracking-wide">{title} <span className="font-normal normal-case tracking-normal">({count})</span></span>
        <span className="shrink-0 tabular-nums">{memoryWords(bytes)}</span>
      </Button>
      {open && <div className="ml-2.5 border-l pl-1">{rows}</div>}
    </div>;
  };
  const inside = (group: Group) => {
    if (group.kind === 'other') return containerRows(group.containers);
    if (group.kind === 'app') return APP_PARTS.map(({ key, title, roles }) => {
      const processes = group.processes.filter(process => roles.includes(process.role));
      if (!processes.length) return null;
      return part(`app:${key}`, title, sum(processes), String(processes.length), branchRows(processTree(processes), 0));
    });
    return <>
      {group.processes.length > 0 && part(`${group.key}:processes`, 'Processes', sum(group.processes), String(group.processes.length), branchRows(processTree(group.processes), 0))}
      {group.containers.length > 0 && part(`${group.key}:containers`, 'Containers', sum(group.containers), String(group.containers.length), containerRows(group.containers))}
    </>;
  };
  const summary = (group: Group) => {
    if (group.kind === 'other') return plural(group.containers.length, 'container', 'containers');
    const words = [plural(group.processes.length, 'process', 'processes')];
    if (group.containers.length) words.push(plural(group.containers.length, 'container', 'containers'));
    return words.join(' · ');
  };
  const GroupIcon = { chat: MessageSquare, app: AppWindow, other: Box } as const;
  return <Popover onOpenChange={open => open && read()}>
    <PopoverTrigger asChild>
      <Badge asChild appearance="outline" size="sm" shape="circle" className="hidden shrink-0 md:inline-flex">
        <Button variant="ghost" size="none" data-testid="memory-badge" aria-label={`Atelier RAM usage: ${memoryWords(shownBytes)}`}>
          <MemoryStick className="size-3" aria-hidden="true" />
          <span>{memoryWords(shownBytes)}</span>
        </Button>
      </Badge>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-[26rem] p-0" data-testid="memory-popup">
      <div className="border-b px-3 py-2"><p className="text-sm font-medium">RAM usage</p></div>
      <div className="max-h-[28rem] overflow-y-auto p-1.5 text-sm">
        {groups.map(group => {
          const open = opened.has(group.key);
          const Icon = GroupIcon[group.kind];
          return <div key={group.key} data-testid="memory-group" data-kind={group.kind}>
            <Button variant="ghost" size="none" className="flex h-auto w-full items-center justify-start gap-2 rounded px-1.5 py-1.5 text-left font-normal hover:bg-muted/60"
              aria-expanded={open} onClick={() => setOpened(set => flip(set, group.key))}>
              <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1"><span className="block truncate">{group.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{summary(group)}</span></span>
              <span className={`shrink-0 pr-1 tabular-nums ${group.kind === 'other' ? 'text-muted-foreground' : 'font-medium'}`}>{memoryWords(group.kind === 'other' ? sum(group.containers) : group.bytes)}</span>
            </Button>
            {open && <div className="mb-1 ml-3 border-l pl-1.5">{inside(group)}</div>}
          </div>;
        })}
        {error && <p className="px-2 py-1 text-xs text-destructive" role="alert">{error}</p>}
      </div>
      <div className="border-t px-4 py-2 text-sm">
        <div className="flex items-center justify-between font-medium"><span>Total</span><span className="tabular-nums">{memoryWords(shownBytes)}</span></div>
        {!report.service && chatContainerBytes > 0 && <div className="flex items-center justify-between pt-0.5 text-xs font-normal text-muted-foreground" data-testid="memory-container-line">
          <span>Processes {memoryWords(report.totalBytes)}</span>
          <span className="tabular-nums">Chat containers {memoryWords(chatContainerBytes)}</span>
        </div>}
        {/* Pages the kernel has pushed to swap still cost the machine, so the
            total counts them. Naming the split keeps the total explainable
            when it runs ahead of the resident figure a system monitor shows,
            and says plainly that the app is under memory pressure. */}
        {report.swapBytes > 0 && <div className="flex items-center justify-between pt-0.5 text-xs font-normal text-muted-foreground" data-testid="memory-swap-line">
          <span>In RAM {memoryWords(report.totalBytes - report.swapBytes)}</span>
          <span className="tabular-nums">Swapped {memoryWords(report.swapBytes)}</span>
        </div>}
        {/* What the total is made of. The disk cache counts toward the
            service's limit: when the limit is reached the kernel stalls every
            process while it frees it, and that stall is the pressure
            systemd-oomd kills on. */}
        {report.service && <div className="mt-1.5 space-y-0.5 border-t pt-1.5 text-xs text-muted-foreground" data-testid="memory-service">
          <div className="flex items-center justify-between"><span>Processes</span><span className="tabular-nums">{memoryWords(report.totalBytes)}</span></div>
          {otherBytes > 0 && <div className="flex items-center justify-between gap-2" data-testid="memory-others">
            <span className="min-w-0 truncate">Other programs ({[...new Set(report.service.others!.map(other => other.name))].join(', ')})</span>
            <span className="shrink-0 tabular-nums">{memoryWords(otherBytes)}</span>
          </div>}
          <div className="flex items-center justify-between"><span>Disk cache</span><span className="tabular-nums">{memoryWords(report.service.cacheBytes)}</span></div>
          {chatContainerBytes > 0 && <div className="flex items-center justify-between" data-testid="memory-container-line"><span>Chat containers</span><span className="tabular-nums">{memoryWords(chatContainerBytes)}</span></div>}
          <div className={`flex items-center justify-between ${report.service.pressure >= 40 ? 'font-medium text-destructive' : ''}`} data-testid="memory-pressure">
            <span>Memory pressure</span><span className="tabular-nums">{Math.round(report.service.pressure)}%</span>
          </div>
        </div>}
      </div>
    </PopoverContent>
  </Popover>;
}
