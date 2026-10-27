import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { patchClaudeLiveWindow } from '../claude-live-window.mjs';

// The four upstream shapes the patch rewrites, cut down to what they do with
// the window: every usage update sends `size`, a result overwrites the window
// with the model's raw limit, and a model switch reseeds it from a guess.
const upstream = `
type Query = { getContextUsage(): Promise<{ rawMaxTokens: number }> };
type Session = { query: Query; contextWindowSize: number; contextWindowAuthoritative: boolean };
const sent: number[] = [];
async function sendUpdate(update: { size: number }) { sent.push(update.size); }
export async function streamed(session: Session) { await sendUpdate({ size: session.contextWindowSize, }); }
export async function compacted(session: Session) { await sendUpdate({ size: session.contextWindowSize, }); }
export async function limited(session: Session) { await sendUpdate({ size: session.contextWindowSize, }); }
export async function resulted(session: Session, matchingModelUsage: { usage: { contextWindow: number } }) {
  session.contextWindowSize = matchingModelUsage.usage.contextWindow;
  await sendUpdate({ size: session.contextWindowSize, });
}
export function switched(session: Session, seeded: { size: number; authoritative: boolean }) {
  session.contextWindowSize = seeded.size;
  session.contextWindowAuthoritative = seeded.authoritative;
}
export function updates() { return sent.splice(0); }
function inferContextWindowFromModel(text: string) { return /1m/.test(text) ? 1_000_000 : null; }
`;

type Session = { query: { getContextUsage(): Promise<{ rawMaxTokens: number }> }; contextWindowSize: number; contextWindowAuthoritative: boolean };
type Patched = {
  streamed(session: Session): Promise<void>;
  compacted(session: Session): Promise<void>;
  limited(session: Session): Promise<void>;
  resulted(session: Session, usage: { usage: { contextWindow: number } }): Promise<void>;
  switched(session: Session, seeded: { size: number; authoritative: boolean }): void;
  updates(): number[];
};

function load(): Patched {
  const compiled = ts.transpileModule(patchClaudeLiveWindow(upstream), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {} as Patched;
  new Function('exports', compiled)(exports);
  return exports;
}

function session(answers: Array<number | Error>) {
  const asked: number[] = [];
  const value: Session = {
    contextWindowSize: 200_000,
    contextWindowAuthoritative: false,
    query: {
      getContextUsage: async () => {
        asked.push(asked.length);
        const answer = answers.shift() ?? 0;
        if (answer instanceof Error) throw answer;
        return { rawMaxTokens: answer };
      },
    },
  };
  return { value, asked };
}

describe('the Claude adapter reports the window the CLI measures against', () => {
  it('sends the CLI window from the first update of a turn and asks once', async () => {
    const agent = load();
    const chat = session([256_000]);
    await agent.streamed(chat.value);
    await agent.compacted(chat.value);
    await agent.limited(chat.value);
    expect(agent.updates()).toEqual([256_000, 256_000, 256_000]);
    expect(chat.asked).toHaveLength(1);
  });

  it("keeps the CLI window over the result's raw model limit, asking again for the next turn", async () => {
    const agent = load();
    const chat = session([256_000, 300_000]);
    await agent.streamed(chat.value);
    await agent.resulted(chat.value, { usage: { contextWindow: 1_000_000 } });
    expect(agent.updates()).toEqual([256_000, 300_000]);
    expect(chat.asked).toHaveLength(2);
  });

  it('asks again after a model switch instead of keeping the old model window', async () => {
    const agent = load();
    const chat = session([256_000, 1_000_000]);
    await agent.streamed(chat.value);
    agent.switched(chat.value, { size: 200_000, authoritative: false });
    await agent.streamed(chat.value);
    expect(agent.updates()).toEqual([256_000, 1_000_000]);
  });

  it('falls back to the known window when the CLI cannot answer, and asks again next time', async () => {
    const agent = load();
    const chat = session([new Error('closed'), 256_000]);
    await agent.streamed(chat.value);
    await agent.streamed(chat.value);
    expect(agent.updates()).toEqual([200_000, 256_000]);
  });

  it('refuses to patch an adapter whose shapes moved', () => {
    expect(() => patchClaudeLiveWindow(upstream.replace('function inferContextWindowFromModel(', 'function other('))).toThrow(/audit the live-window patch/);
  });
});
