'use client';

interface GuidanceItem { id: string; name: string; kind: string; source: string; state: string; automatic?: boolean }
export interface GuidanceSnapshot { revision: string; items: GuidanceItem[] }

/** Availability is not evidence that a skill has been read into context. */
export function ActiveGuidance({ snapshot }: { snapshot: GuidanceSnapshot }) {
  const included = snapshot.items.filter(item => item.state === 'available' && item.kind !== 'skill');
  const onDemand = snapshot.items.filter(item => item.state === 'available' && item.kind === 'skill');
  const inactive = snapshot.items.filter(item => item.state !== 'available');
  const source = (value: string) => value === 'built-in' ? 'Built in' : value === 'global' ? 'Global' : 'Project';
  return <details className="mx-auto mb-2 w-full max-w-[110ch] text-xs text-t-secondary" data-testid="chat-shared-library">
    <summary className="cursor-pointer py-1">Active guidance</summary>
    <div className="max-h-64 space-y-4 overflow-auto py-3">
      <p>Instructions are included automatically. Skills and commands load only when used.</p>
      <section aria-label="Included guidance"><h3 className="mb-2 font-medium text-t-primary">Included in this connection · {included.length}</h3>{included.length ? <ul className="space-y-1">{included.map(item => <li key={item.id}>{item.name} <span className="text-t-muted">· {source(item.source)}{item.kind === 'output_style' ? ' · Output style' : ''}</span></li>)}</ul> : <p>No shared instructions or output style included.</p>}</section>
      {onDemand.length > 0 && <section aria-label="On-demand guidance"><h3 className="mb-2 font-medium text-t-primary">Available on demand · {onDemand.length}</h3><ul className="space-y-1">{onDemand.map(item => <li key={item.id}>{item.name} <span className="text-t-muted">· {item.automatic === false ? 'Command' : 'Skill'} · {source(item.source)}</span></li>)}</ul></section>}
      <p className="text-t-muted">This lists shared guidance, not every native provider instruction. Settings changes apply on reconnect.</p>
      <details data-testid="guidance-diagnostics"><summary className="cursor-pointer">Diagnostics</summary><p className="mt-2 break-all font-mono">Revision {snapshot.revision}</p>{inactive.map(item => <p key={item.id}>{item.name} · {item.state.replaceAll('_', ' ')}</p>)}</details>
    </div>
  </details>;
}
