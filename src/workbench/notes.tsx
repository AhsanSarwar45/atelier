'use client';

/**
 * Notes on a grid, row, column, cell or task (docs/grids.md and
 * docs/tasks.md, "Notes"): anyone may leave one at any time, and whoever
 * works on it later sees it.
 */
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface Note {
  text: string;
  actor: string;
  sessionId?: string | null;
  at?: number | null;
  /** Where a cell's note was left: on the cell, or its row, column or grid. */
  scope?: 'cell' | 'row' | 'column' | 'grid' | string;
}

const SCOPE_LABEL: Record<string, string> = { cell: 'Cell', row: 'Row', column: 'Column', grid: 'Grid' };

function message(e: unknown): string {
  const said = e instanceof Error ? e.message : String(e);
  return said.replace(/^API error: \d+\s*/, '');
}

/** The notes, oldest first, and a box to add one. `onAdd` throws a refusal. */
export function NotesView({ notes, onAdd, testId }: {
  notes: Note[];
  onAdd: (text: string) => Promise<void>;
  testId: string;
}) {
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const text = words.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(text);
      setWords('');
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid={testId}>
      {notes.length > 0 && (
        <ul className="space-y-1.5">
          {notes.map((note, at) => (
            <li key={at} data-testid="note" className="rounded-md border border-border/60 px-2.5 py-1.5 text-sm">
              <div className="text-[11px] text-muted-foreground">
                {note.scope && SCOPE_LABEL[note.scope] ? `${SCOPE_LABEL[note.scope]} · ` : ''}
                {note.actor === 'owner' ? 'You' : 'Agent'}
                {note.at ? ` · ${new Date(note.at).toLocaleString()}` : ''}
              </div>
              <div className="whitespace-pre-wrap break-words">{note.text}</div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Textarea
          rows={2}
          aria-label="Add a note"
          placeholder="Add a note"
          value={words}
          onChange={(e) => setWords(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={!words.trim()} loading={busy}>Add note</Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </form>
    </div>
  );
}
