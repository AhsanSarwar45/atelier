'use client';

import { useRef, useState } from 'react';

import { BookOpen, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Overlay, overlayPanel } from '@/components/ui/overlay';
import { cn } from '@/lib/utils';

interface GuidanceItem { id: string; name: string; kind: string; source: string; state: string; automatic?: boolean }
export interface GuidanceSnapshot { revision: string; items: GuidanceItem[] }

/** Availability is not evidence that a skill has been read into context. */
export function ActiveGuidance({ snapshot }: { snapshot: GuidanceSnapshot }) {
  const included = snapshot.items.filter(item => item.state === 'available' && item.kind !== 'skill');
  const onDemand = snapshot.items.filter(item => item.state === 'available' && item.kind === 'skill');
  const inactive = snapshot.items.filter(item => item.state !== 'available');
  const source = (value: string) => value === 'built-in' ? 'Built in' : value === 'global' ? 'Global' : 'Project';
  const [shown, setShown] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const close = () => setShown(false);
  return <>
    <Badge asChild appearance="outline" size="sm" shape="circle" className="hidden shrink-0 group-data-[expanded=true]/chips:inline-flex md:inline-flex"><Button variant="ghost" size="none" aria-label="Active guidance" ref={chip} data-testid="chat-shared-library" aria-haspopup="dialog" aria-expanded={shown} onClick={() => setShown(true)}><BookOpen className="size-3" aria-hidden="true" /><span>Guidance</span></Button></Badge>
    {/* The panel the usage and token chips open: the whole screen on a phone. */}
    {shown && <Overlay testId="guidance-popover" label="Active guidance" onClose={close} returnFocus={chip}>
    <div className={cn(overlayPanel, 'max-w-xl')}>
    <div className="flex items-center gap-2 border-b border-border/60 p-4">
      <h2 className="text-base font-semibold text-foreground">Active guidance</h2>
      <Button size="xs" mode="icon" variant="ghost" className="ml-auto" aria-label="Close" onClick={close}><X aria-hidden="true" /></Button>
    </div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs text-t-secondary">
      <p>Instructions are included automatically. Skills and commands load only when used.</p>
      <section aria-label="Included guidance"><h3 className="mb-2 font-medium text-t-primary">Included in this connection · {included.length}</h3>{included.length ? <ul className="space-y-1">{included.map(item => <li key={item.id}>{item.name} <span className="text-t-muted">· {source(item.source)}{item.kind === 'output_style' ? ' · Output style' : ''}</span></li>)}</ul> : <p>No shared instructions or output style included.</p>}</section>
      {onDemand.length > 0 && <section aria-label="On-demand guidance"><h3 className="mb-2 font-medium text-t-primary">Available on demand · {onDemand.length}</h3><ul className="space-y-1">{onDemand.map(item => <li key={item.id}>{item.name} <span className="text-t-muted">· {item.automatic === false ? 'Command' : 'Skill'} · {source(item.source)}</span></li>)}</ul></section>}
      <p className="text-t-muted">This lists shared guidance, not every native provider instruction. Settings changes apply on reconnect.</p>
      <Collapsible data-testid="guidance-diagnostics"><CollapsibleTriggerRow size="sm">Diagnostics</CollapsibleTriggerRow><CollapsibleContent><p className="mt-2 break-all font-mono">Revision {snapshot.revision}</p>{inactive.map(item => <p key={item.id}>{item.name} · {item.state.replaceAll('_', ' ')}</p>)}</CollapsibleContent></Collapsible>
    </div>
    </div>
    </Overlay>}
  </>;
}
