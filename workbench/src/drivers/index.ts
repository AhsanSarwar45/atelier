import type { Brand } from '../../../src/workbench/protocol.ts';
import { ClaudeDriver } from './claude.ts';
import { CodexDriver } from './codex.ts';
import type { Driver } from './types.ts';

/** The only place the runtime chooses a vendor implementation. */
export function createDriver(brand: Brand): Driver {
  switch (brand) {
    case 'claude': return new ClaudeDriver();
    case 'codex': return new CodexDriver();
  }
}

export function defaultPermissionMode(brand: Brand): string {
  return brand === 'codex' ? 'on-request' : 'default';
}
