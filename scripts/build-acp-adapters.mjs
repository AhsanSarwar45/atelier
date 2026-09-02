#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const CLAUDE = Object.freeze({
  version: '0.73.0',
  commit: 'ea7076c0bc324603e65d8c124b7573f158749969',
  repository: 'https://github.com/agentclientprotocol/claude-agent-acp.git',
  providerVersion: '0.3.257',
});
const CODEX = Object.freeze({
  version: '1.8.0',
  commit: '87997e2627e8fa246a49de533c612f6196c4004e',
  repository: 'https://github.com/agentclientprotocol/codex-acp.git',
  providerVersion: '0.152.0',
});
const GOOSE = Object.freeze({
  version: '1.41.0',
  commit: '39c27c387d726ce4605108d2f974d4feec158ed5',
  repository: 'https://github.com/aaif-goose/goose.git',
});

const TARGETS = Object.freeze({
  'aarch64-apple-darwin': {
    bun: 'bun-darwin-arm64', claude: 'darwin-arm64', codex: 'darwin-arm64',
    codexTriple: 'aarch64-apple-darwin', exe: '',
  },
  'x86_64-apple-darwin': {
    bun: 'bun-darwin-x64-baseline', claude: 'darwin-x64', codex: 'darwin-x64',
    codexTriple: 'x86_64-apple-darwin', exe: '',
  },
  'x86_64-unknown-linux-gnu': {
    bun: 'bun-linux-x64-baseline', claude: 'linux-x64', codex: 'linux-x64',
    codexTriple: 'x86_64-unknown-linux-musl', exe: '',
  },
  'x86_64-pc-windows-msvc': {
    bun: 'bun-windows-x64-baseline', claude: 'win32-x64', codex: 'win32-x64',
    codexTriple: 'x86_64-pc-windows-msvc', exe: '.exe',
  },
});

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
}

function acpWireVersion(source) {
  const result = spawnSync(process.execPath, ['-e', 'console.log(require("@agentclientprotocol/sdk").PROTOCOL_VERSION)'], {
    cwd: source, encoding: 'utf8', shell: false,
  });
  if (result.status !== 0) throw new Error(`could not read ACP wire version from ${source}: ${result.stderr}`);
  return result.stdout.trim();
}

function clonePinned(source, destination) {
  run('git', ['clone', '--filter=blob:none', '--no-checkout', source.repository, destination]);
  run('git', ['checkout', '--detach', source.commit], destination);
  // These repositories are source inputs to Bun, not npm-delivered runtime
  // applications. Running transitive lifecycle scripts here lets unrelated
  // host tools affect a supposedly pinned release (esbuild's installer will,
  // for example, accept an executable from PATH and then reject its version).
  // Bun compilation below is the authoritative dependency check.
  run('npm', ['ci', '--ignore-scripts'], destination);
}

function clonePinnedRust(source, destination) {
  run('git', ['clone', '--filter=blob:none', '--no-checkout', source.repository, destination]);
  run('git', ['checkout', '--detach', source.commit], destination);
}

function verifyNativeCapabilities(claudeSource, codexSource) {
  const claude = readFileSync(join(claudeSource, 'src', 'acp-agent.ts'), 'utf8');
  for (const anchor of [
    'settingSources: ["user", "project", "local"],',
    '...(userProvidedOptions?.mcpServers || {}),',
    '...mcpServers,',
    'loadSession: true,',
    'resume: {},',
  ]) {
    if (!claude.includes(anchor)) {
      throw new Error(`Claude ACP native capability changed at ${JSON.stringify(anchor)}; audit MCP/session parity`);
    }
  }

  const codexClient = readFileSync(join(codexSource, 'src', 'CodexAcpClient.ts'), 'utf8');
  for (const anchor of [
    '...mergeGatewayConfig(this.config, this.gatewayConfig),',
    'if (mcpServers.length === 0) {\n            return configWithWorkspaceRoots;\n        }',
  ]) {
    if (!codexClient.includes(anchor)) {
      throw new Error(`Codex ACP native MCP inheritance changed at ${JSON.stringify(anchor)}; audit provider config parity`);
    }
  }
  const codexServer = readFileSync(join(codexSource, 'src', 'CodexAcpServer.ts'), 'utf8');
  for (const anchor of ['loadSession: true,', 'resume: { }']) {
    if (!codexServer.includes(anchor)) {
      throw new Error(`Codex ACP session capability changed at ${JSON.stringify(anchor)}; audit resume parity`);
    }
  }
}

