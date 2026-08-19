/**
 * Sending an answer, rather than copying it (bw-7ks.21.5).
 *
 * A report ends in a question, and until now the manager's answer left the
 * page as text on the clipboard: he pasted it onto the card, or into the chat,
 * or it stopped at the clipboard and the work waited on an answer that had been
 * given. Here the answer goes where it belongs by itself — a comment on the
 * card the question is holding up, and a message to every chat the board says
 * has worked on that card.
 *
 * Two records, deliberately. The card is the one that lasts: it is read by
 * whoever picks the work up next, whether or not the chat that asked is still
 * alive. The chat is the one that acts: `send` wakes a sleeping conversation
 * (`workbench/src/sessions.ts`), so an answer reaches the agent that was
 * waiting for it without the manager going looking for the window.
 *
 * The board's own join names the chats (`GET /links/bead/:id`), never our
 * cache — the same read the links rail and the card panel already do.
 */
import { bd } from '@/lib/api';
import { apiUrl } from '@/lib/api-base';
import type { LinkedChat } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

import type { ReportQuestion } from './types';

/** One question the manager has actually picked an answer to. */
export interface Answered {
  question: ReportQuestion;
  /** The words the picked option says, as the reply preview shows them. */
  say: string;
  /** The card this question is holding up — where the answer is written down. */
  card: string;
}

export interface SentTo {
  comments: { card: string; ok: boolean; error?: string }[];
  chats: { sessionId: string; title: string | null; ok: boolean; error?: string }[];
}

/**
 * The questions still live, that have been answered and name a card.
 *
 * A question with no card cannot be posted anywhere — the answer would have
 * nowhere to land — so it stays in the copied line and out of this.
 */
export function answeredFrom(
  questions: ReportQuestion[],
  answerFor: (id: string) => string | undefined,
): Answered[] {
  const out: Answered[] = [];
  for (const question of questions) {
    if (!question.live) continue;
    const say = answerFor(question.id);
    if (!say) continue;
    const card = question.card?.id ?? question.holds;
    if (!card) continue;
    out.push({ question, say, card });
  }
  return out;
}

/** The question above the answer, so neither is read without the other. */
function quoted(a: Answered): string {
  return `> ${a.question.ask}\n\n${a.say}`;
}

/** What goes on the card: this one question, and where the answer came from. */
export function commentText(reportTitle: string, a: Answered): string {
  return `Answered from the report "${reportTitle}":\n\n${quoted(a)}`;
}

/**
 * What goes to the chat: every answer at once, in the order the report asks
 * them, since one message is one turn of the conversation.
 */
export function chatText(reportTitle: string, answers: Answered[]): string {
  const head = `Answering the report "${reportTitle}":`;
  return [head, ...answers.map((a) => `${quoted(a)}\n\n(${a.card})`)].join('\n\n');
}

/** The cards these answers touch, each named once. */
export function cardsOf(answers: Answered[]): string[] {
  return Array.from(new Set(answers.map((a) => a.card)));
}

/**
 * Every chat the board says has worked on these cards.
 *
 * One call per card, as that route answers for one card at a time; a chat that
 * touched two of them is listed once.
 */
export async function chatsFor(cards: string[], projectPath: string): Promise<LinkedChat[]> {
  const q = new URLSearchParams({ path: projectPath });
  const lists = await Promise.all(
    cards.map((id) =>
      fetch(apiUrl(`/api/workbench/links/bead/${encodeURIComponent(id)}?${q}`))
        .then((r) => (r.ok ? (r.json() as Promise<LinkedChat[]>) : []))
        .catch(() => [] as LinkedChat[]),
    ),
  );
  const bySession = new Map<string, LinkedChat>();
  for (const list of lists) for (const c of list) bySession.set(c.sessionId, c);
  return Array.from(bySession.values());
}

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Posts the answers. The board first — it is the record — then the chats, so a
 * chat that refuses to wake never costs the card its comment.
 *
 * Nothing here throws: every target reports its own outcome, because a report
 * answering three cards must say which of them took it.
 */
export async function sendAnswers(
  reportTitle: string,
  answers: Answered[],
  chats: LinkedChat[],
  projectPath: string,
): Promise<SentTo> {
  const sent: SentTo = { comments: [], chats: [] };

  for (const a of answers) {
    try {
      const res = await bd.command(['comment', a.card, commentText(reportTitle, a)], projectPath);
      sent.comments.push(
        res.code === 0
          ? { card: a.card, ok: true }
          : { card: a.card, ok: false, error: (res.stderr || res.stdout || `bd exited ${res.code}`).trim() },
      );
    } catch (e) {
      sent.comments.push({ card: a.card, ok: false, error: why(e) });
    }
  }

  const text = chatText(reportTitle, answers);
  for (const chat of chats) {
    try {
      await sendCommand({ type: 'prompt.send', sessionId: chat.sessionId, text });
      sent.chats.push({ sessionId: chat.sessionId, title: chat.title, ok: true });
    } catch (e) {
      sent.chats.push({ sessionId: chat.sessionId, title: chat.title, ok: false, error: why(e) });
    }
  }

  return sent;
}

/** One line saying where the answer got to, for the reader who just sent it. */
export function saidWhere(sent: SentTo): string {
  const cards = sent.comments.filter((c) => c.ok).length;
  const chats = sent.chats.filter((c) => c.ok).length;
  const failed = [...sent.comments, ...sent.chats].filter((t) => !t.ok);
  const parts: string[] = [];
  if (cards > 0) parts.push(cards === 1 ? 'Written on the card' : `Written on ${cards} cards`);
  if (chats > 0) parts.push(chats === 1 ? 'sent to the chat working it' : `sent to ${chats} chats`);
  const said = parts.length ? `${parts.join(' and ')}.` : 'Nothing took it.';
  if (!failed.length) return said;
  const trouble = failed.map(
    (t) => `${'card' in t ? t.card : (t.title ?? t.sessionId.slice(0, 8))}: ${t.error ?? 'refused'}`,
  );
  return `${said} Not everywhere — ${trouble.join('; ')}`;
}
