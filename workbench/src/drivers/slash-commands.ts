import type { CommandInfo } from '../../../src/workbench/protocol.ts';

/** A slash-shaped user turn, split without interpreting provider arguments. */
export interface SlashInvocation {
  name: string;
  argument: string;
}

type DiscoveredCommand = Pick<CommandInfo, 'name' | 'description' | 'argumentHint'>;

/** Turn provider discovery into the one menu shape shared by every brand. */
export function advertisedSlashCommands(
  discovered: readonly DiscoveredCommand[],
  skillNames: readonly string[],
  hidden: ReadonlySet<string> = new Set(),
): CommandInfo[] {
  const skills = new Set(skillNames);
  const commands: CommandInfo[] = discovered
    .filter((command) => !hidden.has(command.name))
    .map((command) => ({
      ...command,
      kind: skills.has(command.name) ? 'skill' : 'command',
      execution: skills.has(command.name) ? 'skill' : 'native',
    }));
  for (const name of skills) {
    if (!commands.some((command) => command.name === name)) {
      commands.push({ name, description: '', kind: 'skill', execution: 'skill' });
    }
  }
  return commands;
}

/** Parse only a command at the beginning of a turn; ordinary prose is untouched. */
export function slashInvocation(text: string): SlashInvocation | null {
  const found = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return found ? { name: found[1]!, argument: found[2]?.trim() ?? '' } : null;
}

/** Resolve a typed invocation against exactly what this session advertised. */
export function offeredSlashCommand(text: string, commands: readonly CommandInfo[]): {
  invocation: SlashInvocation;
  command: CommandInfo;
} | null {
  const invocation = slashInvocation(text);
  if (!invocation) return null;
  const command = commands.find((candidate) => candidate.name === invocation.name);
  if (!command) throw new Error(`/${invocation.name} is not available in this ${commands.length ? 'session' : 'provider'}.`);
  return { invocation, command };
}

/** Backward-compatible normalization for events written by older helpers. */
export function commandExecution(command: CommandInfo): NonNullable<CommandInfo['execution']> {
  return command.execution ?? (command.kind === 'skill' ? 'skill' : 'native');
}
