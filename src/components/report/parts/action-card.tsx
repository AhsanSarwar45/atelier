/**
 * "What I need from you" — the first fixed part. An FYI report shows a plain
 * no-action note (`blocks.py`/`build.py`'s `action_card`, the `none` branch);
 * otherwise each question is a numbered radiogroup of answer chips, defaulting
 * to whichever option carries `pick: true`, same as `aria-checked` does in the
 * reference. A question the board has already settled (`live: false`) loses
 * its chips — the answer stopped mattering, so nothing here should invite
 * picking one.
 */
'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

import { Gloss } from '../glossary';
import { ReportCard } from '../report-card';
import { useReply } from '../reply';
import type { ReportActions, ReportQuestion } from '../types';

function sayFor(o: { label: string; say?: string | null }): string {
  return o.say || `${o.label.replace(/\.$/, '')}.`;
}

function QuestionChips({ question, index }: { question: ReportQuestion; index: number }) {
  const { answerFor, pick } = useReply();
  const picked = answerFor(question.id);

  // The option marked `pick: true` starts checked, same as the reference
  // page's `aria-checked` on load — the reply preview should already read
  // something sensible before the manager touches a single chip.
  useEffect(() => {
    if (picked !== undefined) return;
    const preferred = question.options.find((o) => o.pick);
    if (preferred) pick(question.id, sayFor(preferred));
    // Only ever runs the one-time default; re-running on `picked` would fight the user's own clicks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
      <span className="mt-0.5 flex size-6 items-center justify-center rounded-full bg-surface-overlay text-xs font-bold text-t-secondary">
        {index}
      </span>
      <div className="grid grid-cols-1 gap-2">
        <p className="text-sm font-semibold text-t-primary">
          <Gloss text={question.ask} />
        </p>
        <div role="radiogroup" aria-label={question.ask} className="flex flex-wrap gap-1.5">
          {question.options.map((o, i) => {
            const say = sayFor(o);
            const checked = picked === say;
            return (
              <Button
                key={i}
                type="button"
                role="radio"
                aria-checked={checked}
                selected={checked}
                variant="outline"
                size="sm"
                onClick={() => pick(question.id, say)}
              >
                {o.label}
              </Button>
            );
          })}
        </div>
        {question.note && <p className="text-xs text-t-muted">{question.note}</p>}
      </div>
    </div>
  );
}

function ResolvedQuestion({ question, index }: { question: ReportQuestion; index: number }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 opacity-60">
      <span className="mt-0.5 flex size-6 items-center justify-center rounded-full bg-surface-overlay text-xs font-bold text-t-muted">
        {index}
      </span>
      <div className="grid grid-cols-1 gap-1">
        <p className="text-sm font-semibold text-t-muted line-through">{question.ask}</p>
        <p className="text-xs text-t-muted">Settled on the board — this no longer needs an answer.</p>
      </div>
    </div>
  );
}

function ReplyRow({ questionIds }: { questionIds: string[] }) {
  const { replyText } = useReply();
  const [copied, setCopied] = useState(false);
  const text = replyText(questionIds);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
    } catch {
      // Clipboard access can be denied by the browser; the preview text is
      // still on screen to select by hand, so this fails quietly.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  return (
    <div className="flex flex-col gap-2 border-t border-b-subtle pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="min-h-5 flex-1 text-sm italic text-t-secondary">{text}</p>
      <Button type="button" size="sm" variant={copied ? 'primary' : 'outline'} onClick={copy} className="shrink-0">
        {copied ? 'Copied — paste it in' : 'Copy my reply'}
      </Button>
    </div>
  );
}

export function ActionCard({ actions, id }: { actions: ReportActions; id?: string }) {
  if (actions.none && actions.questions.length === 0) {
    return (
      <ReportCard id={id} kind="action" label="What I need from you">
        <div className={cn('grid grid-cols-1 gap-1 rounded-md bg-success/15 px-3.5 py-3 text-sm text-success')}>
          <b className="text-[11px] font-bold uppercase tracking-wide">No action needed</b>
          <span>{actions.fyi || 'For your information only.'}</span>
        </div>
      </ReportCard>
    );
  }

  const questionIds = actions.questions.map((q) => q.id);

  return (
    <ReportCard id={id} kind="action" label="What I need from you">
      <div className="grid grid-cols-1 gap-4">
        {actions.questions.map((q, i) =>
          q.live ? (
            <QuestionChips key={q.id} question={q} index={i + 1} />
          ) : (
            <ResolvedQuestion key={q.id} question={q} index={i + 1} />
          ),
        )}
      </div>
      <ReplyRow questionIds={questionIds} />
    </ReportCard>
  );
}
