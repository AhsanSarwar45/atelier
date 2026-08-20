/**
 * One row of a conversation, and everything a row is made of.
 *
 * Every row remembers itself. A conversation of two hundred messages redrew all
 * two hundred whenever one word arrived — each one's markdown parsed again, each
 * one's code coloured again, each diff worked out again — because the rows were
 * built inline in the chat and shared its every pass. Held apart and remembered
 * against their own item, only the row that changed is built again; the fold in
 * use-session.ts keeps every untouched item's identity, which is what makes that
 * true (bw-uiyz.5).
 *
 * Design: docs/agent-workbench.md §8.2.
 */
'use client';

import { memo, useEffect, useReducer, useState } from 'react';

import { Brain, ChevronRight, Hand, Loader2 } from 'lucide-react';

import { MarkdownBody, type Mentions } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import { languageOf, languagesOf, paint, paintLines } from '@/workbench/colouring';
import { diffLines } from '@/workbench/line-diff';
import { lookOf, markOf, opensOn, saidBy, type MachineRow } from '@/workbench/machine-lines';
import type { AskOption, ImagePayload } from '@/workbench/protocol';
import { ReportCard } from '@/workbench/report-view';
import { sendCommand, type TranscriptItem } from '@/workbench/use-session';

/** One permission card. Collapses to its answer once the human has clicked. */
export const PermissionCard = memo(function PermissionCard({
  sessionId,
  askId,
  title,
  toolName,
  options,
  chosen,
}: {
  sessionId: string;
  askId: string;
  title: string;
  toolName: string;
  options: AskOption[];
  chosen: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);

  if (chosen) {
    const answered = chosen === 'deny' ? 'Denied' : 'Allowed';
    return (
      <Panel
        data-testid="permission-card"
        data-ask-state="resolved"
        data-ask-id={askId}
        data-tool-name={toolName}
        className="text-sm text-muted-foreground"
      >
        <span data-testid="permission-resolved" className="font-medium text-foreground">
          {answered}
        </span>
        {' · '}
        {title}
      </Panel>
    );
  }

  return (
    <Panel
      tone="attention"
      inset="md"
      data-testid="permission-card"
      data-ask-state="open"
      data-ask-id={askId}
      data-tool-name={toolName}
    >
      <div className="text-sm font-medium text-foreground">Allow {toolName}?</div>
      <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{title}</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => (
          <Button
            key={o.id}
            size="sm"
            variant={o.kind === 'deny' ? 'outline' : o.kind === 'allow_always' ? 'secondary' : 'primary'}
            disabled={pending !== null}
            data-testid={`permission-${o.id}`}
            onClick={() => {
              setPending(o.id);
              void sendCommand({ type: 'ask.answer', sessionId, askId, optionId: o.id }).catch(() =>
                setPending(null),
              );
            }}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </Panel>
  );
});

/**
 * One line of code, coloured, inside a cell that carries its own background.
 *
 * Each line lives in its own table cell, so the colour has to arrive already
 * cut into lines. `html` is that cut piece, painted from the whole file so a
 * comment or a string running over several lines stays itself all the way down
 * (bw-4wcd.16); leave it out and the line is painted alone, which is right for
 * a line that never had a file around it.
 */
function Line({ text, language, html }: { text: string; language: string | null; html?: string | null }) {
  const painted = html === undefined ? paint(text, language) : html;
  if (painted === null || painted === undefined) return <>{text}</>;
  return <span dangerouslySetInnerHTML={{ __html: painted }} />;
}

/**
 * Before and after in two columns, with only the lines that differ marked, and
 * the language of the file itself coloured through both of them (bw-4wcd.1).
 */
function DiffView({ path, before, after }: { path: string; before: string; after: string }) {
  const rows = diffLines(before, after);
  const language = languageOf(path);
  // Each side is coloured whole and only then cut into its rows: painting a
  // row on its own left the inside of every block comment and every long
  // string read as fresh code (bw-4wcd.16). `diffLines` drops one trailing
  // newline before it splits, so the same text is painted here.
  const leftLines = paintLines(before.replace(/\n$/, ''), language);
  const rightLines = paintLines(after.replace(/\n$/, ''), language);
  let li = 0;
  let ri = 0;
  const painted = rows.map((r) => {
    const cell = {
      left: r.left === null || leftLines === null ? null : (leftLines[li] ?? null),
      right: r.right === null || rightLines === null ? null : (rightLines[ri] ?? null),
    };
    if (r.left !== null) li++;
    if (r.right !== null) ri++;
    return cell;
  });
  return (
    <div data-testid="diff-view" data-diff-path={path} data-diff-language={language ?? ''} className="mt-1.5 overflow-hidden rounded border border-border/50">
      <div className="flex items-center justify-between bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{path}</span>
        <span className="shrink-0">before → after</span>
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full table-fixed border-collapse font-mono text-[11px] leading-relaxed text-foreground/80">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-diff-kind={r.kind}>
                <td
                  className={cn(
                    'w-1/2 whitespace-pre-wrap break-all border-r border-border/40 px-2 py-0.5 align-top',
                    r.kind === 'removed' || r.kind === 'changed' ? 'bg-red-500/15' : '',
                    r.left === null && 'bg-muted/20',
                  )}
                >
                  {r.left === null ? '' : <Line text={r.left} language={language} html={painted[i]!.left} />}
                </td>
                <td
                  className={cn(
                    'w-1/2 whitespace-pre-wrap break-all px-2 py-0.5 align-top',
                    r.kind === 'added' || r.kind === 'changed' ? 'bg-emerald-500/15' : '',
                    r.right === null && 'bg-muted/20',
                  )}
                >
                  {r.right === null ? '' : <Line text={r.right} language={language} html={painted[i]!.right} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * What a command was asked to do, and what it printed.
 *
 * Cut to a height a reader can skim past, scrolling inside itself rather than
 * pushing the conversation off the screen.
 */
function Body({
  label,
  text,
  testId,
  language = null,
}: {
  label: string;
  text: string;
  testId: string;
  /** What to colour it as, when this body is code and we know which (§8.2.4). */
  language?: string | null;
}) {
  if (!text.trim()) return null;
  return (
    <div className="mt-1">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</div>
      {/* The frame is the Panel's; the text inside carries no edge of its own,
          and scrolls within it so a long output cannot push the conversation
          off the screen. */}
      <Panel inset="none" className="max-h-72 overflow-auto">
        <pre
          data-testid={testId}
          data-language={language ?? ''}
          className={cn(
            'whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-xs leading-relaxed',
            language ? 'text-foreground/85' : 'text-muted-foreground',
          )}
        >
          <Numbered text={text} language={language} />
        </pre>
      </Panel>
    </div>
  );
}

/**
 * A body's text, coloured, keeping the line numbers a file read hands back.
 *
 * The kit returns a file the way `cat -n` does — the number, a tab, the line —
 * and colouring that whole thing paints every line number as a number literal.
 * The numbers are lifted out, drawn grey, and only the code is painted
 * (bw-4wcd.2).
 */
function Numbered({ text, language }: { text: string; language: string | null }) {
  const lines = text.split('\n');
  const numbered = lines.filter((l) => /^\s*\d+\t/.test(l)).length;
  if (!language) return <>{text}</>;
  if (numbered < lines.length / 2) {
    const html = paint(text, language);
    return html === null ? <>{text}</> : <span dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // The numbers off, the file put back together, coloured as one thing and
  // then cut again — otherwise every line is read as if it were the first
  // (bw-4wcd.16).
  const code = lines.map((line) => (line.includes('\t') ? line.slice(line.indexOf('\t') + 1) : line));
  const painted = paintLines(code.join('\n'), language);
  return (
    <>
      {lines.map((line, i) => {
        const at = line.indexOf('\t');
        const gutter = at >= 0 ? line.slice(0, at) : '';
        return (
          <span key={i} data-testid="numbered-line">
            {at >= 0 && <span className="select-none text-muted-foreground/50">{gutter}{'\t'}</span>}
            <Line text={code[i]!} language={language} html={painted === null ? null : (painted[i] ?? null)} />
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </>
  );
}

/**
 * What a command was asked to do, written out to be read.
 *
 * As JSON it was one escaped line — every newline in a file the agent wrote
 * came back as a literal backslash-n, so the one row a reader most wants to
 * read was the one they could not (bw-1u1.33). Each argument gets its own
 * heading and its value beneath it, whole lines intact.
 */
function whatItWasAsked(input: Record<string, unknown>): string {
  const entries = Object.entries(input ?? {});
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      const written = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      // On one line when it fits there, which is most of them: a path, a flag,
      // a short command.
      return written.includes('\n') ? `${key}:\n${written}` : `${key}: ${written}`;
    })
    .join('\n');
}

/**
 * Whether one row is open: the reader's own click, until the control that opens
 * everything moves — which then wins, in both directions.
 *
 * A hand-opened row used to pin itself for good, so "show less" stopped reaching
 * it and did not show less (bw-1u1.24). The last position of the control is kept
 * rather than watched with an effect, so the row is right on the render that
 * shows it, never one frame late.
 */
export function useOpen(openAll: boolean): [boolean, (open: boolean) => void] {
  const [byHand, setByHand] = useState<boolean | null>(null);
  const [lastAll, setLastAll] = useState(openAll);
  if (lastAll !== openAll) {
    setLastAll(openAll);
    setByHand(null);
  }
  return [byHand ?? openAll, setByHand];
}

/**
 * One command, and everything it did behind a click.
 *
 * The output has always crossed the wire and was thrown away in the browser, so
 * a command could be seen running and never read — the manager's "i don't get
 * output in chat for that" (bw-1u1, docs/agent-workbench.md §8.2.4).
 */
/**
 * The mark every row a SENT-OFF agent produced carries: stepped in, with a line
 * down its left. One constant for the three kinds of row it can be — a command,
 * a sentence, a thought — because a helper's work reading as one block is the
 * whole point, and three hand-written indents drift (bw-7ks.22.2).
 */
export const SENT_OFF = 'ml-6 border-l-2 border-violet-500/50 pl-3';

export const ToolRow = memo(function ToolRow({
  item,
  nested,
  openAll,
}: {
  item: Extract<TranscriptItem, { kind: 'tool' }>;
  nested: boolean;
  openAll: boolean;
}) {
  const [open, setOpen] = useOpen(openAll);
  const dot =
    item.status === 'running' ? 'bg-amber-400 animate-pulse' : item.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500';
  // A shell row's arguments ARE its command: written out as `key: value` it
  // read as a form rather than as the line that was run (bw-4wcd.2).
  const shell = item.name === 'Bash' && typeof item.input.command === 'string';
  const asked = shell ? String(item.input.command) : whatItWasAsked(item.input);
  const tongue = languagesOf(item.name, item.input);
  const hasBody = asked !== '' || Boolean(item.output?.trim());

  return (
    <div
      data-testid={nested ? 'subagent-tool-row' : 'tool-row'}
      // The call's own id, so a helper's words can be shown to hang off THIS
      // row rather than merely to be indented near it (bw-7ks.22.2).
      data-tool-id={item.id}
      data-tool-status={item.status}
      data-tool-name={item.name}
      data-open={open}
      className={cn(nested && SENT_OFF)}
    >
      <Panel inset="none" className="px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
        <button
          type="button"
          data-testid="tool-toggle"
          disabled={!hasBody}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-2 text-left enabled:hover:text-foreground"
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
          {hasBody && (
            <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          )}
          <span className="truncate">{item.title}</span>
          {/* How long it has been running, while it is running: a call that takes a
              minute must not look the same as one that took none. */}
          {item.status === 'running' && item.seconds > 0 && (
            <span data-testid="tool-elapsed" className="shrink-0 tabular-nums">
              {Math.round(item.seconds)}s
            </span>
          )}
          <span className="ml-auto shrink-0 uppercase tracking-wide">{item.status}</span>
        </button>
        {/* What the agent this call sent away is doing NOW, in its own words.
            Only while it is still going: once the call is over, what it did is
            in its answer and this line is a stale guess (bw-7ks.22.2). */}
        {item.summary && item.status === 'running' && (
          <p data-testid="tool-doing-now" className="truncate pl-4 pt-0.5 font-sans text-muted-foreground/80">
            {item.summary}
          </p>
        )}
        {open && (
          <>
            <Body label={shell ? 'ran' : 'asked'} text={asked} testId="tool-input" language={tongue.asked} />
            <Body label="printed" text={item.output ?? ''} testId="tool-output" language={tongue.printed} />
          </>
        )}
      </Panel>
      {item.diff && <DiffView path={item.diff.path} before={item.diff.before} after={item.diff.after} />}
    </div>
  );
});
/**
 * A line about the chat's own machinery: you stopped it, a busy service being
 * ridden out, the conversation folding itself up, a rule of yours refusing the
 * turn, an agent sent off, or a kind of message this app has no name for.
 *
 * It is punctuation, not a speaker: a small chip sitting centred on a hairline
 * rule, the way a date divider sits in a messaging app, so it separates what was
 * said instead of competing with it. Its colour and its mark come from the
 * family the kind belongs to (src/workbench/machine-lines.tsx), which is what
 * makes an interrupt and a routine status ping tell themselves apart at a
 * glance — they used to be the same grey line (bw-jkh2, §8.2.4).
 *
 * A run of one kind arrives folded, so the chip carries how many times it
 * happened and opening it gives every one of them in order.
 *
 * A folded row is built fresh on every pass, so remembering it against its own
 * identity would remember nothing; it is remembered against what it says
 * instead, which is what keeps a word arriving in a message from redrawing
 * every chip above it (bw-uiyz.5).
 */
export const MachineLine = memo(
  function MachineLine({ row, openAll }: { row: MachineRow; openAll: boolean }) {
    const [open, setOpen] = useOpen(openAll);
    const look = lookOf(row.family);
    const Mark = markOf(row.family);
    const opens = opensOn(row);

    return (
      <div
        data-testid="note-row"
        data-note-rank={row.rank}
        data-note-kind={row.kind}
        data-family={row.family}
        data-times={row.lines.length}
        className="flex flex-col items-center gap-1"
      >
        <div className="flex w-full items-center gap-2">
          <span className={cn('h-px min-w-4 flex-1', look.rule)} />
          {/* The app's own chip, dressed in the family's colours rather than
              redrawn: one set of parts (src/lib/__tests__/one-set-of-parts.test.ts). */}
          <Badge asChild size="md" shape="circle" className={cn('min-w-0 max-w-[80%] px-2.5', look.chip)}>
            <button
              type="button"
              data-testid="note-toggle"
              disabled={!opens}
              onClick={() => setOpen(!open)}
              // The brand's own name for it, so an unfamiliar line can be looked
              // up without spending room on the chip itself.
              title={row.kind}
              className="enabled:hover:brightness-125"
            >
              <Mark />
              <span className="truncate">{saidBy(row)}</span>
              {/* Eight retries is one thing that happened eight times. */}
              {row.lines.length > 1 && (
                <Badge size="xs" shape="circle" data-testid="note-times" className={cn('tabular-nums', look.count)}>
                  {row.lines.length}
                </Badge>
              )}
              {opens && <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />}
            </button>
          </Badge>
          <span className={cn('h-px min-w-4 flex-1', look.rule)} />
        </div>
        {open && (
          <div className="w-full">
            {row.lines.map((line, i) => (
              <Body
                key={i}
                label={row.lines.length > 1 ? `${row.kind} · ${i + 1} of ${row.lines.length}` : row.kind}
                text={line.body ?? line.text}
                testId="note-body"
              />
            ))}
          </div>
        )}
      </div>
    );
  },
  (before, now) => before.openAll === now.openAll && sameRow(before.row, now.row),
);

/** Whether two folded rows would draw the same chip over the same words. */
function sameRow(a: MachineRow, b: MachineRow): boolean {
  return (
    a.id === b.id &&
    a.family === b.family &&
    a.kind === b.kind &&
    a.rank === b.rank &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line.text === b.lines[i]?.text && line.body === b.lines[i]?.body)
  );
}
/**
 * What the agent worked out on the way to its answer.
 *
 * Dim and out of the way, because it is not the answer; open while it is being
 * written, because that is the only thing on the screen during a long think, and
 * shut once the answer starts (docs/agent-workbench.md §8.2.2).
 */
export const ThinkingBlock = memo(function ThinkingBlock({ item }: { item: Extract<TranscriptItem, { kind: 'thinking' }> }) {
  const [openedByHand, setOpenedByHand] = useState<boolean | null>(null);
  const open = openedByHand ?? !item.done;
  const firstLine = item.text.trim().split('\n')[0] ?? '';
  // Reasoning the brand withheld arrives as frames with no words: a heading with
  // nothing under it says less than nothing (bw-f1q.14).
  if (!item.text.trim()) return null;

  return (
    <div
      data-testid="thinking-block"
      data-done={item.done}
      data-sent-by={item.parentId ?? undefined}
      className={cn('text-sm', item.parentId !== null && SENT_OFF)}
    >
      <button
        type="button"
        data-testid="thinking-toggle"
        onClick={() => setOpenedByHand(!open)}
        className="flex w-full items-center gap-2 text-left text-xs uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{item.done ? 'Thought' : 'Thinking'}</span>
        {!open && <span className="truncate font-normal normal-case opacity-70">{firstLine}</span>}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-border/60 pl-3 italic leading-relaxed text-muted-foreground">
          {item.text}
        </div>
      )}
    </div>
  );
});
/**
 * The line at the foot of the transcript, present exactly while the agent owes
 * an answer: a moving mark, what it is doing in its own words, and how long it
 * has been at it. Before this the screen could sit unchanged for ten seconds of
 * work and look identical to a finished one (bw-f1q.3).
 *
 * The beat that moves the count lives HERE, not in the chat around it: elapsed
 * time changes with no event to announce it, and a beat one level up redrew
 * every message in the conversation once a second for the whole of a long run
 * (bw-uiyz.5). Only this line is worth a second of anyone's attention.
 */
export function WorkingLine({
  label,
  since,
  reported,
  waiting,
  thought,
}: {
  label: string;
  /** When the agent started owing an answer, or null when it owes none. */
  since: number | null;
  /** The brand's own count for the call it is running, in seconds. */
  reported: number;
  waiting: boolean;
  /** Thinking the brand did but withheld, as its own estimate of the size. */
  thought: number;
}) {
  const [, beat] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const timer = setInterval(beat, 1000);
    return () => clearInterval(timer);
  }, []);

  const counted = since ? Math.floor((Date.now() - since) / 1000) : 0;
  // The brand's own count for the call it names, and our own only when it has
  // not counted yet. Never the larger of the two: that is how one call's clock
  // ended up beside another call's name.
  const seconds = reported > 0 ? Math.round(reported) : counted;

  return (
    <div
      data-testid="working-line"
      data-seconds={seconds}
      data-waiting={waiting}
      className={cn('flex items-center gap-2 px-1 py-1 text-sm', waiting ? 'text-amber-400' : 'text-muted-foreground')}
    >
      {waiting ? (
        <Hand className="h-4 w-4 shrink-0 animate-pulse" aria-hidden="true" />
      ) : (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      )}
      {/* Waiting on him is not the agent working, and the line must not pretend
          otherwise — it is the one state where the screen is asking, not telling. */}
      <span className="min-w-0 truncate font-mono text-xs">
        {waiting ? `Waiting for you · ${label}` : label}
        {/* A think whose words are withheld still says how big it is getting —
            otherwise a two-minute think looks the same as a stuck one. */}
        {!waiting && thought > 0 ? ` · ~${Math.round(thought / 100) / 10}k thought` : ''}
      </span>
      <span data-testid="working-elapsed" className="shrink-0 font-mono text-xs tabular-nums opacity-70">
        {seconds}s
      </span>
    </div>
  );
}


/**
 * What was said, by him or by the agent.
 *
 * The costly one: every message is markdown, parsed and coloured and searched
 * for the cards and reports it names. Remembered against its own item, so a word
 * arriving into the message being written does not parse the two hundred before
 * it again (bw-uiyz.5).
 */
const MessageRow = memo(function MessageRow({
  item,
  mentions,
  onLook,
}: {
  item: Extract<TranscriptItem, { kind: 'message' }>;
  mentions: Mentions;
  onLook: (image: ImagePayload) => void;
}) {
  const sentBy = item.parentId;
  return (
    <div
      data-testid={item.role === 'assistant' ? 'assistant-message' : 'user-message'}
      // Which call this came from, when it came from a helper rather than from
      // the agent you are talking to (bw-7ks.22.2).
      data-sent-by={sentBy ?? undefined}
      // The answer takes the column; what he typed stays narrower and to
      // the right, which is what tells the two apart without a label.
      className={cn(
        'rounded-lg px-3 py-2 text-sm leading-relaxed',
        item.role === 'user'
          ? 'ml-auto max-w-[75ch] bg-primary/15 text-foreground'
          : 'w-full bg-muted/40 text-foreground',
        sentBy !== null && SENT_OFF,
      )}
    >
      {item.images.map((img, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          data-testid="message-image"
          src={img.dataUrl}
          alt={img.alt}
          title="Click to see it full size"
          onClick={() => onLook(img)}
          className="mb-2 max-h-64 max-w-full cursor-zoom-in rounded border border-border/60"
        />
      ))}
      <MarkdownBody className="text-sm" mentions={mentions}>
        {item.text}
      </MarkdownBody>
    </div>
  );
});

/**
 * One row of the conversation, whatever kind it is.
 *
 * The whole transcript goes through here, and here is where a row stops being
 * rebuilt for nothing: everything this takes is either the item itself — a fresh
 * object only when that item changed — or a value the chat holds still.
 */
export const TranscriptRow = memo(function TranscriptRow({
  item,
  openAll,
  sessionId,
  mentions,
  onLook,
}: {
  item: TranscriptItem;
  openAll: boolean;
  sessionId: string;
  mentions: Mentions;
  onLook: (image: ImagePayload) => void;
}) {
  switch (item.kind) {
    case 'tool':
      return <ToolRow item={item} nested={item.parentId !== null} openAll={openAll} />;
    case 'thinking':
      return <ThinkingBlock item={item} />;
    case 'report':
      return <ReportCard project={item.project} slug={item.slug} />;
    case 'ask':
      return (
        <PermissionCard
          sessionId={sessionId}
          askId={item.id}
          title={item.title}
          toolName={item.toolName}
          options={item.options}
          chosen={item.chosen}
        />
      );
    // Notes and asides never reach here: the chat folds them into machine lines
    // before it draws, which is the only shape they have.
    case 'note':
    case 'notice':
      return null;
    default:
      return <MessageRow item={item} mentions={mentions} onLook={onLook} />;
  }
});
