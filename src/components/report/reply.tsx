/**
 * The reply the manager sends back, composed live from two different cards.
 *
 * `page.js`'s `reply()` walks the whole document for every checked answer
 * chip and every flagged override button, wherever on the page they sit —
 * an answer chip lives in "What I need from you", an override button lives
 * in "Decisions", and one line at the bottom of the questions card previews
 * both together. This context is that shared state, lifted above both cards
 * so either one can write to it and the preview can read all of it.
 */
'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ReplyState {
  /** The `say` text of the currently-picked option for a question, or undefined if none picked yet. */
  answerFor: (questionId: string) => string | undefined;
  pick: (questionId: string, say: string) => void;
  isOverridden: (decisionId: string) => boolean;
  toggleOverride: (decisionId: string) => void;
  /** The full composed reply, in document order: questions first, then a trailing "Change …" sentence. */
  replyText: (questionOrder: string[]) => string;
}

const ReplyContext = createContext<ReplyState | null>(null);

export function useReply(): ReplyState {
  const ctx = useContext(ReplyContext);
  if (!ctx) throw new Error('useReply must be used within a ReplyProvider');
  return ctx;
}

export function ReplyProvider({ children }: { children: ReactNode }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const answerFor = useCallback((questionId: string) => answers[questionId], [answers]);
  const pick = useCallback((questionId: string, say: string) => {
    setAnswers((a) => ({ ...a, [questionId]: say }));
  }, []);
  const isOverridden = useCallback((decisionId: string) => Boolean(overrides[decisionId]), [overrides]);
  const toggleOverride = useCallback((decisionId: string) => {
    setOverrides((o) => ({ ...o, [decisionId]: !o[decisionId] }));
  }, []);

  const replyText = useCallback(
    (questionOrder: string[]) => {
      const parts = questionOrder.map((id) => answers[id]).filter((s): s is string => Boolean(s));
      const flagged = Object.keys(overrides).filter((id) => overrides[id]);
      if (flagged.length) parts.push(`Change ${flagged.join(', ')}.`);
      return parts.join(' ');
    },
    [answers, overrides],
  );

  const value = useMemo(
    () => ({ answerFor, pick, isOverridden, toggleOverride, replyText }),
    [answerFor, pick, isOverridden, toggleOverride, replyText],
  );

  return <ReplyContext.Provider value={value}>{children}</ReplyContext.Provider>;
}
