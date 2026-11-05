// Stop the main agent's running tools and leave its helpers running.
//
// `session/cancel` is the only way the protocol stops a turn, and the SDK's
// interrupt behind it stops every task the session started, background helpers
// included (measured 2026-11-05, SDK 0.3.257: a helper interrupted 4 s into a
// 45 s command reported `stopped` and never wrote its file). A steered message
// at priority `now` leaves the helpers alone, but it waits behind whatever tool
// the main agent is running. So `_atelier/session/stop-main` moves each tool the
// main agent is running into the background, the CLI's own Ctrl+B, and stops
// the ones that are not helpers. The main agent's turn goes on with the tool's
// result in hand, and a message steered next is read at once. Measured the same
// day: a 150 s command stopped at 9 s, the steered reply at 11 s, and the helper
// finished its 45 s and wrote its file (bw-pnhyd.1).
export function patchClaudeStopMain(source) {
  const seen = `            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              lastAssistantUsage = snapshotFromUsage(message.message.usage);`;
  const method = '  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {';
  const route = '    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))';
  const helperAnchor = 'export type ToolUseCache = {';
  if (source.split(seen).length !== 2 || source.split(method).length !== 2
    || source.split(route).length !== 2 || source.split(helperAnchor).length !== 2) {
    throw new Error('Claude stop-main anchors changed; audit the stop-main patch');
  }
  const helper = `/** Tool calls the main agent made, never a helper's (bw-pnhyd.1). */
const atelierMainTools = new WeakMap<object, Set<string>>();

function atelierNoteMainTools(
  session: { toolUseCache: ToolUseCache },
  content: unknown,
): void {
  if (!Array.isArray(content)) return;
  let calls = atelierMainTools.get(session);
  if (!calls) {
    calls = new Set();
    atelierMainTools.set(session, calls);
  }
  // A finished call leaves the tool cache; keep only the ones still open.
  for (const id of calls) if (!(id in session.toolUseCache)) calls.delete(id);
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use") {
      const id = (block as { id?: unknown }).id;
      if (typeof id === "string") calls.add(id);
    }
  }
}

async function atelierStopMain(session: {
  query: Query;
  toolUseCache: ToolUseCache;
  liveBackgroundTasks: Map<string, { parentToolUseId?: string; isSubagent: boolean }>;
}): Promise<{ ok: true; stopped: number; kept: number }> {
  const calls = [...(atelierMainTools.get(session) ?? [])].filter((id) => id in session.toolUseCache);
  let stopped = 0;
  let kept = 0;
  for (const call of calls) {
    const moved = await session.query.backgroundTasks(call).catch(() => false);
    if (!moved) continue;
    const name = session.toolUseCache[call]?.name;
    if (name === "Agent" || name === "Task") {
      // A helper the main agent was waiting on: now it runs on its own.
      kept += 1;
      continue;
    }
    // The task's record arrives on the message stream, which may still be
    // behind the call that moved it.
    let task: string | undefined;
    for (let tries = 0; tries < 60 && !task; tries += 1) {
      for (const [id, record] of session.liveBackgroundTasks) {
        if (record.parentToolUseId === call && !record.isSubagent) task = id;
      }
      if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!task) continue;
    await session.query.stopTask(task);
    stopped += 1;
  }
  return { ok: true, stopped, kept };
}

${helperAnchor}`;
  const handler = `  async atelierStopMain(params: { sessionId: string }) {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, "Unknown session");
    }
    return atelierStopMain(session);
  }

${method}`;
  const request = `    .onRequest(
      "_atelier/session/stop-main",
      {
        parse: (raw: unknown) => {
          const value = raw as { sessionId?: unknown } | null;
          if (typeof value?.sessionId !== "string" || value.sessionId.length === 0) {
            throw RequestError.invalidParams(raw, "sessionId is required");
          }
          return { sessionId: value.sessionId };
        },
      },
      (ctx) => agent.atelierStopMain(ctx.params),
    )
${route}`;
  return source
    .replace(seen, `${seen}
              atelierNoteMainTools(session, message.message.content);`)
    .replace(helperAnchor, helper)
    .replace(method, handler)
    .replace(route, request);
}
