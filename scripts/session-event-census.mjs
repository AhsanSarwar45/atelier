/**
 * Recursive, read-only census of Claude and Codex non-message session events.
 *
 * Reports semantic command coverage after provider and process wrappers are
 * removed, plus every event/tool signature that still reaches raw/unknown.
 * It prints shapes and file names, never tool arguments, output, or messages.
 *
 *   node scripts/session-event-census.mjs
 *   node scripts/session-event-census.mjs --json
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import './at-alias.mjs';

process.removeAllListeners('warning');

const { isCodeModeEnvelope, normalizeCommands } = await import('../src/workbench/command-normalization.ts');
const { auditCommandLabel } = await import('../src/workbench/command-label-audit.ts');
const { normalizeServiceAction } = await import('../src/workbench/service-action.ts');
const { whatACommandDid, whatItRan } = await import('../src/workbench/said-what-it-ran.ts');

const JSON_OUT = process.argv.includes('--json');
const CLAUDE_ROOT = process.env.CLAUDE_SESSIONS ?? join(homedir(), '.claude', 'projects');
const CODEX_ROOT = process.env.CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions');

function recordsUnder(root) {
  const found = [];
  const visit = (folder) => {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(path);
    }
  };
  visit(root);
  return found;
}

const report = {
  records: { claude: 0, codex: 0 },
  events: { claude: 0, codex: 0, categorized: 0, bookkeeping: 0, unknown: 0 },
  tools: { total: 0, categorized: 0, raw: 0 },
  commands: { envelopes: 0, semantic: 0, named: 0, opaque: 0, wrapped: 0 },
  commandLabels: { covered: 0, verifiedCorrect: 0, knownWrong: 0, unverified: 0, uncovered: 0 },
  commandIntents: {},
  contradictions: {},
  contradictionLabels: {},
  boundaries: {},
  unknown: {},
};

function count(table, key) { table[key] = (table[key] ?? 0) + 1; }
function unknown(provider, family, name, file) {
  report.events.unknown += 1;
  const signature = `${provider}:${family}:${name || '?'}`;
  const held = report.unknown[signature] ?? { count: 0, sample: basename(file) };
  held.count += 1;
  report.unknown[signature] = held;
}

function commandCandidate(raw, source = 'direct') {
  report.commands.envelopes += 1;
  const normalized = normalizeCommands(raw, source);
  if (!normalized.commands.length) report.commands.opaque += 1;
  for (const command of normalized.commands) {
    report.commands.semantic += 1;
    if (command.confidence === 'opaque') report.commands.opaque += 1;
    if (command.boundaries.length) report.commands.wrapped += 1;
    for (const boundary of command.boundaries) count(report.boundaries, boundary.kind);
    const ran = whatACommandDid(command.command);
    if (ran) {
      report.commands.named += 1;
      report.commandLabels.covered += 1;
    }
    const verdict = auditCommandLabel(command.command, ran);
    if (verdict.status === 'verified') report.commandLabels.verifiedCorrect += 1;
    else if (verdict.status === 'contradiction') {
      report.commandLabels.knownWrong += 1;
      count(report.contradictions, `${verdict.intent}: ${verdict.reason}`);
      count(report.contradictionLabels, `${verdict.intent}: ${ran?.said ?? 'raw'}`);
    } else if (verdict.status === 'unverified') report.commandLabels.unverified += 1;
    else report.commandLabels.uncovered += 1;
    if ('intent' in verdict && verdict.intent) count(report.commandIntents, verdict.intent);
  }
}

const CLAUDE_BOOKKEEPING = new Set([
  'file-history-snapshot', 'file-history-delta', 'queue-operation', 'last-prompt',
  'title', 'ai-title', 'summary', 'history-suppression', 'atis-latch',
]);
const CLAUDE_KNOWN = new Set([
  'system', 'progress', 'result', 'attachment', 'hook', 'hook_response',
  'tool_use_summary', 'rate_limit_event', 'stream_event',
  'mode', 'permission-mode', 'bridge-session', 'relocated', 'worktree-state',
  'agent-name', 'pr-link', 'frame-link', 'fork-context-ref', 'cost-state', 'started',
]);

function claudeTool(block, file) {
  report.tools.total += 1;
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (block.name === 'Bash' && typeof input.command === 'string') {
    commandCandidate(input.command);
    report.tools.categorized += 1;
    return;
  }
  const action = whatItRan(block.name, input);
  if (action) report.tools.categorized += 1;
  else {
    report.tools.raw += 1;
    unknown('claude', 'tool', block.name, file);
  }
}

function scanClaude(row, file) {
  report.events.claude += 1;
  const content = row?.message?.content;
  let meaningful = false;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        meaningful = true;
        claudeTool(block, file);
      } else if (block?.type === 'tool_result') {
        meaningful = true;
        report.events.categorized += 1;
      } else if (['image', 'document'].includes(block?.type)) {
        meaningful = true;
        report.events.categorized += 1;
      }
    }
  }
  if (meaningful) { report.events.categorized += 1; return; }
  if (['user', 'assistant'].includes(row.type)) return;
  if (CLAUDE_BOOKKEEPING.has(row.type)) { report.events.bookkeeping += 1; return; }
  if (CLAUDE_KNOWN.has(row.type)) { report.events.categorized += 1; return; }
  unknown('claude', 'event', row.type, file);
}

const CODEX_BOOKKEEPING = new Set([
  'session_meta', 'turn_context', 'ghost_snapshot', 'file_snapshot',
  'inter_agent_communication_metadata',
]);
const CODEX_RESPONSE_KNOWN = new Set([
  'message', 'agent_message', 'reasoning', 'function_call_output', 'custom_tool_call_output',
  'local_shell_call', 'local_shell_call_output', 'web_search_call',
]);
const CODEX_EVENT_KNOWN = new Set([
  'user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content',
  'task_started', 'task_complete', 'turn_aborted', 'token_count', 'context_compacted',
  'patch_apply_begin', 'patch_apply_end', 'web_search_begin', 'web_search_end',
  'image_generation_begin', 'image_generation_end', 'mcp_tool_call_begin',
  'sub_agent_activity', 'thread_settings_applied', 'turn_diff', 'warning', 'error',
  'item_completed',
]);

function codexTool(payload, file) {
  report.tools.total += 1;
  const name = String(payload.name ?? '');
  const input = payload.input ?? payload.arguments ?? '';
  if (name === 'exec' || name === 'exec_command') {
    if (typeof input !== 'string') {
      report.commands.envelopes += 1;
      report.commands.opaque += 1;
    } else {
      commandCandidate(input, isCodeModeEnvelope(input) ? 'code-mode' : 'direct');
    }
    report.tools.categorized += 1;
    return;
  }
  const bag = input && typeof input === 'object' ? input : {};
  if (whatItRan(name, bag)) report.tools.categorized += 1;
  else {
    report.tools.raw += 1;
    unknown('codex', 'tool', name, file);
  }
}

function scanCodex(row, file) {
  report.events.codex += 1;
  const payload = row?.payload ?? {};
  const type = String(payload.type ?? row.type ?? '');
  if (CODEX_BOOKKEEPING.has(row.type) || CODEX_BOOKKEEPING.has(type)) {
    report.events.bookkeeping += 1;
    return;
  }
  if (row.type === 'response_item' && ['function_call', 'custom_tool_call'].includes(type)) {
    codexTool(payload, file);
    report.events.categorized += 1;
    return;
  }
  if (row.type === 'event_msg' && type === 'mcp_tool_call_end') {
    const invocation = payload.invocation ?? {};
    const action = normalizeServiceAction(
      `${invocation.server ?? ''}/${invocation.tool ?? ''}`,
      invocation.arguments ?? {},
      { readOnlyHint: payload.read_only_hint === true, destructiveHint: payload.destructive_hint === true },
    );
    if (action) report.events.categorized += 1;
    else unknown('codex', 'event', type, file);
    return;
  }
  if (row.type === 'response_item' && CODEX_RESPONSE_KNOWN.has(type)) return;
  if (row.type === 'world_state' || row.type === 'compacted') {
    report.events.categorized += 1;
    return;
  }
  if (row.type === 'event_msg' && CODEX_EVENT_KNOWN.has(type)) {
    report.events.categorized += 1;
    return;
  }
  unknown('codex', row.type || 'event', type, file);
}

function scan(provider, root, accept) {
  const files = recordsUnder(root);
  report.records[provider] = files.length;
  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { accept(JSON.parse(line), file); } catch { /* malformed rows remain inert */ }
    }
  }
}

