/**
 * Reading the kit's own `/context` answer into the shape the panel draws.
 *
 * The fixture is a real answer, trimmed: measured from the kit on 2026-08-20
 * against this project, with the grid of coloured squares dropped because the
 * panel draws its own bar (bw-3ug7).
 */
import { describe, expect, it } from 'vitest';

import { readWindow, type RawWindowNow } from '@/workbench/window-now';

const real: RawWindowNow = {
  categories: [
    { name: 'System prompt', tokens: 274 },
    { name: 'System tools', tokens: 12_204 },
    { name: 'MCP tools (deferred)', tokens: 367, isDeferred: true },
    { name: 'System tools (deferred)', tokens: 15_015, isDeferred: true },
    { name: 'Custom agents', tokens: 1_281 },
    { name: 'Memory files', tokens: 4_452 },
    { name: 'Skills', tokens: 3_369 },
    { name: 'Messages', tokens: 4_504 },
    { name: 'Autocompact buffer', tokens: 33_000 },
    { name: 'Free space', tokens: 140_916 },
  ],
  totalTokens: 26_084,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  percentage: 13,
  model: 'claude-opus-5',
  memoryFiles: [
    { path: '/home/ahsan/.claude/CLAUDE.md', type: 'User', tokens: 1_185 },
    { path: '/home/ahsan/dev/beads-web/CLAUDE.md', type: 'Project', tokens: 2_924 },
    { path: '/home/ahsan/.claude/RTK.md', type: 'User', tokens: 233 },
  ],
  mcpTools: [
    { name: 'mcp__codegraph__codegraph_explore', serverName: 'codegraph', tokens: 367, isLoaded: false },
    { name: 'mcp__notion__search', serverName: 'notion', tokens: 500, isLoaded: true },
    { name: 'mcp__notion__fetch', serverName: 'notion', tokens: 400, isLoaded: true },
  ],
  autoCompactThreshold: 167_000,
  isAutoCompactEnabled: true,
  messageBreakdown: {
    toolCallTokens: 300,
    toolResultTokens: 1_200,
    attachmentTokens: 6_587,
    assistantMessageTokens: 900,
    userMessageTokens: 100,
    redirectedContextTokens: 0,
    unattributedTokens: 13,
    toolCallsByType: [
      { name: 'Read', callTokens: 100, resultTokens: 900 },
      { name: 'Bash', callTokens: 200, resultTokens: 300 },
    ],
    attachmentsByType: [
      { name: 'hook_success', tokens: 4_206 },
      { name: 'hook_additional_context', tokens: 2_381 },
    ],
  },
};

describe('what is in the window', () => {
  it('tells the three kinds of band apart: filled, room, and waiting to be fetched', () => {
    const now = readWindow(real)!;
    expect(now.pieces.map((p) => p.name)).toEqual([
      'System tools',
      'Messages',
      'Memory files',
      'Skills',
      'Custom agents',
      'System prompt',
    ]);
    expect(now.spare.map((p) => p.name)).toEqual(['Free space', 'Autocompact buffer']);
    expect(now.waiting.map((p) => p.name)).toEqual(['System tools (deferred)', 'MCP tools (deferred)']);
  });

  it('has the filled bands add to what the kit says is filled, the waiting ones excluded', () => {
    // Measured, not assumed: the deferred tools are 15,382 tokens that are NOT
    // in the window until something calls for them, and counting them would put
    // the panel 59 percent above the gauge on the same line.
    const now = readWindow(real)!;
    expect(now.pieces.reduce((sum, p) => sum + p.tokens, 0)).toBe(now.used);
    expect(now.used).toBe(26_084);
  });

  it('measures a share against the whole window, so a bar can be drawn straight off it', () => {
    const now = readWindow(real)!;
    expect(now.window).toBe(200_000);
    expect(now.free).toBe(173_916);
    expect(now.pieces[0]!.share).toBeCloseTo(12_204 / 200_000, 10);
    expect([...now.pieces, ...now.spare].reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1, 10);
  });

  it("keeps the kit's own percentage rather than working one out", () => {
    // So this and the kit's `/context` never disagree by a point of rounding.
    expect(readWindow(real)!.percent).toBe(13);
  });

  it('says where the chat will forget itself, and nothing when it will not', () => {
    expect(readWindow(real)!.forgetsAt).toBe(167_000);
    expect(readWindow({ ...real, isAutoCompactEnabled: false })!.forgetsAt).toBeNull();
  });

  it('names the memory files, biggest first: they are what a reader can delete', () => {
    expect(readWindow(real)!.memory.map((m) => m.tokens)).toEqual([2_924, 1_185, 233]);
  });

  it('folds one server’s tools into one row, because a server is what gets turned off', () => {
    expect(readWindow(real)!.servers).toEqual([
      { name: 'notion', tokens: 900, tools: 2, loaded: 2 },
      { name: 'codegraph', tokens: 367, tools: 1, loaded: 0 },
    ]);
  });

  it('says nothing at all about an answer carrying no window', () => {
    expect(readWindow(null)).toBeNull();
    expect(readWindow({})).toBeNull();
    expect(readWindow({ totalTokens: 5 })).toBeNull();
  });
});

describe('what the conversation itself is made of', () => {
  it('counts a call and what it came back with as one thing, biggest first', () => {
    // They are one decision: a reader who stops using a tool loses both.
    expect(readWindow(real)!.inside!.byTool).toEqual([
      { name: 'Read', tokens: 1_000 },
      { name: 'Bash', tokens: 500 },
    ]);
  });

  it('adds its own parts rather than borrowing the band above', () => {
    // They disagree, and the kit is the one that measures them two ways: on a
    // fresh chat here the parts came to 6,587 against a Messages band of 4,504.
    // So a share of this list is a share of THIS total (2026-08-20).
    const inside = readWindow(real)!.inside!;
    expect(inside.total).toBe(300 + 1_200 + 6_587 + 900 + 100 + 0 + 13);
    expect(inside.answers).toBe(1_200);
    expect(inside.attachments).toBe(6_587);
    expect(inside.byAttachment[0]).toEqual({ name: 'hook_success', tokens: 4_206 });
  });

  it('has nothing to say about a chat that has said nothing', () => {
    expect(readWindow({ ...real, messageBreakdown: undefined })!.inside).toBeNull();
    expect(readWindow({ ...real, messageBreakdown: { toolCallTokens: 0 } })!.inside).toBeNull();
  });
});
