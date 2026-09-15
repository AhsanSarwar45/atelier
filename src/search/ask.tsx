/**
 * Ask for something in your own words: "the chat where we fixed the loader".
 *
 * An agent, on the provider and model chosen in Settings, searches and reads
 * through the source's own tools, then names what it found and why. The server
 * checks that everything it names is real before it is shown. The run streams
 * one JSON object per line; Stop, or closing the panel, ends it
 * (server/src/search/agent.rs).
 */
'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { CornerDownLeft, Loader2, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Row } from '@/components/ui/row';
import * as api from '@/lib/api';
import type { AskSearch, Found } from '@/search/source';

export type AskEvent =
  | { type: 'started'; provider: string; model: string | null }
  | { type: 'step'; text: string }
  | { type: 'found'; item: Found }
  | { type: 'done'; dropped: number }
  | { type: 'failed'; error: string };

/** Longer than the longest limit Settings offers, so the server's own limit is what ends a run. */
const DEADLINE_MS = 20 * 60_000;

/** The steps kept on screen: enough to see it working, not a log. */
const STEPS_SHOWN = 6;

/** The JSON objects a streamed reply carries, one per line, however the bytes arrive. */
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<AskEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let held = '';
  for (;;) {
    const { done, value } = await reader.read();
    held += decoder.decode(value, { stream: !done });
    let end = held.indexOf('\n');
    while (end >= 0) {
      const line = held.slice(0, end).trim();
      held = held.slice(end + 1);
      if (line) yield JSON.parse(line) as AskEvent;
      end = held.indexOf('\n');
    }
    if (done) break;
  }
  if (held.trim()) yield JSON.parse(held) as AskEvent;
}

export function Ask<Thing extends Found>({
  source,
  onClose,
  aside,
}: {
  source: AskSearch<Thing>;
  onClose: () => void;
  /** The panel's own buttons, drawn beside the box. */
  aside: ReactNode;
}) {
  const [question, setQuestion] = useState('');
  const [running, setRunning] = useState(false);
  const [by, setBy] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [found, setFound] = useState<Thing[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [active, setActive] = useState(0);
  const run = useRef<AbortController | null>(null);
  const lastAsked = useRef('');

  useEffect(() => () => run.current?.abort(), []);

  const ask = async () => {
    const asked = question.trim();
    if (!asked) return;
    run.current?.abort();
    const mine = new AbortController();
    run.current = mine;
    lastAsked.current = asked;
    setRunning(true);
    setBy(null);
    setSteps([]);
    setFound([]);
    setFailed(null);
    setFinished(false);
    setActive(0);
    try {
      const answer = await api.request(source.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...source.body, question: asked }),
        signal: mine.signal,
        deadlineMs: DEADLINE_MS,
      });
      if (!answer.ok || !answer.body) throw new Error((await answer.text()) || `the app answered ${answer.status}`);
      for await (const event of events(answer.body)) {
        if (event.type === 'started') setBy(event.model ? `${event.provider} · ${event.model}` : event.provider);
        else if (event.type === 'step') setSteps((had) => [...had, event.text]);
        else if (event.type === 'found') setFound((had) => [...had, event.item as Thing]);
        else if (event.type === 'failed') setFailed(event.error);
        else if (event.type === 'done') setFinished(true);
      }
    } catch (e) {
      if (!mine.signal.aborted) setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      if (run.current === mine) {
        run.current = null;
        setRunning(false);
      }
    }
  };

  const stop = () => {
    run.current?.abort();
    run.current = null;
    setRunning(false);
    setSteps((had) => [...had, 'Stopped']);
  };

  const rows = found.map((thing) => ({ thing, place: source.row(thing) }));

  const open = (index: number) => {
    const row = rows[index];
    if (!row) return;
    onClose();
    row.place.open();
  };

  const keyed = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && rows.length) {
      event.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (event.key === 'ArrowUp' && rows.length) {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // The same question again opens what it found; a new one is asked.
      if (rows[active] && question.trim() === lastAsked.current) open(active);
      else if (!running) void ask();
    }
  };

  return (
    <>
      <div className="border-b border-border/60 p-3">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <Input
            autoFocus
            data-testid="ai-search-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={keyed}
            placeholder={source.placeholder}
            aria-label={source.label}
            className="min-w-0 flex-1 text-sm"
          />
          {running ? (
            <Button size="xs" variant="outline" data-testid="ai-search-stop" onClick={stop}>
              <Square className="h-3.5 w-3.5" aria-hidden="true" />
              Stop
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              data-testid="ai-search-ask"
              aria-label="Ask"
              title="Ask (Enter)"
              disabled={!question.trim()}
              onClick={() => void ask()}
            >
              <CornerDownLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          )}
          {aside}
        </div>
        {(running || by) && (
          <div data-testid="ai-search-by" className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            {running && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            <span className="capitalize">{by ?? 'Starting'}</span>
          </div>
        )}
      </div>

      <div data-testid="ai-search-results" className="min-h-0 flex-1 overflow-y-auto sm:max-h-[60vh] sm:flex-none">
        {rows.map(({ thing, place }, i) => (
          <Row
            key={place.key}
            inset="lg"
            selected={active === i}
            data-testid={place.testId}
            {...place.attrs}
            onMouseMove={() => setActive(i)}
            onClick={() => open(i)}
            className="py-1.5"
          >
            <div className="min-w-0 flex-1">
              {place.body}
              <p data-testid="ai-search-reason" className="mt-0.5 text-sm text-foreground/80">
                {thing.reason}
              </p>
            </div>
          </Row>
        ))}
        {steps.length > 0 && (
          <ol data-testid="ai-search-steps" className="space-y-0.5 px-4 py-2 font-mono text-xs text-muted-foreground">
            {steps.slice(-STEPS_SHOWN).map((step, i) => (
              <li key={`${steps.length}-${i}`} data-testid="ai-search-step" className="truncate">
                {step}
              </li>
            ))}
          </ol>
        )}
        {failed && (
          <p data-testid="ai-search-failed" className="px-4 py-3 text-sm text-red-500">
            {failed}
          </p>
        )}
        {finished && !found.length && !failed && (
          <p data-testid="ai-search-nothing" className="px-4 py-6 text-sm text-muted-foreground">
            {source.nothing}
          </p>
        )}
      </div>
    </>
  );
}
