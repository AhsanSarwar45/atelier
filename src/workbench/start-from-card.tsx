/**
 * Start a chat about this card, from the card.
 *
 * The chat opens already knowing what the card says — its title, its body and
 * what finishing it means — and the link between the two is recorded at birth
 * rather than waited for, because pressing this button IS the statement that
 * they belong together (docs/agent-workbench.md §8.3).
 */
'use client';

import { useState } from 'react';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { Bead } from '@/types';
import { sendCommand } from '@/workbench/use-session';
import type { Brand } from '@/workbench/protocol';

/**
 * What the agent is told. Plain prose rather than a dump of fields: the card's
 * own words are what the owner would have typed, and nothing is invented on
 * top of them.
 */
export function briefFor(bead: Pick<Bead, 'id' | 'title' | 'description' | 'design' | 'notes'>): string {
  // The card's body already carries what "done" means, in its own words; this
  // does not restate it as a field of its own.
  const parts = [`I am working on ${bead.id}: ${bead.title}.`];
  if (bead.description?.trim()) parts.push(`\nWhat the card says:\n${bead.description.trim()}`);
  if (bead.design?.trim()) parts.push(`\nDesign notes on it:\n${bead.design.trim()}`);
  if (bead.notes?.trim()) parts.push(`\nRunning notes on it:\n${bead.notes.trim()}`);
  parts.push('\nRead what you need to, then tell me how you would start.');
  return parts.join('\n');
}

interface StartFromCardProps {
  bead: Bead;
  projectId: string | null;
  projectPath: string;
}

export function StartFromCard({ bead, projectId, projectPath }: StartFromCardProps) {
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [brand, setBrand] = useState<Brand>('claude');
  const router = useRouter();

  if (!projectId || !projectPath) return null;

  return (
    <div className="mt-6">
      <div className="mb-2 flex gap-2" role="group" aria-label="Coding agent">
        {(['claude', 'codex'] as const).map((choice) => (
          <Button key={choice} size="sm" variant={brand === choice ? 'primary' : 'secondary'} onClick={() => setBrand(choice)}>
            {choice === 'claude' ? 'Claude' : 'Codex'}
          </Button>
        ))}
      </div>
      <Button
        size="sm"
        variant="primary"
        data-testid="start-chat-from-card"
        data-bead-id={bead.id}
        disabled={starting}
        onClick={async () => {
          setStarting(true);
          setFailed(null);
          try {
            const s = await sendCommand<{ id: string }>({
              type: 'session.start',
              projectId,
              projectPath,
              brand,
              brief: { beadId: bead.id, text: briefFor(bead) },
            });
            router.push(
              `/project?id=${encodeURIComponent(projectId)}&tab=chat&chat=${encodeURIComponent(s.id)}`,
            );
          } catch (e) {
            setFailed(e instanceof Error ? e.message : String(e));
          } finally {
            setStarting(false);
          }
        }}
      >
        {starting ? 'Starting…' : `Start ${brand === 'claude' ? 'Claude' : 'Codex'} chat`}
      </Button>
      {failed && (
        <p data-testid="start-chat-error" className="mt-2 text-xs text-destructive">
          {failed}
        </p>
      )}
    </div>
  );
}
