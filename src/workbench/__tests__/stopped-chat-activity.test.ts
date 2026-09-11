import { describe, expect, it } from 'vitest';
import { chatState } from '@/workbench/chat-state';

describe('activity belongs to an active chat', () => {
  it.each(['idle', 'stopped', 'dormant', 'errored'] as const)(
    '%s cannot display a remembered command',
    (state) => {
      const current = chatState({
        state,
        call: { name: 'Bash', input: { command: 'bd update bw-105s.1 --claim' } },
        detail: 'bd update bw-105s.1 --claim',
        since: 1000,
        turnSince: 500,
      });
      expect(current.word).toBe({ idle: 'Ready', stopped: 'Stopped', dormant: 'Asleep', errored: 'Failed' }[state]);
      expect(current.detail).toBeNull();
      expect(current.working).toBe(false);
      expect(current.since).toBeNull();
      expect(current.turnSince).toBeNull();
    },
  );
});
