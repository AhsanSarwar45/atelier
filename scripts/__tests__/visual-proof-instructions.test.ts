import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Wrapping is layout, not policy: match with whitespace collapsed.
const policy = readFileSync('machinery/skills/atelier/SKILL.md', 'utf8').replace(/\s+/g, ' ');
// The full storage story is read on demand; every session keeps the prohibition.
const reference = readFileSync('machinery/skills/atelier-reference/SKILL.md', 'utf8').replace(/\s+/g, ' ');

describe('visual proof instructions', () => {
  it('requires comparisons for changes and an image for new visuals', () => {
    const instructions = policy;
    expect(instructions).toMatch(/every visual change/i);
    expect(instructions).toMatch(/before editing/i);
    expect(instructions).toMatch(/again\s+after(?:ward)?/i);
    expect(instructions).toMatch(/presenter/i);
    expect(instructions).toMatch(/newly added visual/i);
    expect(instructions).toMatch(/import and show|present image/i);
    expect(instructions).toMatch(/do not wait for the manager to ask/i);
  });

  it('uses the validated durable image commands for visual proof', () => {
    expect(policy).toContain('atelier tool present image');
    expect(policy).toContain('atelier tool present compare');
    expect(reference).toMatch(/content-addressed storage/i);
    expect(reference).toMatch(/remains available after reload/i);
  });

  it('leaves durable persistence entirely to the running Atelier app', () => {
    expect(policy).toMatch(/uploads files to the running Atelier app/i);
    expect(reference).toMatch(/project or a temporary directory/i);
    expect(reference).toMatch(/uploads its bytes to the running Atelier app/i);
    expect(reference).toMatch(/app validates them, writes them to the one durable media directory/i);
    // Shared between every copy on the computer, or an agent presenting through
    // its worktree's throwaway copy leaves the reader a 404 (bw-9px0.13).
    expect(reference).toMatch(/every copy\s+of Atelier on the computer reads/i);
    expect(policy).toMatch(/never create or write\s+`ATELIER_DATA_DIR` or `presentation-media`/i);
    expect(policy).toMatch(/never.+request provider-specific filesystem permission/is);
  });
});
