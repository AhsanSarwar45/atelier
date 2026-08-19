/**
 * "What I need from you" — the first fixed part. An FYI report shows a plain
 * no-action note (`blocks.py`/`build.py`'s `action_card`, the `none` branch);
 * otherwise each question is a numbered radiogroup of answer chips, defaulting
 * to whichever option carries `pick: true`, same as `aria-checked` does in the
 * reference. A question the board has already settled (`live: false`) loses
 * its chips — the answer stopped mattering, so nothing here should invite
 * picking one.
 *
 * The answer leaves the page from here too (bw-7ks.21.5): the reply row can
 * send it rather than only copy it, naming the card and the chats it is about
 * to reach before it reaches them. Where it goes and what it says are in
 * `../send-answer.ts`; whether it can go anywhere at all is `../delivery.tsx`.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

import { FileText, MessagesSquare } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import type { LinkedChat } from '@/workbench/protocol';

import { useDelivery } from '../delivery';
import { Gloss } from '../glossary';
import { ReportCard } from '../report-card';
import { useReply } from '../reply';
import { answeredFrom, cardsOf, chatsFor, saidWhere, sendAnswers, type SentTo } from '../send-answer';
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

/**
 * Where the answer is about to go, named before it goes there.
 *
 * Sending writes on the board and wakes a conversation, so the manager sees
 * both lists first and either sends or backs out. The chats are read when this
 * opens rather than when the report loads: a chat can start working the card
 * between the report being built and the answer being given.
 */
function ConfirmSend({
  cards,
  chats,
  loading,
  sending,
  onSend,
  onCancel,
}: {
  cards: string[];
  chats: LinkedChat[];
  loading: boolean;
  sending: boolean;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <Panel inset="md" data-testid="report-answer-confirm" className="grid grid-cols-1 gap-2">
      <p className="text-sm font-semibold text-t-primary">This answer goes to:</p>
      <ul className="grid grid-cols-1 gap-1 text-sm text-t-secondary">
        {cards.map((card) => (
          <li key={card} data-testid="report-answer-target-card" data-card-id={card} className="flex items-center gap-2">
            <FileText className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
            <span>
              A comment on <span className="font-mono">{card}</span>
            </span>
          </li>
        ))}
        {chats.map((chat) => (
          <li
            key={chat.sessionId}
            data-testid="report-answer-target-chat"
            data-session-id={chat.sessionId}
            className="flex min-w-0 items-center gap-2"
          >
            <MessagesSquare className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
            <span className="min-w-0 truncate">{chat.title ?? 'A chat that worked on it'}</span>
          </li>
        ))}
        {!loading && chats.length === 0 && (
          <li data-testid="report-answer-no-chat" className="text-t-muted">
            No chat has worked on these cards — the answer goes to the board only.
          </li>
        )}
        {loading && <li className="text-t-muted">Looking for the chats that worked on them…</li>}
      </ul>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="button" size="sm" variant="primary" data-testid="report-answer-confirm-send" disabled={sending} onClick={onSend}>
          {sending ? 'Sending…' : 'Send it'}
        </Button>
        <Button type="button" size="sm" variant="outline" data-testid="report-answer-cancel" disabled={sending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Panel>
  );
}

function ReplyRow({ questionIds, questions, reportTitle }: { questionIds: string[]; questions: ReportQuestion[]; reportTitle: string }) {
  const { replyText, answerFor } = useReply();
  const delivery = useDelivery();
  const [copied, setCopied] = useState(false);
  const text = replyText(questionIds);

  const answers = useMemo(() => answeredFrom(questions, answerFor), [questions, answerFor]);
  const cards = useMemo(() => cardsOf(answers), [answers]);

  const [stage, setStage] = useState<'idle' | 'confirm' | 'sending' | 'sent'>('idle');
  const [chats, setChats] = useState<LinkedChat[] | null>(null);
  const [sent, setSent] = useState<SentTo | null>(null);

  const ask = () => {
    if (!delivery) return;
    setStage('confirm');
    setChats(null);
    void chatsFor(cards, delivery.projectPath).then(setChats);
  };

  const send = async () => {
    if (!delivery) return;
    setStage('sending');
    const outcome = await sendAnswers(reportTitle, answers, chats ?? [], delivery.projectPath);
    setSent(outcome);
    setStage('sent');
  };

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
    <div className="flex flex-col gap-3 border-t border-b-subtle pt-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-h-5 flex-1 text-sm italic text-t-secondary">{text}</p>
        <div className="flex shrink-0 flex-wrap gap-2">
          {/*
            Sending is offered only where the answer has somewhere to go: a
            project's own screen supplies the directory, and a question with no
            card behind it can only ever be copied (bw-7ks.21.5).
          */}
          {delivery && (
            <Button
              type="button"
              size="sm"
              variant="primary"
              data-testid="report-answer-send"
              disabled={answers.length === 0 || stage === 'confirm' || stage === 'sending'}
              onClick={ask}
            >
              Send my answer
            </Button>
          )}
          <Button type="button" size="sm" variant={copied ? 'primary' : 'outline'} onClick={copy} className="shrink-0">
            {copied ? 'Copied — paste it in' : 'Copy my reply'}
          </Button>
        </div>
      </div>

      {(stage === 'confirm' || stage === 'sending') && (
        <ConfirmSend
          cards={cards}
          chats={chats ?? []}
          loading={chats === null}
          sending={stage === 'sending'}
          onSend={() => void send()}
          onCancel={() => setStage('idle')}
        />
      )}

      {stage === 'sent' && sent && (
        <p data-testid="report-answer-result" className="text-sm text-t-secondary">
          {saidWhere(sent)}
        </p>
      )}
    </div>
  );
}

export function ActionCard({ actions, id, reportTitle = 'this report' }: { actions: ReportActions; id?: string; reportTitle?: string }) {
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
      <ReplyRow questionIds={questionIds} questions={actions.questions} reportTitle={reportTitle} />
    </ReportCard>
  );
}
