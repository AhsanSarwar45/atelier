/**
 * A card, as a chip that opens it.
 *
 * One part wherever a card is named — the chat's rail, a message that mentions
 * one — so all of them open a card the one way the app opens cards: the card
 * panel slides over whatever tab is showing, and the reader is not thrown onto
 * the board to read it. The address carries it (`card=<id>`), so a chip works
 * from a chat, from the list, and from a link someone pasted —
 * docs/designs/app-shell.md §1.8.
 *
 * There is no crowding rule any more. The chips used to ride on the open chat's
 * own line, which is a row, and a row has to hide most of them; they are in a
 * column now and all of them are drawn (docs/agent-workbench.md §8.2.6).
 */
'use client';

import { ReferenceBadge } from '@/components/reference-badge';
import type { BeadStatus } from '@/types';

/**
 * One card, as a chip that opens it. Drawn in the chat's rail and wherever a
 * message names a card in its own words (bw-4wcd.3), so both look the same and
 * both open the card the same way. It is the one reference badge every card,
 * chat and skill is drawn as (`reference-badge.tsx`, bw-mi3s.1).
 */
export function BeadChip({
  id,
  projectId,
  size = 'sm',
  testId = 'bead-chip',
  title,
  className,
  status,
}: {
  id: string;
  projectId: string | null;
  size?: 'sm' | 'xs';
  testId?: string;
  /** What the pointer says, when the chip stands for more than the one card it names. */
  title?: string;
  className?: string;
  /** Its live board state, whose existing palette colors the chip. */
  status?: BeadStatus;
}) {
  return (
    <ReferenceBadge
      reference={{ kind: 'bead', id, status }}
      projectId={projectId}
      size={size}
      testId={testId}
      title={title}
      className={className}
    />
  );
}
