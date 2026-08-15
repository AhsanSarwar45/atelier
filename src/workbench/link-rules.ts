/**
 * What counts as a chat having touched a card.
 *
 * ## An action, not a mention
 *
 * A card is a candidate only when a tool call ACTED on it: a `bd` command
 * named it, or a file the agent wrote had it in its path. Ids merely mentioned
 * — in a file's contents, in a tool's output, in the agent's prose, in the
 * human's prompt — are ignored on purpose. Reading a document that cites a
 * card is not working on that card, and a chip for a card the chat never
 * touched is worse than one that never appears.
 *
 * Nothing here decides anything on its own: every candidate is confirmed
 * against the board before it becomes a link, which is what makes a token that
 * merely looks like an id harmless. See workbench/src/linker.ts.
 *
 * Shared with the sidecar, so the rule has one definition and one test.
 */

/** `bw-7ks`, `cor-dlby.6`, `pz-aaa111` — a prefix, a dash, a body, optional step. */
const ID_SHAPE = /\b[a-z][a-z0-9]{1,5}-[a-z0-9]{2,}(?:\.\d+)*\b/g;

/** Tools that put bytes on disk; their `file_path` is an action on that path. */
const WRITING_TOOLS = ["Edit", "Write", "NotebookEdit", "MultiEdit"];

/** `…/pages/<project>/<slug>.report.json` */
const REPORT_SPEC = /(?:^|\/)pages\/([^/]+)\/([^/]+)\.report\.json$/;

/**
 * A `bd` invocation, as a command word rather than a substring of one, so
 * `abd show x` and `grep bd-1 file` do not qualify. Allows a leading
 * `VAR=value` and picks up each command in a chain.
 */
const BD_CALL = /(?:^|[;&|\n(])\s*(?:[A-Za-z_]\w*=\S+\s+)*bd\s+([^;&|\n)]*)/g;

/** Every match of a sticky-free global pattern, without needing iterators. */
function allMatches(pattern: RegExp, text: string, group: number): string[] {
  const re = new RegExp(pattern.source, pattern.flags);
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') re.lastIndex++;
    const captured = m[group];
    if (captured !== undefined) out.push(captured);
  }
  return out;
}

function unique(values: string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) === i);
}

/** Ids named as arguments of a `bd` command. */
export function idsFromBdCommand(command: string): string[] {
  const ids: string[] = [];
  for (const args of allMatches(BD_CALL, command, 1)) {
    ids.push(...allMatches(ID_SHAPE, args, 0));
  }
  return unique(ids);
}

/**
 * An id sitting in the path a writing tool was pointed at.
 *
 * The whole stem must be the id: `bw-7ks.md` is about bw-7ks, while
 * `notes-about-bw-7ks.md` is a document that merely mentions it.
 */
export function idsFromPath(filePath: string): string[] {
  const ids: string[] = [];
  for (const segment of filePath.split('/')) {
    const stem = segment.replace(/\.[^.]+$/, '');
    for (const id of allMatches(ID_SHAPE, stem, 0)) if (id === stem) ids.push(id);
  }
  return unique(ids);
}

/** Every card a single tool call puts forward. Nothing here is confirmed yet. */
export function candidatesFrom(name: string, input: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (name === 'Bash' && typeof input.command === 'string') {
    ids.push(...idsFromBdCommand(input.command));
  }
  if (WRITING_TOOLS.indexOf(name) >= 0 && typeof input.file_path === 'string') {
    ids.push(...idsFromPath(input.file_path));
  }
  return unique(ids);
}

/** A report spec the agent created or changed. */
export function reportFrom(
  name: string,
  input: Record<string, unknown>,
): { project: string; slug: string } | null {
  if (WRITING_TOOLS.indexOf(name) < 0 || typeof input.file_path !== "string") return null;
  const m = REPORT_SPEC.exec(input.file_path);
  return m ? { project: m[1]!, slug: m[2]! } : null;
}
