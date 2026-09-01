#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const CLAUDE = Object.freeze({
  version: '0.70.0',
  commit: 'd0aafb1ca26427285ffaeac8d8a4452fff28e9c3',
  repository: 'https://github.com/agentclientprotocol/claude-agent-acp.git',
  providerVersion: '0.3.232',
});
const CODEX = Object.freeze({
  version: '1.7.0',
  commit: '2b48e9822330fc09f3a94a81563e5c4bb779601a',
  repository: 'https://github.com/agentclientprotocol/codex-acp.git',
  providerVersion: '0.148.0',
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
  run('npm', ['ci', '--ignore-scripts', '--omit=optional'], destination);
}

function clonePinnedRust(source, destination) {
  run('git', ['clone', '--filter=blob:none', '--no-checkout', source.repository, destination]);
  run('git', ['checkout', '--detach', source.commit], destination);
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
  code = code.replace(launchAnchor, `        const subprocess = Bun.spawn([codexPath, 'app-server', '--stdio'], {
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
        void subprocess.exited.then(code => events.emit('exit', code, null));
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
  if (rootCount !== 3) {
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
  writeFileSync(sessionFile, code);
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
${routeAnchor}`;
  writeFileSync(agent, code.replace(routeAnchor, route));
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
  patchCodexAppServerTransport(codexSource);
  patchCodexSessionPolicy(codexSource);
  patchClaudeWindowNow(claudeSource);

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
        compatibilityPatches: ['atelier-context-window'],
      },
      codex: {
        version: CODEX.version, commit: CODEX.commit, providerVersion: CODEX.providerVersion, wireProtocol: 1,
        compatibilityPatches: ['app-server-stdio', 'bun-child-process-bridge', 'jsonrpc-2-framing', 'atelier-session-policy'],
      },
      local: { adapter: 'goose', version: GOOSE.version, commit: GOOSE.commit, wireProtocol: 1 },
    },
    files: Object.fromEntries(files.map(path => [basename(path), { sha256: sha256(path) }])),
  }, null, 2)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
