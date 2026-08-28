import { describe, expect, it } from 'vitest';

import {
  commandsInCodeMode,
  normalizeCommands,
} from '@/workbench/command-normalization';

const one = (value: string | readonly string[], source: 'direct' | 'code-mode' = 'direct') => {
  const normalized = normalizeCommands(value, source);
  expect(normalized.commands).toHaveLength(1);
  return normalized.commands[0]!;
};

describe('provider command envelopes', () => {
  it('keeps a direct Claude command as the semantic command', () => {
    expect(one('npm test')).toMatchObject({ command: 'npm test', boundaries: [], confidence: 'schema' });
  });

  it('preserves argv and unwraps a native Codex shell launcher without reparsing its payload', () => {
    expect(one(['/bin/bash', '-lc', 'rg "a b" src && npm test'])).toMatchObject({
      command: 'rg "a b" src && npm test',
      boundaries: [{ kind: 'shell', via: 'bash' }],
    });
  });

  it('renders direct argv faithfully without turning argument data into shell syntax', () => {
    expect(one(['grep', 'rm -rf /', 'notes.txt'])).toMatchObject({
      command: "grep 'rm -rf /' notes.txt",
      boundaries: [],
      confidence: 'schema',
    });
  });

  it('extracts every static command call from one Codex code-mode envelope in source order', () => {
    const code = `
      const first = await tools.exec_command({"cmd":"npm test","workdir":"/repo"});
      text(first.output);
      const second = await functions.exec_command({ command: 'cargo test' });
    `;
    expect(normalizeCommands(code, 'code-mode').commands.map((command) => command.command)).toEqual([
      'npm test',
      'cargo test',
    ]);
  });

  it('does not execute or guess a dynamically constructed command', () => {
    const code = 'await tools.exec_command({ cmd: makeCommand() })';
    expect(normalizeCommands(code, 'code-mode')).toMatchObject({ commands: [], status: 'opaque' });
  });

  it('does not promote command-looking strings in JavaScript data or comments', () => {
    const code = `
      const example = "tools.exec_command({cmd: 'rm -rf /'})";
      // tools.exec_command({cmd: 'rm -rf /tmp/comment'})
      await tools.exec_command({cmd: 'printf "%s" "rm -rf /"'});
    `;
    expect(commandsInCodeMode(code)).toEqual(['printf "%s" "rm -rf /"']);
  });
});

describe('recognized process wrappers', () => {
  it.each([
    ['bash -lc \'npm test\'', 'npm test', ['shell']],
    ['env CI=1 bash -c \'npm test\'', 'npm test', ['environment', 'shell']],
    ['sudo -u app -- bash -lc \'npm test\'', 'npm test', ['user', 'shell']],
    ['timeout --signal TERM 30s sh -c \'cargo test\'', 'cargo test', ['limit', 'shell']],
    ['docker --context prod exec -u app web bash -lc \'pytest -q\'', 'pytest -q', ['container', 'shell']],
    ['podman exec api sh -c \'npm test\'', 'npm test', ['container', 'shell']],
    ['kubectl -n api exec pod/web -c web -- sh -c \'rm -rf /tmp/cache\'', 'rm -rf /tmp/cache', ['container', 'shell']],
    ['ssh -p 2222 buildbox -- env CI=1 npm test', 'npm test', ['remote', 'environment']],
    ['npx vitest run src/x.test.ts', 'vitest run src/x.test.ts', ['package']],
    ['pnpm exec eslint .', 'eslint .', ['package']],
    ['rtk proxy git status --short', 'git status --short', ['proxy']],
  ])('peels %s down to the command that actually runs', (wrapped, command, kinds) => {
    const normalized = one(wrapped);
    expect(normalized.command).toBe(command);
    expect(normalized.boundaries.map((boundary) => boundary.kind)).toEqual(kinds);
  });

  it('does not reinterpret an interpreter program as shell', () => {
    expect(one("python -c 'print(1)'").command).toBe("python -c 'print(1)'");
    expect(one('bash scripts/check.sh').command).toBe('bash scripts/check.sh');
    expect(one('bash -n check.sh && git -c color.ui=false status').command)
      .toBe('bash -n check.sh && git -c color.ui=false status');
  });

  it('does not discard outer work after a wrapped process', () => {
    const command = "setsid bash -c 'npm test' & sleep 1; rm -rf cache";
    expect(one(command).command).toBe(command);
  });

  it('peels leading environment assignments only for one complete invocation', () => {
    expect(one("CI=1 bash -lc 'npm test'")).toMatchObject({
      command: 'npm test',
      boundaries: [{ kind: 'environment' }, { kind: 'shell' }],
    });
  });

  it('leaves quoted command-looking data attached to the program that received it', () => {
    expect(one(`grep 'bash -lc "rm -rf /"' notes.txt`).command).toBe(`grep 'bash -lc "rm -rf /"' notes.txt`);
    expect(one(`printf '%s' 'rm -rf /'`).command).toBe(`printf '%s' 'rm -rf /'`);
  });

  it('preserves remote and container boundaries after exposing a destructive command', () => {
    expect(one("ssh box -- sh -c 'rm -rf cache'")).toMatchObject({
      command: 'rm -rf cache',
      boundaries: [
        { kind: 'remote', via: 'ssh', target: 'box' },
        { kind: 'shell', via: 'sh' },
      ],
    });
    expect(one('docker exec app rm -rf cache')).toMatchObject({
      command: 'rm -rf cache',
      boundaries: [{ kind: 'container', via: 'docker exec', target: 'app' }],
    });
  });
});
