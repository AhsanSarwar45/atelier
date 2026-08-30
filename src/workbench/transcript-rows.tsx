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

import { memo, useContext, useEffect, useReducer, useState, type ReactNode } from 'react';

import { request } from '@/lib/api';

import { Brain, Check, ChevronRight, Hand, Loader2 } from 'lucide-react';

import { MarkdownBody, type Mentions } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Doing } from '@/workbench/chat-state';
import { forHowLong } from '@/workbench/elapsed';
import { SUMMARY_HELD_AT, summaryFill } from '@/workbench/summarising';
import { languageOf, languagesOf, paint, paintLines } from '@/workbench/colouring';
import { diffLines } from '@/workbench/line-diff';
import { opensOn, saidBy, type MachineRow } from '@/workbench/machine-lines';
import { lookOf, markOf } from '@/workbench/machine-look';
import { PictureGrid } from '@/workbench/picture-grid';
import { withoutProposedPlans } from '@/workbench/proposed-plan';
import { ImageComparisonView } from '@/workbench/image-comparison';
import { comparisonSpecs } from '@/workbench/chat-media';
import { ChatWidgetView } from '@/workbench/chat-widget-view';
import { widgetSpecs } from '@/workbench/chat-widgets';
import { colourOfBand, lookOfRan, markOfRan } from '@/workbench/ran-look';
import { whatItRan, whileItRuns } from '@/workbench/said-what-it-ran';
import type { AskOption, ImagePayload, LookableImage } from '@/workbench/protocol';
import { Chipped, SplitPaths, withChips } from '@/workbench/split-paths';
import { PathChip } from '@/workbench/path-chip';
import { sendCommand, type TranscriptItem } from '@/workbench/use-session';

/**
 * One permission card. Collapses to its answer once the human has clicked.
 *
 * `sentBy` and `askedBy` are set when a SENT-OFF agent raised the question. The
 * card then says whose question it is, because a card that reads as the chat's
 * own when a helper raised it is asking the reader to allow something nobody in
 * front of them chose to do (docs/agent-workbench.md §8.2.7).
 */
