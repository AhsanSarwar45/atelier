import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { patchClaudeStopMain } from '../claude-stop-main.mjs';

// The upstream shapes the patch rewrites, cut down to what they do: the
// consumer sees each top-level assistant message, the agent class answers
// requests, and the router names them.
const upstream = `
type NewSessionRequest = unknown;
type NewSessionResponse = unknown;
type Query = { backgroundTasks(id: string): Promise<boolean>; stopTask(id: string): Promise<void> };
const RequestError = { invalidParams: (_raw: unknown, text: string) => new Error(text) };
type Message = { type: string; parent_tool_use_id: string | null; message: { usage: number; content: unknown } };
function snapshotFromUsage(usage: number) { return usage; }
export type ToolUseCache = {
  [key: string]: { type: "tool_use" | "server_tool_use" | "mcp_tool_use"; id: string; name: string; input: unknown };
};
type Session = {
  query: Query;
  toolUseCache: ToolUseCache;
  liveBackgroundTasks: Map<string, { parentToolUseId?: string; isSubagent: boolean }>;
};
export class Agent {
  sessions: Record<string, Session> = {};
  consume(session: Session, message: Message) {
    let lastAssistantUsage = 0;
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              lastAssistantUsage = snapshotFromUsage(message.message.usage);
            }
    return lastAssistantUsage;
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return params;
  }
}
export const routes: string[] = [];
const methods = { agent: { session: { new: "session/new" } } };
const agent = new Agent();
const router = { onRequest(name: string, ..._rest: unknown[]) { routes.push(name); return router; } };
router
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
;
`;

type Session = {
  query: { backgroundTasks(id: string): Promise<boolean>; stopTask(id: string): Promise<void> };
  toolUseCache: Record<string, { type: 'tool_use'; id: string; name: string; input: unknown }>;
  liveBackgroundTasks: Map<string, { parentToolUseId?: string; isSubagent: boolean }>;
};
type Patched = {
  Agent: new () => {
    sessions: Record<string, Session>;
    consume(session: Session, message: unknown): number;
    atelierStopMain(params: { sessionId: string }): Promise<{ ok: true; stopped: number; kept: number }>;
  };
  routes: string[];
};

function load(): Patched {
  const compiled = ts.transpileModule(patchClaudeStopMain(upstream), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {} as Patched;
  new Function('exports', compiled)(exports);
  return exports;
}

/** A chat whose main agent runs a command and waits on a helper, and a helper of its own runs a command. */
function chat() {
  const calls: string[] = [];
  const session: Session = {
    toolUseCache: {},
    liveBackgroundTasks: new Map(),
    query: {
      backgroundTasks: async (id) => {
        calls.push(`background ${id}`);
        // The CLI hands each moved shell a task of its own.
        if (session.toolUseCache[id]?.name === 'Bash') {
          session.liveBackgroundTasks.set(`task-${id}`, { parentToolUseId: id, isSubagent: false });
        }
        return true;
      },
      stopTask: async (id) => {
        calls.push(`stop ${id}`);
      },
    },
  };
  for (const [id, name] of [['main-bash', 'Bash'], ['main-agent', 'Agent'], ['helper-bash', 'Bash']] as const) {
    session.toolUseCache[id] = { type: 'tool_use', id, name, input: {} };
  }
  return { session, calls };
}

const said = (parent: string | null, ids: string[]) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { usage: 1, content: ids.map((id) => ({ type: 'tool_use', id })) },
});

describe("the Claude adapter stops the main agent's tools and keeps its helpers", () => {
  it("stops the main agent's command, moves its helper to the background, and leaves the helper's own command alone", async () => {
    const { Agent, routes } = load();
    const agent = new Agent();
    const { session, calls } = chat();
    agent.sessions.s = session;
    agent.consume(session, said(null, ['main-bash', 'main-agent']));
    agent.consume(session, said('main-agent', ['helper-bash']));

    expect(await agent.atelierStopMain({ sessionId: 's' })).toEqual({ ok: true, stopped: 1, kept: 1 });
    expect(calls).toEqual(['background main-bash', 'stop task-main-bash', 'background main-agent']);
    expect(routes).toContain('_atelier/session/stop-main');
  });

  it('touches nothing the main agent has already finished', async () => {
    const { Agent } = load();
    const agent = new Agent();
    const { session, calls } = chat();
    agent.sessions.s = session;
    agent.consume(session, said(null, ['main-bash']));
    delete session.toolUseCache['main-bash'];

    expect(await agent.atelierStopMain({ sessionId: 's' })).toEqual({ ok: true, stopped: 0, kept: 0 });
    expect(calls).toEqual([]);
  });

  it('refuses a session it does not know', async () => {
    const { Agent } = load();
    await expect(new Agent().atelierStopMain({ sessionId: 'nobody' })).rejects.toThrow(/Unknown session/);
  });

  it('refuses to patch an adapter whose shapes moved', () => {
    expect(() => patchClaudeStopMain(upstream.replace('export type ToolUseCache = {', 'type Other = {'))).toThrow(/audit the stop-main patch/);
  });
});
