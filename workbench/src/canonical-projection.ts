import type { WbpEvent } from '../../src/workbench/protocol.ts';

export interface CanonicalProjectionDuplicate {
  key: string;
  keptSeq: number;
  droppedSeqs: number[];
}

export interface CanonicalProjectionPlan {
  sourceEvents: number;
  projectedEvents: WbpEvent[];
  duplicateEvents: number;
  duplicates: CanonicalProjectionDuplicate[];
}

type OwnerKind = 'message' | 'tool' | 'agent' | 'ask';

function ownerOf(event: WbpEvent): { kind: OwnerKind; id: string; starts: boolean } | null {
  switch (event.type) {
    case 'message.started': return { kind: 'message', id: event.messageId, starts: true };
    case 'text.delta': case 'message.completed': case 'message.retracted': case 'image': case 'image.compare': case 'widget':
    case 'thinking.delta':
      return { kind: 'message', id: event.messageId, starts: false };
    case 'tool.started': return { kind: 'tool', id: event.toolCallId, starts: true };
    case 'tool.completed': case 'tool.progress': case 'diff':
      return { kind: 'tool', id: event.toolCallId, starts: false };
    case 'agent.started': return { kind: 'agent', id: event.agentId, starts: true };
    case 'agent.progress': case 'agent.finished': case 'agent.relayed': case 'agent.identified':
      return { kind: 'agent', id: event.agentId, starts: false };
    case 'ask.permission': return { kind: 'ask', id: event.askId, starts: true };
    case 'ask.resolved': return { kind: 'ask', id: event.askId, starts: false };
    default: return null;
  }
}

function nativeKey(event: WbpEvent): string | null {
  const identity = event.providerEvent;
  return identity ? `native:${identity.provider}:${identity.threadId}:${identity.eventId}` : null;
}

/**
 * Selects a canonical transcript without rewriting its append-only source.
 *
 * Provider identity is authoritative. Legacy rows predate that envelope, so a
 * repeated start of the same stable message/tool/agent/ask identity delimits a
 * duplicate delivery block; the block's owned deltas and terminal events are
 * omitted with it. Events without either identity are preserved conservatively.
 */
export function planCanonicalProjection(events: readonly WbpEvent[]): CanonicalProjectionPlan {
  const lastReset = events.reduce((at, event, index) => event.type === 'transcript.reset' ? index : at, -1);
  const source = events.slice(lastReset + 1);
  const projectedEvents: WbpEvent[] = [];
  const seenNative = new Map<string, number>();
  const seenStarts = new Map<string, number>();
  const active = new Map<string, boolean>();
  const duplicateRows = new Map<string, CanonicalProjectionDuplicate>();
  const dropped = new Set<number>();

  const duplicate = (key: string, keptSeq: number, droppedSeq: number): void => {
    const row = duplicateRows.get(key) ?? { key, keptSeq, droppedSeqs: [] };
    row.droppedSeqs.push(droppedSeq);
    duplicateRows.set(key, row);
    dropped.add(droppedSeq);
  };

  for (const event of source) {
    const owner = ownerOf(event);
    const ownerKey = owner ? `${owner.kind}:${owner.id}` : null;
    const identity = nativeKey(event);
    let keep = true;

    if (identity) {
      const kept = seenNative.get(identity);
      if (kept === undefined) seenNative.set(identity, event.seq);
      else {
        duplicate(identity, kept, event.seq);
        keep = false;
      }
    }

    if (owner?.starts && ownerKey) {
      const kept = seenStarts.get(ownerKey);
      if (kept === undefined) seenStarts.set(ownerKey, event.seq);
      else {
        duplicate(`legacy:${ownerKey}`, kept, event.seq);
        keep = false;
      }
      active.set(ownerKey, keep);
    } else if (ownerKey && active.get(ownerKey) === false) {
      duplicate(`legacy:${ownerKey}`, seenStarts.get(ownerKey) ?? event.seq, event.seq);
      keep = false;
    }

    if (keep) projectedEvents.push(event);
  }

  const duplicates = [...duplicateRows.values()];
  return {
    sourceEvents: source.length,
    projectedEvents,
    duplicateEvents: dropped.size,
    duplicates,
  };
}
