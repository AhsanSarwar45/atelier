#!/usr/bin/env node
// Exercise the pinned adapter's real ACP transport and prompt consumer. Only
// provider session creation and SDK Query are replaced; no model or login runs.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = process.env.CLAUDE_ACP_TEST_SOURCE;
if (!source) throw new Error('CLAUDE_ACP_TEST_SOURCE must name the compiled pinned adapter');
const load = (name) => import(pathToFileURL(resolve(source, 'dist', name)));
const { ClaudeAcpAgent, runAcp } = await load('acp-agent.js');
const { Pushable } = await load('utils.js');
const { SessionTitles } = await load('session-titles.js');
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
ClaudeAcpAgent.prototype.listSessions = async () => ({ sessions: [] });
async function seed(params) {
  const sessionId = params.sessionId ?? randomUUID();
  const input = new Pushable();
  const client = this.client;
  const frame = (data) => ({ uuid: randomUUID(), session_id: sessionId, ...data });
  const state = (state) => frame({ type: 'system', subtype: 'session_state_changed', state });
  const result = (extra = {}) => frame({ type: 'result', subtype: 'success', stop_reason: 'end_turn', is_error: false, result: '', errors: [], duration_ms: 0, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], ...extra });
  const text = (text) => frame({ type: 'assistant', parent_tool_use_id: null, message: { id: randomUUID(), role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', usage, content: [{ type: 'text', text }] } });
  async function* messages() {
    let turn = 0;
    for await (const u of input) {
      turn++;
      yield frame({ type: 'user', message: u.message, uuid: u.uuid, isReplay: true, parent_tool_use_id: null });
      yield state('running');
      if (JSON.stringify(u.message).includes('complete immediately')) {
        yield text('The new turn completed.');
        yield result();
        yield state('idle');
        continue;
      }
      const task_id = `helper-${turn}`;
      yield frame({ type: 'system', subtype: 'task_started', task_id, tool_use_id: `toolu_${task_id}`, description: 'Explore the project', subagent_type: 'Explore' });
      yield text('The parent answer is complete. A background helper is still working.');
      yield result();
      yield state('idle');
      appendFileSync(resolve(params.cwd, 'held-turns'), `${turn}\n`);
      let asked = false;
      let questioned = false;
      while (!existsSync(resolve(params.cwd, `finish-helper-${turn}`))) {
        if (!asked && existsSync(resolve(params.cwd, `ask-helper-${turn}`))) {
          asked = true;
          await client.requestPermission({
            sessionId,
            toolCall: { toolCallId: `permission-${turn}`, title: 'Helper needs permission', status: 'pending', kind: 'read' },
            options: [{ optionId: 'allow-once', name: 'Allow helper', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject helper', kind: 'reject_once' }],
          });
        }
        if (!questioned && existsSync(resolve(params.cwd, `question-helper-${turn}`))) {
          questioned = true;
          await client.createElicitation({
            sessionId, mode: 'form', message: 'A helper has a question.',
            requestedSchema: { type: 'object', properties: { direction: { type: 'string', title: 'Direction', enum: ['Continue helper', 'Pause helper'] } }, required: ['direction'] },
          });
        }
        await new Promise(r => setTimeout(r, 50));
      }
      yield frame({ type: 'system', subtype: 'task_notification', task_id, tool_use_id: `toolu_${task_id}`, status: 'completed', output_file: '', summary: 'done' });
      yield text('The helper finished and its followup is complete.');
      yield result({ origin: { kind: 'task-notification' } });
      yield state('idle');
    }
  }
  const query = Object.assign(messages(), { interrupt: async () => {}, stopTask: async () => {}, close: () => {}, setModel: async () => {} });
  this.sessions[sessionId] = {
    query, input, cancelled: false, cwd: params.cwd,
    sessionFingerprint: JSON.stringify({ cwd: params.cwd, mcpServers: [] }),
    titles: new SessionTitles(this, sessionId),
    modes: { currentModeId: 'default', availableModes: [] },
    models: { currentModelId: 'default', availableModels: [] }, modelInfos: [],
    settingsManager: { dispose() {}, getSettings: () => ({}) },
    accumulatedUsage: { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    accumulatedModelUsage: {}, lastModelUsageReading: {}, configOptions: [], agents: [], currentAgent: 'default',
    abortController: new AbortController(), emitRawSDKMessages: false, forwardSubagentText: false,
    contextWindowSize: 200000, contextWindowAuthoritative: false, providerCacheKey: 'default',
    taskState: new Map(), toolUseCache: {}, emittedToolCalls: new Set(), liveBackgroundTasks: new Map(),
    emittedAssistantText: false, owedTrailingIdles: 0, messageIdToUuid: new Map(),
    sessionFailureState: { epoch: randomUUID(), revisions: new Map(), active: new Map() }, fileChangeReportRequestIds: new Set(),
  };
  appendFileSync(resolve(params.cwd, 'adapter-pids'), `${process.pid}\n`);
  return { sessionId, configOptions: [] };
}
ClaudeAcpAgent.prototype.newSession = seed;
ClaudeAcpAgent.prototype.loadSession = seed;
ClaudeAcpAgent.prototype.resumeSession = seed;
runAcp({ log() {}, error: (...args) => console.error(...args) });
