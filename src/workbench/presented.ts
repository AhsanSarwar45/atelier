/**
 * What the presenter showed, drawn where the agent showed it.
 *
 * `atelier tool present` prints a widget block, and the chat used to draw it
 * only if the agent then copied that block into its reply. A quarter of the
 * blocks agents presented never reached a reply: the agent presented a
 * screenshot mid-task, wrote "Committing, moving on", and the reader never saw
 * it (bw-yh4nu). So the call's own output is the widget's source now. The
 * server reads the blocks out of the output before cutting it to size, and
 * keeps them on the call's row as `presented`. Here each presenter call gets
 * a reply row of its own right after it, holding those widgets.
 *
 * It is a reply rather than part of the command's row so that switching
 * commands off in the chat filter keeps the pictures. A block the agent did
 * paste into a later reply is drawn there instead, once.
 */
import { widgetBlock, type ChatWidget } from '@/workbench/chat-widgets';
import type { TranscriptItem, TranscriptMessage, TranscriptTool } from '@/workbench/fold';

const PRESENTER = /\batelier\s+tool\s+present\b/;

/** Whether this call ran the presenter, read from what it was asked to run. */
export function ranThePresenter(tool: TranscriptTool): boolean {
  if (PRESENTER.test(tool.title)) return true;
  try {
    return PRESENTER.test(JSON.stringify(tool.input ?? {}));
  } catch {
    return false;
  }
}

/** The row id a presenter call's widgets are drawn under. */
export const presentedId = (toolId: string): string => `${toolId}:presented`;

/** The items with a reply row after each presenter call whose widgets no reply carries. */
export function withPresented(items: TranscriptItem[]): TranscriptItem[] {
  if (!items.some((item) => item.kind === 'tool' && item.presented?.length)) return items;
  const pasted = lastPasted(items);
  const drawn: TranscriptItem[] = [];
  items.forEach((item, at) => {
    drawn.push(item);
    if (item.kind !== 'tool' || !item.presented?.length || !ranThePresenter(item)) return;
    const blocks: string[] = [];
    const widgets: ChatWidget[] = [];
    for (const widget of item.presented) {
      const block = widgetBlock(widget);
      if (!block || (pasted.get(block) ?? -1) > at) continue;
      blocks.push(block);
      widgets.push(widget);
    }
    if (widgets.length === 0) return;
    const row: TranscriptMessage = {
      kind: 'message',
      id: presentedId(item.id),
      role: 'assistant',
      text: blocks.join('\n\n'),
      images: [],
      widgets,
      done: true,
      parentId: item.parentId ?? null,
      presentedBy: item.id,
      ...(item.execution ? { execution: item.execution } : {}),
    };
    drawn.push(row);
  });
  // The same list when nothing was added, so what is drawn from it holds still.
  return drawn.length === items.length ? items : drawn;
}

/** Where a reply last carried each widget, by the widget's exact block. */
function lastPasted(items: TranscriptItem[]): Map<string, number> {
  const pasted = new Map<string, number>();
  items.forEach((item, at) => {
    if (item.kind !== 'message' || item.role !== 'assistant') return;
    for (const widget of item.widgets ?? []) {
      const block = widgetBlock(widget);
      if (block) pasted.set(block, at);
    }
  });
  return pasted;
}
