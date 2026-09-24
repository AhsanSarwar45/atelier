'use client';

import { BookOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface GuidanceItem { id: string; name: string; kind: string; source: string; state: string; automatic?: boolean }
export interface GuidanceSnapshot { revision: string; items: GuidanceItem[] }

/** Availability is not evidence that a skill has been read into context. */
export function ActiveGuidance({ snapshot }: { snapshot: GuidanceSnapshot }) {
  const included = snapshot.items.filter(item => item.state === 'available' && item.kind !== 'skill');
  const onDemand = snapshot.items.filter(item => item.state === 'available' && item.kind === 'skill');
  const inactive = snapshot.items.filter(item => item.state !== 'available');
  const source = (value: string) => value === 'built-in' ? 'Built in' : value === 'global' ? 'Global' : 'Project';
  return <Popover>
    <PopoverTrigger asChild><Badge asChild appearance="outline" size="sm" shape="circle"><Button variant="ghost" size="sm" aria-label="Active guidance" data-testid="chat-shared-library"><BookOpen className="size-3" aria-hidden="true" /><span>Guidance</span></Button></Badge></PopoverTrigger>
    <PopoverContent align="end" side="bottom" aria-label="Active guidance" data-testid="guidance-popover" className="w-96 max-w-[calc(100vw-2rem)] text-xs text-t-secondary">
    <div className="max-h-[min(24rem,60vh)] space-y-4 overflow-auto">
      <h2 className="text-sm font-semibold text-t-primary">Active guidance</h2>
      <p>Instructions are included automatically. Skills and commands load only when used.</p>
      <section aria-label="Included guidance"><h3 className="mb-2 font-medium text-t-primary">Included in this connection · {included.length}</h3>{included.length ? <ul className="space-y-1">{included.map(item => <li key={item.id}>{item.name} <span className="text-t-muted">· {source(item.source)}{item.kind === 'output_style' ? ' · Output style' : ''}</span></li>)}</ul> : <p>No shared instructions or output style included.</p>}</section>
      {onDemand.length > 0 && <section aria-label="On-demand guidance"><h3 className="mb-2 font-medium text-t-primary">Available on demand · {onDemand.length}</h3><ul className="space-y-1">{onDemand.map(item => <li key={item.id}>{item.name} <span className="text-t-muted">· {item.automatic === false ? 'Command' : 'Skill'} · {source(item.source)}</span></li>)}</ul></section>}
      <p className="text-t-muted">This lists shared guidance, not every native provider instruction. Settings changes apply on reconnect.</p>
      <details data-testid="guidance-diagnostics"><summary className="cursor-pointer">Diagnostics</summary><p className="mt-2 break-all font-mono">Revision {snapshot.revision}</p>{inactive.map(item => <p key={item.id}>{item.name} · {item.state.replaceAll('_', ' ')}</p>)}</details>
    </div>
    </PopoverContent>
  </Popover>;
}