scan('claude', CLAUDE_ROOT, scanClaude);
scan('codex', CODEX_ROOT, scanCodex);

const orderedUnknown = Object.fromEntries(
  Object.entries(report.unknown).sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])),
);
report.unknown = orderedUnknown;

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.records.claude} Claude and ${report.records.codex} Codex records`);
  console.log(`${report.commands.semantic} semantic commands from ${report.commands.envelopes} envelopes; ${report.commands.named} named, ${report.commands.wrapped} unwrapped, ${report.commands.opaque} opaque`);
  console.log(`${report.commandLabels.covered} command labels covered; ${report.commandLabels.verifiedCorrect} verified intent-correct, ${report.commandLabels.knownWrong} known wrong, ${report.commandLabels.unverified} labelled but unverified, ${report.commandLabels.uncovered} uncovered`);
  for (const [reason, count] of Object.entries(report.contradictions).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(7)}  ${reason}`);
  }
  console.log(`${report.tools.categorized}/${report.tools.total} tool calls categorized; ${report.tools.raw} raw`);
  console.log(`${report.events.unknown} unknown non-bookkeeping events across ${Object.keys(orderedUnknown).length} signatures`);
  for (const [signature, held] of Object.entries(orderedUnknown)) {
    console.log(`  ${String(held.count).padStart(7)}  ${signature}  (${held.sample})`);
  }
}
