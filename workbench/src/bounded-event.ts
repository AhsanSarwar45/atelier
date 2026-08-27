import type { WbpEvent } from '../../src/workbench/protocol.ts';
import { cut, trimInput } from '../../src/workbench/imported-history.ts';
import { toolTitle } from '../../src/workbench/said-what-it-ran.ts';
import type { DriverEvent } from './drivers/types.ts';

/** The provider-neutral storage/wire boundary for unbounded tool payloads. */
export function boundedEvent<T extends DriverEvent | WbpEvent>(event: T): T {
  if (event.type === 'tool.started') {
    const input = trimInput(event.input);
    return { ...event, input, title: toolTitle(event.name, input) } as T;
  }
  if (event.type === 'tool.completed') return { ...event, output: cut(event.output) } as T;
  if (event.type === 'diff') return { ...event, before: cut(event.before), after: cut(event.after) } as T;
  if (event.type === 'agent.finished') return { ...event, result: cut(event.result) } as T;
  return event;
}