function patchCodexAppServerTransport(source) {
  const connection = join(source, 'src', 'CodexJsonRpcConnection.ts');
  let code = readFileSync(connection, 'utf8');
  const importAnchor = 'import {spawn} from "node:child_process";';
  const launchAnchor = `        codex = process.platform === 'win32'
            ? spawn(\`"\${codexPath}" app-server\`, { shell: true, env: spawnEnv })
            : spawn(codexPath, ['app-server'], { env: spawnEnv });`;
  const loggedInput = `    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        logger.log(\`[IN] \${chunk.toString()}\`);
        return originalWrite(chunk, encoding, callback);
    };

`;
  if (code.split(importAnchor).length - 1 !== 1
      || code.split(launchAnchor).length - 1 !== 1
      || code.split(loggedInput).length - 1 !== 1) {
    throw new Error('codex-acp app-server launch shape changed; audit the pinned compatibility patch');
  }
  code = code.replace(importAnchor, `${importAnchor}
import {EventEmitter} from "node:events";
import {Readable, Writable} from "node:stream";`);
  code = code.replace(launchAnchor, `        // This source is compiled into Bun, while its upstream typecheck stays
        // intentionally Node-only and must not gain a shipped @types/bun dependency.
        // @ts-expect-error Bun is the executable runtime supplied by the build target.
        const subprocess = Bun.spawn([codexPath, 'app-server', '--stdio'], {
            env: spawnEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        });
        const events = new EventEmitter();
        const stdin = new Writable({
            write(chunk, _encoding, callback) {
                try { subprocess.stdin.write(chunk); subprocess.stdin.flush(); callback(); }
                catch (error) { callback(error as Error); }
            },
            final(callback) { subprocess.stdin.end(); callback(); },
        });
        const child = Object.assign(events, {
            stdin,
            stdout: Readable.fromWeb(subprocess.stdout),
            stderr: Readable.fromWeb(subprocess.stderr),
            killed: false,
            kill(signal?: NodeJS.Signals) {
                child.killed = true;
                subprocess.kill(signal);
                return true;
            },
        });
        void subprocess.exited.then((code: number) => events.emit('exit', code, null));
        codex = child as unknown as ChildProcessWithoutNullStreams;`);
  code = code.replace(loggedInput, '');
  writeFileSync(connection, code);

  const framing = join(source, 'src', 'StdUtils.ts');
  code = readFileSync(framing, 'utf8');
  const stripping = `                if (msg && typeof msg === 'object') {
                    // remove jsonrpc for the server
                    msg = {...msg};
                    delete (msg as any).jsonrpc;
                }
`;
  if (!code.includes(stripping)) {
    throw new Error('codex-acp JSON-RPC framing changed; audit the pinned compatibility patch');
  }
  writeFileSync(framing, code.replace(stripping, ''));
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

function patchCodexSessionPolicy(source) {
  const candidates = sourceFiles(join(source, 'src')).filter(path => path.endsWith('.ts'));
  const sessionFile = candidates.find(path => {
    const code = readFileSync(path, 'utf8');
    return code.includes('async newSession(request') && code.includes('this.codexClient.threadStart');
  });
  if (!sessionFile) {
    throw new Error('codex-acp session implementation changed; audit the pinned policy patch');
  }
  let code = readFileSync(sessionFile, 'utf8');
  const roots = 'const additionalDirectories = readAdditionalDirectories(request.cwd, request.additionalDirectories, request._meta);';
  const policy = `${roots}\n        const atelierSessionPolicy = (request._meta as { atelier?: { sessionPolicy?: unknown } } | undefined)?.atelier?.sessionPolicy;`;
  const rootCount = code.split(roots).length - 1;
  if (rootCount !== 4) {
    throw new Error(`codex-acp session root shape changed (${rootCount}); audit the pinned policy patch`);
  }
  code = code.split(roots).join(policy);

  const configurations = [
    'config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers ?? []),',
    'config: await this.createSessionConfig(request.cwd, additionalDirectories, request.mcpServers),',
  ];
  let configurationCount = 0;
  for (const configuration of configurations) {
    const count = code.split(configuration).length - 1;
    configurationCount += count;
    const call = configuration.slice('config: '.length, -1);
    const replacement = `config: { ...${call}, ...(typeof atelierSessionPolicy === 'string' ? { developer_instructions: atelierSessionPolicy } : {}) },`;
    code = code.split(configuration).join(replacement);
  }
  if (configurationCount !== 3) {
    throw new Error(`codex-acp session config shape changed (${configurationCount}); audit the pinned policy patch`);
  }

  const forkConfiguration = `createSessionConfig: (cwd, directories, mcpServers) =>
                this.createSessionConfig(cwd, directories, mcpServers),`;
  if (code.split(forkConfiguration).length - 1 !== 1) {
    throw new Error('codex-acp fork config shape changed; audit the pinned policy patch');
  }
  code = code.replace(forkConfiguration, `createSessionConfig: async (cwd, directories, mcpServers) =>
                ({ ...await this.createSessionConfig(cwd, directories, mcpServers), ...(typeof atelierSessionPolicy === 'string' ? { developer_instructions: atelierSessionPolicy } : {}) }),`);
  writeFileSync(sessionFile, code);
}

function patchCodexSubagentControl(source) {
  const server = join(source, 'src', 'CodexAcpServer.ts');
  let code = readFileSync(server, 'utf8');
  const methodAnchor = '    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {';
  if (code.split(methodAnchor).length - 1 !== 1) {
    throw new Error('codex-acp extension method shape changed; audit the subagent-control patch');
  }
  const method = `    async atelierSubagentControl(params: {sessionId: string; agentId: string; action: "stop"}) {
        const activeSession = this.sessions.get(params.sessionId);
        if (!activeSession) {
            throw RequestError.invalidParams(undefined, \`Unknown session: \${params.sessionId}\`);
        }
        const [root, child] = await this.runWithProcessCheck(() => Promise.all([
            this.codexAcpClient.readSessionThread(params.sessionId),
            this.codexAcpClient.readSessionThread(params.agentId),
        ]));
        if (child.sessionId !== root.sessionId) {
            throw RequestError.invalidParams(undefined, \`Codex agent \${params.agentId} does not belong to this session\`);
        }
        const active = [...child.turns].reverse().find(turn => turn.status === "inProgress");
        if (!active) {
            throw RequestError.invalidParams(undefined, \`Codex agent \${params.agentId} has no active turn to stop\`);
        }
        await this.runWithProcessCheck(() => this.codexAcpClient.turnInterrupt({
            threadId: params.agentId,
            turnId: active.id,
        }));
        return {ok: true};
    }

${methodAnchor}`;
  code = code.replace(methodAnchor, method);

  const steeringMeta = `                steering: {
                    supported: true,
                },`;
  if (code.split(steeringMeta).length - 1 !== 1) {
    throw new Error('codex-acp initialize metadata changed; audit the subagent-control patch');
  }
  code = code.replace(steeringMeta, `${steeringMeta}
                atelier: {
                    subagentControls: ["stop", "say"],
                },`);
  writeFileSync(server, code);

  const index = join(source, 'src', 'index.ts');
  code = readFileSync(index, 'utf8');
  const parserAnchor = `const sessionSteerParamsParser = z.object({`;
  if (code.split(parserAnchor).length - 1 !== 1) {
    throw new Error('codex-acp extension parser shape changed; audit the subagent-control patch');
  }
  code = code.replace(parserAnchor, `const atelierSubagentControlParamsParser = z.object({
    sessionId: z.string().min(1),
    agentId: z.string().min(1),
    action: z.literal("stop"),
});

${parserAnchor}`);
  const routeAnchor = `        .onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAgent().extMethod(SESSION_STEERING_METHOD, ctx.params))`;
  if (code.split(routeAnchor).length - 1 !== 1) {
    throw new Error('codex-acp extension router shape changed; audit the subagent-control patch');
  }
  code = code.replace(routeAnchor, `        .onRequest("_atelier/session/subagent-control", atelierSubagentControlParamsParser, (ctx) => getAgent().atelierSubagentControl(ctx.params))
${routeAnchor}`);
  writeFileSync(index, code);
}

function patchCodexAccounting(source) {
  const types = join(source, 'src', 'subagents', 'AcpSubagents.ts');
  let code = readFileSync(types, 'utf8');
  const stateType = `export type SubagentStateUpdate = {
    sessionUpdate: "subagent_state_update";
    subagentSessionId: string;
    state: SubagentState;
    _meta?: Record<string, unknown> | null;
};`;
  if (code.split(stateType).length - 1 !== 1) {
    throw new Error('codex-acp subagent update union changed; audit child accounting parity');
  }
  code = code.replace(stateType, `${stateType}

export type SubagentUsageUpdate = {
    sessionUpdate: "subagent_usage_update";
    subagentSessionId: string;
    usage: { seconds: number; tokens: number; calls: number };
    _meta?: Record<string, unknown> | null;
};`);
  const union = `    | SubagentSpawnedUpdate
    | SubagentStateUpdate;`;
  if (code.split(union).length - 1 !== 1) {
    throw new Error('codex-acp subagent union members changed; audit child accounting parity');
  }
  code = code.replace(union, `    | SubagentSpawnedUpdate
    | SubagentStateUpdate
    | SubagentUsageUpdate;`);
  writeFileSync(types, code);

  const router = join(source, 'src', 'subagents', 'CodexSubagentEventRouter.ts');
  code = readFileSync(router, 'utf8');
  const importAnchor = `import type {SubagentState} from "./AcpSubagents";`;
  if (code.split(importAnchor).length - 1 !== 1) {
    throw new Error('codex-acp subagent router imports changed; audit child accounting parity');
  }
  code = code.replace(importAnchor, `import type {SubagentState} from "./AcpSubagents";
import {toTokenCount, type TokenCount} from "../TokenCount";`);
  const childType = `    terminalState?: SubagentState;
};`;
  if (code.split(childType).length - 1 !== 1) {
    throw new Error('codex-acp native child state changed; audit child accounting parity');
  }
  code = code.replace(childType, `    terminalState?: SubagentState;
    usage?: TokenCount;
};`);
  const itemGate = `        if (notification.method !== "item/started" && notification.method !== "item/completed") {
            return false;
        }`;
  if (code.split(itemGate).length - 1 !== 1) {
    throw new Error('codex-acp child notification gate changed; audit child accounting parity');
  }
  code = code.replace(itemGate, `        if (notification.method === "thread/tokenUsage/updated" && this.isKnownChild(notification.params.threadId)) {
            const child = this.children.get(notification.params.threadId);
            if (child) {
                // "last" is this child generation's current turn. "total"
                // spans earlier resumed generations and would bill them again.
                child.usage = toTokenCount(notification.params.tokenUsage.last);
                await this.session.update({
                    sessionUpdate: "subagent_usage_update",
                    subagentSessionId: child.sessionId,
                    usage: {seconds: 0, tokens: child.usage.totalTokens, calls: 0},
                }, child.parentSessionId);
            }
            return true;
        }
${itemGate}`);
  const terminalUpdate = `                subagentSessionId: child.sessionId,
                state,
            }, child.parentSessionId);`;
  if (code.split(terminalUpdate).length - 1 !== 1) {
    throw new Error('codex-acp terminal child update changed; audit child accounting parity');
  }
  code = code.replace(terminalUpdate, `                subagentSessionId: child.sessionId,
                state,
                ...(child.usage ? { _meta: { "atelier.dev/usage": {
                    seconds: 0, tokens: child.usage.totalTokens, calls: 0,
                } } } : {}),
            }, child.parentSessionId);`);
  writeFileSync(router, code);
}

function patchClaudeWindowNow(source) {
  const agent = join(source, 'src', 'acp-agent.ts');
  let code = readFileSync(agent, 'utf8');
  const methodAnchor = '  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {';
  if (code.split(methodAnchor).length - 1 !== 1) {
    throw new Error('claude-agent-acp session method shape changed; audit the context-window patch');
  }
  const method = `  async atelierWindowNow(params: { sessionId: string }) {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, "Unknown session");
    }
    return session.query.getContextUsage();
  }

  async atelierSubagentControl(params: { sessionId: string; agentId: string; action: "stop" | "park" }) {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw RequestError.invalidParams({ sessionId: params.sessionId }, "Unknown session");
    }
    if (params.action === "stop") {
      if (session.asyncTaskRuntime?.canStop(params.agentId)) {
        const stopped = await this.stopAsyncTask({
          sessionId: params.sessionId,
          asyncTaskId: params.agentId,
        });
        return { ok: stopped.stopped };
      }
      await session.query.stopTask(params.agentId);
      return { ok: true };
    }
    const call = session.liveBackgroundTasks.get(params.agentId)?.parentToolUseId;
    if (!call) return { ok: true, parked: false };
    return { ok: true, parked: (await session.query.backgroundTasks(call)) ?? false };
  }

${methodAnchor}`;
  code = code.replace(methodAnchor, method);

  const routeAnchor = '    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))';
  if (code.split(routeAnchor).length - 1 !== 1) {
    throw new Error('claude-agent-acp router shape changed; audit the context-window patch');
  }
  const route = `    .onRequest(
      "_atelier/session/window-now",
      {
        parse: (raw: unknown) => {
          const value = raw as { sessionId?: unknown } | null;
          if (typeof value?.sessionId !== "string" || value.sessionId.length === 0) {
            throw RequestError.invalidParams(raw, "sessionId is required");
          }
          return { sessionId: value.sessionId };
        },
      },
      (ctx) => agent.atelierWindowNow(ctx.params),
    )
    .onRequest(
      "_atelier/session/subagent-control",
      {
        parse: (raw: unknown) => {
          const value = raw as { sessionId?: unknown; agentId?: unknown; action?: unknown } | null;
          if (typeof value?.sessionId !== "string" || value.sessionId.length === 0 ||
              typeof value.agentId !== "string" || value.agentId.length === 0 ||
              (value.action !== "stop" && value.action !== "park")) {
            throw RequestError.invalidParams(raw, "sessionId, agentId, and a valid action are required");
          }
          return {
            sessionId: value.sessionId,
            agentId: value.agentId,
            action: value.action as "stop" | "park",
          };
        },
      },
      (ctx) => agent.atelierSubagentControl(ctx.params),
    )
${routeAnchor}`;
  code = code.replace(routeAnchor, route);
  const steeringMeta = `        steering: {
          supported: true,
        },`;
  if (code.split(steeringMeta).length - 1 !== 1) {
    throw new Error('claude-agent-acp initialize metadata changed; audit the subagent-control patch');
  }
  code = code.replace(steeringMeta, `${steeringMeta}
        atelier: {
          subagentControls: ["stop", "park", "say"],
        },`);
  writeFileSync(agent, code);
}

function patchClaudeAccounting(source) {
  const types = join(source, 'src', 'acp-subagents.ts');
  let code = readFileSync(types, 'utf8');
  const stateType = `export type SubagentStateUpdate = {
  sessionUpdate: "subagent_state_update";
  subagentSessionId: string;
  state: SubagentState;
  _meta?: Record<string, unknown> | null;
};`;
  if (code.split(stateType).length - 1 !== 1) {
    throw new Error('claude-acp subagent update union changed; audit child accounting parity');
  }
  code = code.replace(stateType, `${stateType}

export type SubagentUsageUpdate = {
  sessionUpdate: "subagent_usage_update";
  subagentSessionId: string;
  usage: {
    seconds: number;
    tokens: number;
    calls: number;
    includedInPromptUsage: true;
  };
  _meta?: Record<string, unknown> | null;
};`);
  const union = `  | SubagentStateUpdate
  | AsyncTaskSpawnedUpdate`;
  if (code.split(union).length - 1 !== 1) {
    throw new Error('claude-acp session update members changed; audit child accounting parity');
  }
  code = code.replace(union, `  | SubagentStateUpdate
  | SubagentUsageUpdate
  | AsyncTaskSpawnedUpdate`);
  writeFileSync(types, code);

  const native = join(source, 'src', 'native-subagents.ts');
  code = readFileSync(native, 'utf8');
  const finishAnchor = `  async finishTask(`;
  if (code.split(finishAnchor).length - 1 !== 1) {
    throw new Error('claude-acp native child runtime changed; audit child accounting parity');
  }
  code = code.replace(finishAnchor, `  async toolUsage(
    toolUseId: string,
    usage: { seconds: number; tokens: number; calls: number },
  ): Promise<void> {
    if (!this.enabled) return;
    const child = this.childByParentToolUse.get(toolUseId);
    if (!child) return;
    await announceNativeSubagent(child, this.publish);
    await this.publish({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_usage_update",
        subagentSessionId: child.sessionId,
        usage: { ...usage, includedInPromptUsage: true },
      },
    });
  }

${finishAnchor}`);
  const childAnchor = `      const child = this.childByParentToolUse.get(toolCallId);
      if (child && !child.announced) {`;
  if (code.split(childAnchor).length - 1 !== 1) {
    throw new Error('claude-acp native child routing changed; audit child accounting parity');
  }
  code = code.replace(childAnchor, `      const child = this.childByParentToolUse.get(toolCallId);
      const atelierUsage = update._meta?.["atelier.dev/usage"] as
        { seconds: number; tokens: number; calls: number } | undefined;
      if (child && atelierUsage) await this.toolUsage(toolCallId, atelierUsage);
      if (child && !child.announced) {`);
  writeFileSync(native, code);

  const agent = join(source, 'src', 'acp-agent.ts');
  code = readFileSync(agent, 'utf8');
  const metaType = `export type ToolUpdateMeta = {
  claudeCode?: {`;
  if (code.split(metaType).length - 1 !== 1) {
    throw new Error('claude-acp tool metadata shape changed; audit child accounting parity');
  }
  code = code.replace(metaType, `export type ToolUpdateMeta = {
  "atelier.dev/usage"?: {
    seconds: number; tokens: number; calls: number; includedInPromptUsage: true;
  };
  claudeCode?: {`);

  const resultAnchor = `          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
            toolUseResult,
          );`;
  if (code.split(resultAnchor).length - 1 !== 1) {
    throw new Error('claude-acp tool result shape changed; audit child accounting parity');
  }
  code = code.replace(resultAnchor, `${resultAnchor}
          const atelierAgentUsage =
            (toolUse.name === "Agent" || toolUse.name === "Task") &&
            toolUseResult !== null && typeof toolUseResult === "object"
              ? toolUseResult as { totalDurationMs?: unknown; totalTokens?: unknown; totalToolUseCount?: unknown }
              : null;
          const atelierAgentSpent = atelierAgentUsage
            ? Number(atelierAgentUsage.totalDurationMs ?? 0) +
              Number(atelierAgentUsage.totalTokens ?? 0) +
              Number(atelierAgentUsage.totalToolUseCount ?? 0)
            : 0;`);

  const metaResult = `              claudeCode: {
                toolName: toolUse.name,
                ...(nonExecution ?? {}),
              },
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),`;
  if (code.split(metaResult).length - 1 !== 1) {
    throw new Error('claude-acp completed tool metadata changed; audit child accounting parity');
  }
  code = code.replace(metaResult, `              claudeCode: {
                toolName: toolUse.name,
                ...(nonExecution ?? {}),
              },
              ...(atelierAgentUsage && atelierAgentSpent > 0 ? {
                "atelier.dev/usage": {
                  seconds: Math.round(Number(atelierAgentUsage.totalDurationMs ?? 0) / 1000),
                  tokens: Number(atelierAgentUsage.totalTokens ?? 0),
                  calls: Number(atelierAgentUsage.totalToolUseCount ?? 0),
                  includedInPromptUsage: true,
                },
              } : {}),
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),`);
  writeFileSync(agent, code);
}

function patchNativeQuestionNotes(claudeSource, codexSource) {
  const claude = join(claudeSource, 'src', 'elicitation.ts');
  let code = readFileSync(claude, 'utf8');
  const claudeAnswers = `  const answers: AskUserQuestionOutput["answers"] = {};
  questions.forEach((question, index) => {`;
  if (code.split(claudeAnswers).length - 1 !== 1) {
    throw new Error('claude-acp question response shape changed; audit native note parity');
  }
  code = code.replace(claudeAnswers, `  const answers: AskUserQuestionOutput["answers"] = {};
  const annotations: Record<string, { notes: string }> = {};
  questions.forEach((question, index) => {
    const note = content[\`__atelier_note_\${questionFieldKey(index)}\`];
    if (typeof note === "string" && note.trim() !== "") {
      annotations[question.question] = { notes: note.trim() };
    }`);
  const claudeResult = `  return { action: "answered", updatedInput: { ...toolInput, answers } };`;
  if (code.split(claudeResult).length - 1 !== 1) {
    throw new Error('claude-acp AskUserQuestion result changed; audit native note parity');
  }
  code = code.replace(claudeResult, `  return {
    action: "answered",
    updatedInput: {
      ...toolInput,
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    },
  };`);
  writeFileSync(claude, code);

  const codex = join(codexSource, 'src', 'CodexElicitationHandler.ts');
  code = readFileSync(codex, 'utf8');
  const codexAnswer = `            answers[question.id] = {
                answers: Array.isArray(value)
                    ? value.map(String)
                    : [String(value)],
            };`;
  if (code.split(codexAnswer).length - 1 !== 1) {
    throw new Error('codex-acp request_user_input response changed; audit native note parity');
  }
  code = code.replace(codexAnswer, `            const selectedAnswers = Array.isArray(value)
                ? value.map(String)
                : [String(value)];
            const note = content[\`__atelier_note_\${question.id}\`];
            if (typeof note === "string" && note.trim() !== "") {
                selectedAnswers.push(\`Additional note: \${note.trim()}\`);
            }
            answers[question.id] = { answers: selectedAnswers };`);
  writeFileSync(codex, code);
}

function npmPackage(spec, directory) {
  mkdirSync(directory, { recursive: true });
  run('npm', ['pack', spec, '--pack-destination', directory], directory);
  const archive = readdirSync(directory).find(name => name.endsWith('.tgz'));
  if (!archive) throw new Error(`npm pack produced no archive for ${spec}`);
  run('tar', ['-xzf', archive], directory);
  return join(directory, 'package');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const target = process.argv[2];
const output = resolve(process.argv[3] ?? 'dist/atelier-adapters');
const platform = TARGETS[target];
if (!platform) {
  throw new Error(`usage: build-acp-adapters.mjs <${Object.keys(TARGETS).join('|')}> [output]`);
}

const scratch = mkdtempSync(join(tmpdir(), 'atelier-acp-build-'));
try {
  const claudeSource = join(scratch, 'claude-agent-acp');
  const codexSource = join(scratch, 'codex-acp');
  const gooseSource = join(scratch, 'goose');
  clonePinned(CLAUDE, claudeSource);
  clonePinned(CODEX, codexSource);
  clonePinnedRust(GOOSE, gooseSource);
  const gooseLock = readFileSync(join(gooseSource, 'Cargo.lock'), 'utf8');
  if (!/name = "agent-client-protocol"\nversion = "1\.0\.0"/.test(gooseLock)) {
    throw new Error('Goose ACP wire dependency changed; audit the Rust connector before release');
  }
  const claudeWire = acpWireVersion(claudeSource);
  const codexWire = acpWireVersion(codexSource);
  if (claudeWire !== '1' || codexWire !== '1') {
    throw new Error(`adapter ACP wire changed (Claude ${claudeWire}, Codex ${codexWire}); audit and upgrade the Rust connector before release`);
  }
  verifyNativeCapabilities(claudeSource, codexSource);
  patchCodexAppServerTransport(codexSource);
  patchCodexSessionPolicy(codexSource);
  patchCodexSubagentControl(codexSource);
  patchCodexAccounting(codexSource);
  patchClaudeWindowNow(claudeSource);
  patchClaudeAccounting(claudeSource);
  patchNativeQuestionNotes(claudeSource, codexSource);

  // Bun deliberately transpiles without type-checking. These adapters are
  // patched at pinned source revisions, so make their own compiler contracts
  // part of the release build before producing any executable artifacts.
  run('npm', ['run', 'build'], claudeSource);
  run('npm', ['run', 'typecheck'], codexSource);

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const claudeAdapter = join(output, `claude-acp${platform.exe}`);
  const codexAdapter = join(output, `codex-acp${platform.exe}`);
  const gooseAdapter = join(output, `goose-acp${platform.exe}`);
  run('bun', ['build', 'src/index.ts', '--minify', '--compile', `--target=${platform.bun}`, `--outfile=${claudeAdapter}`], claudeSource);
  run('bun', ['build', 'src/index.ts', '--minify', '--compile', `--target=${platform.bun}`, `--outfile=${codexAdapter}`], codexSource);
  run('cargo', ['build', '--release', '--locked', '--target', target, '-p', 'goose-cli', '--bin', 'goose'], gooseSource);
  cpSync(join(gooseSource, 'target', target, 'release', `goose${platform.exe}`), gooseAdapter);

  const claudePackage = npmPackage(
    `@anthropic-ai/claude-agent-sdk-${platform.claude}@${CLAUDE.providerVersion}`,
    join(scratch, 'claude-provider'),
  );
  const codexPackage = npmPackage(
    `@openai/codex@${CODEX.providerVersion}-${platform.codex}`,
    join(scratch, 'codex-provider'),
  );
  const claudeNative = join(claudePackage, `claude${platform.exe}`);
  const codexNative = join(codexPackage, 'vendor', platform.codexTriple, 'bin', `codex${platform.exe}`);
  const codexCodeModeHostNative = join(codexPackage, 'vendor', platform.codexTriple, 'bin', `codex-code-mode-host${platform.exe}`);
  if (!existsSync(claudeNative) || !existsSync(codexNative) || !existsSync(codexCodeModeHostNative)) {
    throw new Error(`provider package layout changed for ${target}`);
  }
  const claudeProvider = join(output, `claude-provider${platform.exe}`);
  const codexProvider = join(output, `codex-provider${platform.exe}`);
  const codexCodeModeHost = join(output, `codex-code-mode-host${platform.exe}`);
  cpSync(claudeNative, claudeProvider);
  cpSync(codexNative, codexProvider);
  cpSync(codexCodeModeHostNative, codexCodeModeHost);
  if (!platform.exe) {
    for (const file of [claudeAdapter, codexAdapter, gooseAdapter, claudeProvider, codexProvider, codexCodeModeHost]) chmodSync(file, 0o755);
  }

  const files = [claudeAdapter, codexAdapter, gooseAdapter, claudeProvider, codexProvider, codexCodeModeHost];
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify({
    schema: 1,
    target,
    adapters: {
      claude: {
        version: CLAUDE.version, commit: CLAUDE.commit, providerVersion: CLAUDE.providerVersion, wireProtocol: 1,
        compatibilityPatches: ['atelier-context-window', 'atelier-native-subagent-control', 'atelier-child-accounting', 'atelier-native-question-notes'],
        verifiedCapabilities: ['native-mcp-config', 'session-resume'],
      },
      codex: {
        version: CODEX.version, commit: CODEX.commit, providerVersion: CODEX.providerVersion, wireProtocol: 1,
        compatibilityPatches: ['app-server-stdio', 'bun-child-process-bridge', 'jsonrpc-2-framing', 'atelier-session-policy', 'atelier-native-subagent-control', 'atelier-child-accounting', 'atelier-native-question-notes'],
        verifiedCapabilities: ['native-mcp-config', 'session-resume'],
      },
      local: { adapter: 'goose', version: GOOSE.version, commit: GOOSE.commit, wireProtocol: 1 },
    },
    files: Object.fromEntries(files.map(path => [basename(path), { sha256: sha256(path) }])),
  }, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