export const PermissionCard = memo(function PermissionCard({
  sessionId,
  askId,
  title,
  toolName,
  options,
  question,
  allowText,
  secret,
  href,
  chosen,
  sentBy,
  askedBy,
}: {
  sessionId: string;
  askId: string;
  title: string;
  toolName: string;
  options: AskOption[];
  question?: boolean;
  allowText?: boolean;
  secret?: boolean;
  href?: string;
  chosen: string | null;
  sentBy?: string | null;
  askedBy?: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  // What it says about who is asking. A brief where the row had one, and the
  // plain fact where it did not: either way the reader is told this is not the
  // agent they are talking to.
  const raisedBy = sentBy ? askedBy || 'an agent this chat sent off' : null;

  if (chosen) {
    const answered = question ? 'Answered' : chosen === 'deny' ? 'Denied' : 'Allowed';
    return (
      <Panel
        data-testid="permission-card"
        data-ask-state="resolved"
        data-ask-id={askId}
        data-tool-name={toolName}
        data-sent-by={sentBy ?? undefined}
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
      data-sent-by={sentBy ?? undefined}
    >
      {raisedBy && (
        <div data-testid="permission-asked-by" className="mb-1 truncate text-xs text-muted-foreground" title={raisedBy}>
          Asked by {raisedBy}
        </div>
      )}
      <div className="text-sm font-medium text-foreground">{question ? toolName : `Allow ${toolName}?`}</div>
      <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{title}</div>
      {href && <a href={href} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-primary underline">Open {href}</a>}
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
        {allowText && (
          <form
            className="flex min-w-64 flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!answer.trim() || pending !== null) return;
              setPending('text');
              void sendCommand({ type: 'ask.answer', sessionId, askId, optionId: 'text', value: answer }).catch(() =>
                setPending(null),
              );
            }}
          >
            <Input
              type={secret ? 'password' : 'text'}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              disabled={pending !== null}
              aria-label="Answer"
              className="min-w-0 flex-1"
            />
            <Button type="submit" size="sm" disabled={!answer.trim() || pending !== null}>Answer</Button>
          </form>
        )}
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
  const split = useContext(SplitPaths);
  const found = html === undefined ? paint(text, language) : html;
  const painted = found === undefined ? null : withChips(found, split);
  if (painted === null) return <Chipped text={text} />;
  return <span dangerouslySetInnerHTML={{ __html: painted }} />;
}

/**
 * Before and after in two columns, with only the lines that differ marked, and
 * the language of the file itself coloured through both of them (bw-4wcd.1).
 */
function EditPath({ path, raw = path, line }: { path: string; raw?: string; line?: number }) {
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  return absolute ? (
    <PathChip absolute={path} raw={raw} line={line ?? null} target="editor" />
  ) : (
    <Chipped text={raw} line={line} target="editor" />
  );
}

function DiffView({ path, before, after, line }: { path: string; before: string; after: string; line?: number }) {
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
    <Panel
      tone="frame"
      inset="none"
      data-testid="diff-view"
      data-diff-path={path}
      data-diff-language={language ?? ''}
      className="mt-1.5 overflow-hidden"
    >
      <div className="flex items-center justify-between bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">
          <EditPath path={path} line={line} />
        </span>
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
    </Panel>
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
  const split = useContext(SplitPaths);
  const lines = text.split('\n');
  const numbered = lines.filter((l) => /^\s*\d+\t/.test(l)).length;
  if (!language) return <Chipped text={text} />;
  if (numbered < lines.length / 2) {
    const html = withChips(paint(text, language), split);
    return html === null ? <Chipped text={text} /> : <span dangerouslySetInnerHTML={{ __html: html }} />;
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
export function whatItWasAsked(input: Record<string, unknown>): string {
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
 * Whether one row is open. Closed until the reader opens it, and his click is
 * the only thing that decides — there is no longer a control that opens every
 * row at once, and what he does not want to read he switches off by name
 * (bw-jkh2.13).
 */
export function useOpen(): [boolean, (open: boolean) => void] {
  return useState(false);
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

/**
 * Whether a helper produced this row, from the call it says it came from.
 *
 * Asked loosely on purpose. A row folded from a chat's own record — and a row
 * that reached the browser in a frame an older sidecar wrote — carries no such
 * field at all rather than an empty one, and a strict `!== null` reads that
 * absence as a helper. Every message in the chat then wore the rail, and the
 * indent it adds beats the margin that holds the reader's own words to the
 * right, so his messages moved to the wrong end of the page (bw-jkh2.15).
 */
export const sentOff = (parentId: string | null | undefined): boolean => parentId != null;

export const ToolRow = memo(function ToolRow({
  item,
  nested,
  sessionId = '',
}: {
  item: Extract<TranscriptItem, { kind: 'tool' }>;
  nested: boolean;
  sessionId?: string;
}) {
  const [open, setOpen] = useOpen();
  const [detail, setDetail] = useState<Pick<typeof item, 'input' | 'output' | 'diff'> | null>(null);
  const shown = detail ? { ...item, ...detail } : item;
  const dot =
    item.status === 'running' ? 'bg-amber-400 animate-pulse' : item.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500';
  // A shell row's arguments ARE its command: written out as `key: value` it
  // read as a form rather than as the line that was run (bw-4wcd.2).
  const shell = shown.name === 'Bash' && typeof shown.input.command === 'string';
  const asked = shell ? String(shown.input.command) : whatItWasAsked(shown.input);
  const tongue = languagesOf(shown.name, shown.input);
  const hasBody = item.detailsDeferred || asked !== '' || Boolean(shown.output?.trim());
  // What the call did, said in English behind a mark for the kind of thing it
  // was. A command no rule knows keeps the words it was typed in, and that is
  // the only shell text left on a closed row (bw-7ks.24).
  // Paged transcripts intentionally defer command bodies. The server already
  // classified the bounded input before removing it, so recomputing from `{}`
  // would degrade a precise persisted title (for example "Waited for child")
  // to a generic one ("Waited for a helper") after reload.
  const ran = item.detailsDeferred && !detail && item.ranKind
    ? { said: item.title, kind: item.ranKind, grave: item.ranGrave ?? false }
    : whatItRan(shown.name, shown.input);
  const ranKind = ran?.kind ?? item.ranKind;
  const ranGrave = ran?.grave ?? item.ranGrave ?? false;
  const Mark = ranKind && markOfRan(ranKind);
  // A chain that deletes something is red whatever else it mostly did: the
  // sentence names the delete, and the mark must not say `test` in amber while
  // it does (bw-7ks.24.2).
  const mark = ranKind && (ranGrave ? colourOfBand('deleting') : lookOfRan(ranKind).mark);
  // The sentences are written for a finished row, so they are in the past. A
  // row with a spinner on it has not finished, and "Ran the tests" beside a
  // spinner says the opposite of the spinner (bw-7ks.24.6).
  const says = ran && (item.status === 'running' ? whileItRuns(ran.said) : ran.said);

  return (
    <div
      data-testid={nested ? 'subagent-tool-row' : 'tool-row'}
      // The call's own id, so a helper's words can be shown to hang off THIS
      // row rather than merely to be indented near it (bw-7ks.22.2).
      data-tool-id={item.id}
      data-tool-status={item.status}
      data-tool-name={item.name}
      data-actor-id={item.execution?.actorId}
      data-actor-name={item.execution?.actorName ?? undefined}
      data-conversation-id={item.execution?.conversationId}
      data-parent-agent-id={item.execution?.parentActorId ?? undefined}
      data-ran-kind={ranKind}
      data-ran-band={ranKind ? lookOfRan(ranKind).band : undefined}
      data-grave={ranGrave ? 'yes' : undefined}
      data-open={open}
      className={cn(nested && SENT_OFF)}
    >
      <Panel inset="none" className="px-2.5 py-1 font-mono text-xs text-muted-foreground md:py-1.5">
        <Button
          type="button"
          variant="foreground"
          size="xs"
          data-testid="tool-toggle"
          disabled={!hasBody}
          onClick={() => {
            const opening = !open;
            setOpen(opening);
            if (opening && item.detailsDeferred && !detail && sessionId) {
              void request(
                `/api/workbench/tool?session=${encodeURIComponent(sessionId)}&tool=${encodeURIComponent(item.id)}`,
              ).then(async (res) => {
                if (res.ok) setDetail((await res.json()) as Pick<typeof item, 'input' | 'output' | 'diff'>);
              });
            }
          }}
          className="h-auto w-full min-h-0 justify-start gap-2 rounded-none p-0 text-left font-mono font-normal enabled:hover:text-foreground"
        >
          <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} />
          {hasBody && (
            <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          )}
          {Mark && <Mark data-testid="tool-mark" className={cn('h-3 w-3 shrink-0', mark)} />}
          {/* The row's own line is where the reader sees an address most often
              — every command an agent runs opens with the folder it ran in — so
              the chips are here too, not only in the command behind the click.
              A span inside a button is fine; the conversation's own listener
              stops a chip's click reaching the toggle (bw-khe.13). */}
          <span className="relative top-px truncate">
            {ranKind === 'edit' && shown.diff?.path.startsWith('/') ? (
              <>
                Changed <EditPath path={shown.diff.path} raw={(says ?? item.title).replace(/^Changed\s+/, '')} line={shown.diff.line} />
              </>
            ) : (
              <Chipped text={says ?? item.title} />
            )}
          </span>
          {/* How long it has been running, while it is running: a call that takes a
              minute must not look the same as one that took none. */}
          {item.status === 'running' && item.seconds > 0 && (
            <span data-testid="tool-elapsed" className="shrink-0 tabular-nums">
              {forHowLong(item.seconds)}
            </span>
          )}
          <span className="ml-auto shrink-0 uppercase tracking-wide">{item.status}</span>
        </Button>
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
            <Body label="printed" text={shown.output ?? ''} testId="tool-output" language={tongue.printed} />
          </>
        )}
      </Panel>
      {shown.diff && (
        <DiffView
          path={shown.diff.path}
          before={shown.diff.before}
          after={shown.diff.after}
          line={shown.diff.line}
        />
      )}
    </div>
  );
});
/**
 * A line about the chat's own machinery: you stopped it, a busy service being
 * ridden out, the conversation folding itself up, a rule of yours refusing the
 * turn, an agent sent off, or a kind of message this app has no name for.
 *
 * It is a row of the same width and the same build as the commands around it,
 * in its family's colour (src/workbench/machine-lines.ts) — which is what makes
 * an interrupt and a routine status ping tell themselves apart at a glance;
 * they used to be the same grey line (bw-jkh2, §8.2.4). It was tried as a small
 * chip centred on a hairline rule, which read as punctuation between the rows
 * rather than as one of them and lost the transcript its one column
 * (bw-jkh2.17).
 *
 * A run of one kind arrives folded, so the row carries how many times it
 * happened and opening it gives every one of them in order.
 *
 * A folded row is built fresh on every pass, so remembering it against its own
 * identity would remember nothing; it is remembered against what it says
 * instead, which is what keeps a word arriving in a message from redrawing
 * every row above it (bw-uiyz.5).
 */
export const MachineLine = memo(
  function MachineLine({ row }: { row: MachineRow }) {
    const [open, setOpen] = useOpen();
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
        data-open={open}
      >
        <Panel inset="none" className={cn('px-2.5 py-1 font-mono text-xs md:py-1.5', look.row)}>
          <Button
            type="button"
            variant="foreground"
            size="xs"
            data-testid="note-toggle"
            disabled={!opens}
            onClick={() => setOpen(!open)}
            title={row.kind}
            className="h-auto w-full min-h-0 justify-start gap-2 rounded-none p-0 text-left font-mono font-normal enabled:hover:brightness-125"
          >
            <Mark className="h-3 w-3 shrink-0" />
            {opens && (
              <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
            )}
            <span className="truncate">{saidBy(row)}</span>
            {row.lines.length > 1 && (
              <Badge
                size="xs"
                shape="circle"
                data-testid="note-times"
                className={cn('shrink-0 tabular-nums', look.count)}
              >
                {row.lines.length}
              </Badge>
            )}
            {/* Where a command says OK or FAILED, this says which of the six it
                is — so the colour is never the only thing carrying it. */}
            <span className="ml-auto shrink-0 uppercase tracking-wide">{row.family}</span>
          </Button>
          {open &&
            row.lines.map((line, i) => (
              <Body
                key={i}
                label={row.lines.length > 1 ? `${row.kind} · ${i + 1} of ${row.lines.length}` : row.kind}
                text={line.body ?? line.text}
                testId="note-body"
              />
            ))}
        </Panel>
      </div>
    );
  },
  (before, now) => sameRow(before.row, now.row),
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
      className={cn('text-sm', sentOff(item.parentId) && SENT_OFF)}
    >
      <Button
        type="button"
        variant="foreground"
        size="xs"
        data-testid="thinking-toggle"
        onClick={() => setOpenedByHand(!open)}
        className="h-auto w-full min-h-0 justify-start gap-2 rounded-none p-0 text-left text-xs font-normal uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{item.done ? 'Thought' : 'Thinking'}</span>
        {!open && <span className="truncate font-normal normal-case opacity-70">{firstLine}</span>}
      </Button>
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
  detail,
  typicalMs,
  doing,
  since,
  turn,
  reported,
  waiting,
  thought,
}: {
  label: string;
  /**
   * What this particular one is, beside the label — the time a limit lifts, how
   * many helpers are out. Null when the state carries nothing beyond itself.
   */
  detail?: string | null;
  /**
   * What the bar fills against, in milliseconds. Null falls back to the median
   * measured across this whole machine (summarising.ts).
   */
  typicalMs?: number | null;
  /**
   * Which of the things a chat does this is. Only summarising draws a bar —
   * see summarising.ts for why it is the only state that can have one.
   */
  doing?: Doing;
  /** When the current step began, or null when nothing is owed. */
  since: number | null;
  /**
   * When the whole turn began, for the quieter number beside it, or null when
   * the step already says everything there is to say.
   */
  turn: number | null;
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
  // The whole answer's length, which used to be the only number here. It says
  // how long this has been going on; it cannot say whether anything is stuck,
  // so it stands behind the step rather than in front of it (bw-jaoz.14.4).
  const turnSeconds = turn ? Math.floor((Date.now() - turn) / 1000) : 0;
  // The one state whose end can be predicted, and the one state that writes
  // nothing at all while it runs, so the clock is otherwise all a reader has.
  const filling = doing === 'summarising' && since ? summaryFill(Date.now() - since, typicalMs ?? undefined) : null;

  const line = (
    <div
      data-testid="working-line"
      data-seconds={seconds}
      data-turn-seconds={turnSeconds > 0 ? turnSeconds : undefined}
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
        {/* The word says which of the things this is; this says which one of
            them. A chat that has stopped until a limit lifts is the case that
            makes it worth the room: "Retrying" on its own leaves the reader
            with no idea whether to wait (bw-jaoz.14.8). Dropped when it only
            repeats the label, which a call in flight can make it do. */}
        {detail && detail !== label ? ` · ${detail}` : ''}
        {/* A think whose words are withheld still says how big it is getting —
            otherwise a two-minute think looks the same as a stuck one. */}
        {!waiting && thought > 0 ? ` · ~${Math.round(thought / 100) / 10}k thought` : ''}
      </span>
      <span data-testid="working-elapsed" className="shrink-0 font-mono text-xs tabular-nums opacity-70">
        {forHowLong(seconds)}
      </span>
      {/* Half the weight of the step beside it, because it answers the second
          question and not the one the spinner is watched for. */}
      {turnSeconds > 0 && (
        <span
          data-testid="working-turn"
          title="Turn duration"
          className="shrink-0 font-mono text-xs tabular-nums opacity-40"
        >
          {forHowLong(turnSeconds)} turn
        </span>
      )}
    </div>
  );

  if (filling === null) return line;

  // Held at the far end and still going: the estimate was a median, so half of
  // all runs get here. The bar stops claiming progress it cannot see and says
  // only that it is still going.
  const held = filling >= SUMMARY_HELD_AT;
  return (
    <div className="flex flex-col gap-1">
      {line}
      <div
        data-testid="summarising-bar"
        data-fill={Math.round(filling * 100)}
        data-held={held}
        role="progressbar"
        aria-label="Compaction progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(filling * 100)}
        // Compact, which is what he asked for: a bar the width of the words
        // above it reads as a bar. Stretched across the whole transcript it
        // read as a hairline rule under the line, and a rule is not a
        // measurement of anything.
        className="mx-1 h-1 w-40 max-w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn('h-full rounded-full bg-primary transition-[width] duration-1000 ease-linear', held && 'animate-pulse')}
          style={{ width: `${filling * 100}%` }}
        />
      </div>
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
  onLook: (image: LookableImage) => void;
}) {
  const sentBy = item.parentId;
  return (
    <div
      data-testid={item.role === 'assistant' ? 'assistant-message' : 'user-message'}
      // Which call this came from, when it came from a helper rather than from
      // the agent you are talking to (bw-7ks.22.2).
      data-sent-by={sentBy ?? undefined}
      data-actor-id={item.execution?.actorId}
      data-actor-name={item.execution?.actorName ?? undefined}
      data-conversation-id={item.execution?.conversationId}
      data-parent-agent-id={item.execution?.parentActorId ?? undefined}
      // The answer takes the column; what he typed stays narrower and to
      // the right, which is what tells the two apart without a label.
      //
      // Each also wears an edge in its own colour, and the two sit on opposite
      // sides — his on the left, the agent's on the right. A conversation is
      // mostly commands, and a tint alone did not carry far enough down a page
      // of them to find a sentence by; the edge is what makes a message findable
      // at a scroll's speed (bw-jkh2.16, bw-jkh2.18). The violet rail is not
      // used here: it means a HELPER wrote the row, and it wins over the
      // speaker's own edge when both are true.
      //
      // The agent's side takes the column by being left to fill it, never by
      // being told to be the whole of it: a width of 100% is measured from the
      // frame, not from where the message actually starts, so a helper's
      // message — which is indented under the call that sent it — reached past
      // the right edge by exactly that indent and gave the whole conversation a
      // sideways scrollbar (bw-n6yh.14).
      className={cn(
        'rounded-lg px-3 py-2 text-sm leading-relaxed',
        item.role === 'user'
          ? 'ml-auto max-w-[75ch] border-l-2 border-primary/70 bg-primary/15 text-foreground'
          : 'border-r-2 border-muted-foreground/40 bg-muted/40 text-foreground',
        sentOff(sentBy) && SENT_OFF,
      )}
    >
      <PictureGrid images={item.images} onLook={onLook} />
      <RichMessageContent item={item} mentions={mentions} onLook={onLook} />
    </div>
  );
});

const RICH_BLOCK = /```(atelier-widget|atelier-image-compare)\s*\n([\s\S]*?)\n```/g;

/** Keeps a rich block where it was written instead of hoisting every visual above the prose. */
function RichMessageContent({ item, mentions, onLook }: {
  item: Extract<TranscriptItem, { kind: 'message' }>;
  mentions: Mentions;
  onLook: (image: LookableImage) => void;
}) {
  const parts: ReactNode[] = [];
  const comparisons = item.comparisons ?? [];
  const widgets = item.widgets ?? [];
  let comparisonIndex = 0;
  let widgetIndex = 0;
  let textAt = 0;
  let part = 0;
  const blocks = new RegExp(RICH_BLOCK.source, RICH_BLOCK.flags);
  let match: RegExpExecArray | null;

  const words = (text: string) => {
    if (text) parts.push(<MarkdownBody key={`words-${part++}`} className="text-sm" mentions={mentions}>{text}</MarkdownBody>);
  };

  const visibleText = withoutProposedPlans(item.text);
  while ((match = blocks.exec(visibleText)) !== null) {
    words(visibleText.slice(textAt, match.index));
    const source = match[0];
    if (match[1] === 'atelier-widget' && widgetSpecs(source).length > 0 && widgets[widgetIndex]) {
      parts.push(<ChatWidgetView key={`widget-${part++}`} widget={widgets[widgetIndex++]!} />);
    } else if (match[1] === 'atelier-image-compare' && comparisonSpecs(source).length > 0 && comparisons[comparisonIndex]) {
      parts.push(<ImageComparisonView key={`comparison-${part++}`} comparison={comparisons[comparisonIndex++]!} onLook={onLook} />);
    } else {
      words(source);
    }
    textAt = blocks.lastIndex;
  }
  words(visibleText.slice(textAt));
  return <>{parts}</>;
}

export const PlanProposalCard = memo(function PlanProposalCard({
  item,
  sessionId,
}: {
  item: Extract<TranscriptItem, { kind: 'plan' }>;
  sessionId: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const action = item.actions.find((candidate) => candidate.id === selected) ?? null;

  if (item.status !== 'proposed') {
    const resolved = item.actions.find((candidate) => candidate.id === item.actionId);
    return (
      <Panel data-testid="plan-card" data-plan-state={item.status} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">Proposed plan</span>
          <Badge variant="secondary">{item.status === 'changes_requested' ? 'Changes requested' : item.status}</Badge>
        </div>
        <MarkdownBody className="text-sm">{item.markdown}</MarkdownBody>
        <div className="text-xs text-muted-foreground">{resolved?.label ?? item.actionId}</div>
      </Panel>
    );
  }

  return (
    <Panel tone="attention" inset="md" data-testid="plan-card" data-plan-state="proposed">
      <div className="text-sm font-medium text-foreground">Proposed plan</div>
      <Panel inset="md" className="mt-3 bg-background/50">
        <MarkdownBody className="text-sm">{item.markdown}</MarkdownBody>
      </Panel>
      <div className="mt-3 grid gap-2">
        {item.actions.map((candidate) => (
          <Button
            key={candidate.id}
            type="button"
            variant="outline"
            className={cn(
              'h-auto w-full justify-start px-3 py-2 text-left',
              selected === candidate.id && 'border-primary bg-primary/10',
            )}
            aria-pressed={selected === candidate.id}
            onClick={() => setSelected(candidate.id)}
          >
            <span className="flex min-w-0 flex-col items-start">
              <span className="text-sm font-medium text-foreground">{candidate.label}</span>
              {candidate.description && <span className="mt-0.5 text-xs font-normal text-muted-foreground">{candidate.description}</span>}
            </span>
          </Button>
        ))}
      </div>
      {action?.acceptsFeedback && (
        <Textarea
          className="mt-3 min-h-24"
          aria-label="Requested plan changes"
          placeholder="Describe what should change"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
      )}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={!action || pending || (action.acceptsFeedback === true && !feedback.trim())}
          onClick={() => {
            if (!action) return;
            setPending(true);
            void sendCommand({
              type: 'plan.respond', sessionId, proposalId: item.id,
              response: { actionId: action.id, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) },
            }).catch(() => setPending(false));
          }}
        >
          {pending ? 'Sending…' : 'Continue'}
        </Button>
      </div>
    </Panel>
  );
});

interface DraftQuestionAnswer {
  optionIds: string[];
  custom: boolean;
  customText: string;
  note: string;
  noteOpen: boolean;
}

export const QuestionCard = memo(function QuestionCard({
  item,
  sessionId,
}: {
  item: Extract<TranscriptItem, { kind: 'question' }>;
  sessionId: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, DraftQuestionAnswer>>(() => Object.fromEntries(
    item.questions.map((question) => [question.id, {
      optionIds: [], custom: question.selection === 'text', customText: '', note: '', noteOpen: false,
    }]),
  ));
  const [pending, setPending] = useState(false);
  const change = (questionId: string, update: (draft: DraftQuestionAnswer) => DraftQuestionAnswer) => {
    setDrafts((current) => ({ ...current, [questionId]: update(current[questionId]!) }));
  };
  const complete = item.questions.every((question) => {
    const draft = drafts[question.id]!;
    if (question.selection === 'text') return Boolean(draft.customText.trim());
    if (draft.custom && !draft.customText.trim()) return false;
    return draft.optionIds.length > 0 || (draft.custom && Boolean(draft.customText.trim()));
  });

  if (item.answers) {
    return (
      <Panel data-testid="question-card" data-question-state="resolved" className="space-y-2">
        <div className="text-sm font-medium text-foreground">Answered</div>
        {item.questions.map((question) => {
          const answer = item.answers!.find((candidate) => candidate.questionId === question.id);
          const labels = answer?.optionIds.map((id) => question.options.find((option) => option.id === id)?.label ?? id) ?? [];
          if (answer?.customText) labels.push(question.secret ? '••••••••' : answer.customText);
          return (
            <div key={question.id} className="text-sm">
              <span className="font-medium text-foreground">{question.header}</span>
              <span className="text-muted-foreground"> · {labels.join(', ')}</span>
            </div>
          );
        })}
      </Panel>
    );
  }

  return (
    <Panel tone="attention" inset="md" data-testid="question-card" data-question-state="open">
      <div className="space-y-6">
        {item.questions.map((question) => {
          const draft = drafts[question.id]!;
          const choose = (optionId: string) => change(question.id, (current) => {
            const selected = current.optionIds.includes(optionId);
            return {
              ...current,
              optionIds: selected ? current.optionIds.filter((id) => id !== optionId)
                : question.selection === 'single' ? [optionId] : [...current.optionIds, optionId],
              ...(question.selection === 'single' && !selected ? { custom: false } : {}),
            };
          });
          return (
            <fieldset key={question.id} className="min-w-0">
              <legend className="text-sm font-semibold text-foreground">{question.header}</legend>
              <div className="mt-1 text-sm text-muted-foreground">{question.prompt}</div>
              {question.selection !== 'text' && (
                <div className="mt-3 grid gap-2">
                  {question.options.map((option) => {
                    const selected = draft.optionIds.includes(option.id);
                    return (
                      <label key={option.id} className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5',
                        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
                      )}>
                        <Checkbox
                          className="mt-0.5"
                          checked={selected}
                          onCheckedChange={() => choose(option.id)}
                          aria-label={option.label}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-foreground">{option.label}</span>
                          {option.description && <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>}
                          {option.preview && (
                            <details className="mt-2 text-xs" onClick={(event) => event.stopPropagation()}>
                              <summary className="cursor-pointer text-primary">Preview</summary>
                              <MarkdownBody className="mt-2 text-xs">{option.preview}</MarkdownBody>
                            </details>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {(question.allowCustom || question.selection === 'text') && (
                <Panel inset="sm" className={cn(
                  'mt-2 flex items-start gap-3 py-2.5',
                  draft.custom && 'border-primary bg-primary/10',
                )}>
                  {question.selection !== 'text' && (
                    <Checkbox
                      className="mt-0.5"
                      checked={draft.custom}
                      aria-label="Custom answer"
                      onCheckedChange={(checked) => change(question.id, (current) => ({
                        ...current, custom: checked === true,
                        ...(question.selection === 'single' && !current.custom ? { optionIds: [] } : {}),
                      }))}
                    />
                  )}
                  <Input
                    type={question.secret ? 'password' : 'text'}
                    aria-label={question.selection === 'text' ? 'Answer' : 'Custom answer text'}
                    placeholder={question.selection === 'text' ? 'Type your answer' : 'Something else…'}
                    value={draft.customText}
                    onChange={(event) => change(question.id, (current) => ({
                      ...current, custom: true, customText: event.target.value,
                      ...(question.selection === 'single' ? { optionIds: [] } : {}),
                    }))}
                  />
                </Panel>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-1 text-xs text-muted-foreground"
                onClick={() => change(question.id, (current) => ({ ...current, noteOpen: !current.noteOpen }))}
              >
                {draft.noteOpen ? 'Hide note' : 'Add note'}
              </Button>
              {draft.noteOpen && (
                <Textarea
                  className="mt-2 min-h-20"
                  aria-label={`Note for ${question.header}`}
                  placeholder="Optional context for this answer"
                  value={draft.note}
                  onChange={(event) => change(question.id, (current) => ({ ...current, note: event.target.value }))}
                />
              )}
            </fieldset>
          );
        })}
      </div>
      <div className="mt-5 flex justify-end">
        <Button
          size="sm"
          disabled={!complete || pending}
          onClick={() => {
            setPending(true);
            void sendCommand({
              type: 'question.answer', sessionId, requestId: item.id,
              response: { answers: item.questions.map((question) => {
                const draft = drafts[question.id]!;
                return {
                  questionId: question.id, optionIds: draft.optionIds,
                  ...(draft.custom && draft.customText.trim() ? { customText: draft.customText.trim() } : {}),
                  ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
                };
              }) },
            }).catch(() => setPending(false));
          }}
        >
          {pending ? 'Sending…' : 'Answer'}
        </Button>
      </div>
    </Panel>
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
  sessionId,
  mentions,
  onLook,
}: {
  item: TranscriptItem;
  sessionId: string;
  mentions: Mentions;
  onLook: (image: LookableImage) => void;
}) {
  switch (item.kind) {
    case 'tool':
      return <ToolRow item={item} nested={sentOff(item.parentId)} sessionId={sessionId} />;
    case 'thinking':
      return <ThinkingBlock item={item} />;
    case 'ask':
      return (
        <PermissionCard
          sessionId={sessionId}
          askId={item.id}
          title={item.title}
          toolName={item.toolName}
          options={item.options}
          question={item.question}
          allowText={item.allowText}
          secret={item.secret}
          href={item.href}
          chosen={item.chosen}
          sentBy={item.parentId}
          askedBy={item.askedBy}
        />
      );
    // Dedicated interactive renderers replace these placeholders in the two
    // visual work items. Keeping the fold exhaustive makes the provider seam
    // land independently without pretending either is a permission.
    case 'question':
      return <QuestionCard item={item} sessionId={sessionId} />;
    case 'plan':
      return <PlanProposalCard item={item} sessionId={sessionId} />;
    // Notes, asides, and the lines the kit writes in the reader's name never
    // reach here: the chat folds them into machine lines before it draws, which
    // is the only shape they have.
    case 'note':
    case 'notice':
    case 'provider_message':
      return null;
    default:
      return <MessageRow item={item} mentions={mentions} onLook={onLook} />;
  }
});
