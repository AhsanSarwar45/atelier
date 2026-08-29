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
const { auditCommandLabel, commandLabelProfile } = await import('../src/workbench/command-label-audit.ts');
const { commandStructure, topLevelShellCommands } = await import('../src/workbench/command-structure.ts');
const { normalizeServiceAction } = await import('../src/workbench/service-action.ts');
const { whatACommandDid, whatItRan } = await import('../src/workbench/said-what-it-ran.ts');

const JSON_OUT = process.argv.includes('--json');
const VERIFY_LABELS = process.argv.includes('--verify-labels');
const VERIFY_COMPOUNDS = process.argv.includes('--verify-compounds');
const CLAUDE_ROOT = process.env.CLAUDE_SESSIONS ?? join(homedir(), '.claude', 'projects');
const CODEX_ROOT = process.env.CODEX_SESSIONS ?? join(homedir(), '.codex', 'sessions');
const CODE_ORCHESTRATION = /^\s*(?:\/\/\s*@exec\b|const\b|let\b|var\b|await\b)[\s\S]*\btools\./;

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
  compoundCommands: { observed: 0, structured: 0, unstructured: 0, contradictions: 0 },
  commandLabels: { covered: 0, verifiedCorrect: 0, knownWrong: 0, unverified: 0, uncovered: 0 },
  stageLabels: { verifiedCorrect: 0, knownWrong: 0, unverified: 0, uncovered: 0 },
  semanticFamilies: { verified: 0, contradictory: 0, unverified: 0, uncovered: 0, recurringUnverified: 0, recurringUncovered: 0 },
  serviceLabels: { observed: 0, contradictions: 0 },
  commandIntents: {},
  contradictions: {},
  compoundContradictions: {},
  stageContradictions: {},
  contradictionLabels: {},
  profiles: { commands: {}, stages: {}, compounds: {}, compoundLabels: {}, services: {} },
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
  const decodedSource = source === 'direct' && typeof raw === 'string' && isCodeModeEnvelope(raw) ? 'code-mode' : source;
  const normalized = normalizeCommands(raw, decodedSource);
  if (!normalized.commands.length) report.commands.opaque += 1;
  for (const command of normalized.commands) {
    report.commands.semantic += 1;
    if (command.confidence === 'opaque') report.commands.opaque += 1;
    if (command.boundaries.length) report.commands.wrapped += 1;
    for (const boundary of command.boundaries) count(report.boundaries, boundary.kind);
    const ran = whatACommandDid(command.command);
    const structure = commandStructure(command.command);
    if (structure.compound) {
      report.compoundCommands.observed += 1;
      if (structure.profile) {
        report.compoundCommands.structured += 1;
        count(report.profiles.compounds, structure.profile);
      } else report.compoundCommands.unstructured += 1;
      const verb = ran?.said.match(/^[A-Za-z][\w-]*/)?.[0] ?? 'raw';
      count(report.profiles.compoundLabels, `${structure.profile || 'unstructured'}|${verb}|${ran?.kind ?? 'raw'}|${ran?.grave ? 'grave' : 'ordinary'}`);
      // `kill -0` only probes liveness, so its head alone cannot prove a
      // destructive effect. A top-level rm has no corresponding read mode.
      const visiblyDestructive = structure.stages.includes('rm');
      const said = ran?.said ?? '';
      const collapsed = structure.stages.length > 1 && Boolean(ran) && !/, then |, and \d+ more/.test(said);
      const collapsedIntoScript = structure.heredocs > 0 && collapsed && /^Ran an? .* script(?:\b| )/i.test(said);
      if (visiblyDestructive && !ran?.grave) {
        report.compoundCommands.contradictions += 1;
        count(report.compoundContradictions, `${structure.profile}|hid-delete`);
      }
      if (collapsedIntoScript) {
        report.compoundCommands.contradictions += 1;
        count(report.compoundContradictions, `${structure.profile}|collapsed-heredoc`);
      }
    }
    // Control-flow bodies are one shell-script action. Splitting their `do`,
    // function bodies, variables, and braces as executable stages invents
    // commands which were never launched and invalidates the oracle.
    const controlScript = structure.profile?.startsWith('control-script');
    const stageLinks = CODE_ORCHESTRATION.test(command.command) || controlScript ? [] : topLevelShellCommands(command.command);
    for (const link of stageLinks) {
      const shaping = link.piped && /^(?:head|tail|wc|sort|uniq|cut|tr|jq|column|less|more|nl|rev|tac|awk|sed|grep|rg|cat)\b/.test(link.text.trim());
      if (shaping) continue;
      const stageRan = whatACommandDid(link.text);
      const stageVerdict = auditCommandLabel(link.text, stageRan);
      const stageProfile = commandLabelProfile(link.text, stageRan) ?? 'unprofiled';
      count(report.profiles.stages, `${stageVerdict.status}|${stageProfile}`);
      if (stageVerdict.status === 'verified') report.stageLabels.verifiedCorrect += 1;
      else if (stageVerdict.status === 'contradiction') {
        report.stageLabels.knownWrong += 1;
        count(report.stageContradictions, `${stageVerdict.intent}:${stageVerdict.reason}|${stageProfile}`);
      }
      else if (stageVerdict.status === 'unverified') report.stageLabels.unverified += 1;
      else report.stageLabels.uncovered += 1;
    }
    if (ran) {
      report.commands.named += 1;
      report.commandLabels.covered += 1;
    }
    const verdict = auditCommandLabel(command.command, ran);
    const profile = commandLabelProfile(command.command, ran);
    if (profile) count(report.profiles.commands, profile);
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

function serviceCandidate(name, input = {}, annotations = {}) {
  const action = normalizeServiceAction(name, input, annotations);
  if (!action) return null;
  const ran = whatItRan(name, {
    ...input,
    readOnlyHint: annotations.readOnlyHint === true,
    destructiveHint: annotations.destructiveHint === true,
  });
  const verb = ran?.said.match(/^[A-Za-z][\w-]*/)?.[0] ?? 'raw';
  const delegatedValues = [input.tool, input.tool_name, input.function];
  if (action.method === 'execute_sentry_tool') delegatedValues.push(input.name);
  const delegated = delegatedValues.find((value) =>
    typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value),
  );
  const method = delegated ? `${action.method}>${delegated}` : action.method;
  const profile = `${action.server}/${method}|${verb}|${ran?.kind ?? 'raw'}|${ran?.grave ? 'grave' : 'ordinary'}|${action.effect}|${action.risk}|${action.confidence}`;
  count(report.profiles.services, profile);
  report.serviceLabels.observed += 1;
  const expectedRisk = {
    read: 'read-only', search: 'read-only', create: 'mutating', update: 'mutating',
    delete: 'destructive', communicate: 'mutating', authenticate: 'mutating', execute: 'unknown',
  }[action.effect];
  const effectVerbs = {
    read: ['Read', 'Listed', 'Looked', 'Waited'], search: ['Searched'],
    create: ['Created', 'Published', 'Uploaded', 'Opened', 'Saved'],
    update: ['Updated', 'Opened', 'Clicked', 'Typed', 'Filled', 'Pressed', 'Resized', 'Switched', 'Pretended', 'Closed', 'Started', 'Stopped'],
    delete: ['Deleted'], communicate: ['Sent'], authenticate: ['Authenticated'], execute: ['Ran'],
  }[action.effect];
  const contradicted = expectedRisk !== action.risk || !effectVerbs.includes(verb) ||
    (action.risk === 'destructive') !== (ran?.grave === true) ||
    (ran?.grave === true) !== (ran?.kind === 'grave');
  if (contradicted) report.serviceLabels.contradictions += 1;
  return action;
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
  serviceCandidate(block.name, input);
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
  serviceCandidate(name, bag);
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
    const action = serviceCandidate(
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
report.profiles.commands = Object.fromEntries(
  Object.entries(report.profiles.commands).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);
report.profiles.stages = Object.fromEntries(
  Object.entries(report.profiles.stages).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);
for (const [profile, occurrences] of Object.entries(report.profiles.stages)) {
  const status = profile.slice(0, profile.indexOf('|'));
  if (profile.endsWith('|unprofiled')) continue;
  if (status === 'verified') report.semanticFamilies.verified += 1;
  else if (status === 'contradiction') report.semanticFamilies.contradictory += 1;
  else if (status === 'unverified') {
    report.semanticFamilies.unverified += 1;
    if (occurrences > 1) report.semanticFamilies.recurringUnverified += 1;
  } else {
    report.semanticFamilies.uncovered += 1;
    if (occurrences > 1) report.semanticFamilies.recurringUncovered += 1;
  }
}
report.profiles.compounds = Object.fromEntries(
  Object.entries(report.profiles.compounds).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);
report.profiles.compoundLabels = Object.fromEntries(
  Object.entries(report.profiles.compoundLabels).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);
report.profiles.services = Object.fromEntries(
  Object.entries(report.profiles.services).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
);

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.records.claude} Claude and ${report.records.codex} Codex records`);
  console.log(`${report.commands.semantic} semantic commands from ${report.commands.envelopes} envelopes; ${report.commands.named} named, ${report.commands.wrapped} unwrapped, ${report.commands.opaque} opaque`);
  console.log(`${report.commandLabels.covered} command labels covered; ${report.commandLabels.verifiedCorrect} verified intent-correct, ${report.commandLabels.knownWrong} known wrong, ${report.commandLabels.unverified} labelled but unverified, ${report.commandLabels.uncovered} uncovered`);
  console.log(`${report.stageLabels.verifiedCorrect} top-level stages verified intent-correct, ${report.stageLabels.knownWrong} known wrong, ${report.stageLabels.unverified} unverified, ${report.stageLabels.uncovered} uncovered`);
  console.log(`${report.semanticFamilies.verified} semantic families verified, ${report.semanticFamilies.contradictory} contradictory, ${report.semanticFamilies.unverified} unverified (${report.semanticFamilies.recurringUnverified} recurring), ${report.semanticFamilies.uncovered} uncovered (${report.semanticFamilies.recurringUncovered} recurring)`);
  console.log(`${Object.keys(report.profiles.commands).length} privacy-safe command signature groups`);
  console.log(`${report.compoundCommands.structured}/${report.compoundCommands.observed} compound commands structurally profiled across ${Object.keys(report.profiles.compounds).length} privacy-safe shapes; ${report.compoundCommands.unstructured} unstructured, ${report.compoundCommands.contradictions} composition contradictions`);
  for (const [reason, count] of Object.entries(report.contradictions).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(7)}  ${reason}`);
  }
  console.log(`${report.serviceLabels.observed} service calls across ${Object.keys(report.profiles.services).length} provider-neutral signature groups; ${report.serviceLabels.contradictions} risk/category contradictions`);
  console.log(`${report.tools.categorized}/${report.tools.total} tool calls categorized; ${report.tools.raw} raw`);
  console.log(`${report.events.unknown} unknown non-bookkeeping events across ${Object.keys(orderedUnknown).length} signatures`);
  for (const [signature, held] of Object.entries(orderedUnknown)) {
    console.log(`  ${String(held.count).padStart(7)}  ${signature}  (${held.sample})`);
  }
}

if (VERIFY_LABELS && (report.commandLabels.knownWrong > 0 || report.stageLabels.knownWrong > 0 || report.serviceLabels.contradictions > 0 || report.semanticFamilies.recurringUnverified > 0)) process.exitCode = 1;
if (VERIFY_COMPOUNDS && (report.compoundCommands.unstructured > 0 || report.compoundCommands.contradictions > 0)) process.exitCode = 1;
