// Report the window Claude Code itself measures against, on every usage update.
//
// Upstream fills `usage_update.size` from a guess until a turn ends: a cached
// figure, else a "1m" in the model's name, else 200k. A chat that wakes on a
// fresh adapter, on a model alias with no "1m" in it, therefore shows 200k
// through its whole first turn and jumps when the result lands (bw-si0em). The
// result's figure is no better for this gauge: `modelUsage.contextWindow` is
// the model's raw limit (1M), while the CLI compacts at the configured
// `autoCompactWindow` (256k here). `getContextUsage().rawMaxTokens` is the
// figure the CLI measures against, and it answers before a resumed session's
// first prompt, mid-way through a fresh session's first turn, and after a
// result (measured 2026-10-27, SDK 0.3.257). So ask it once a turn, again after
// a model switch, and send that.
export function patchClaudeLiveWindow(source) {
  const size = 'size: session.contextWindowSize,';
  const result = 'session.contextWindowSize = matchingModelUsage.usage.contextWindow;';
  const switched = 'session.contextWindowAuthoritative = seeded.authoritative;';
  const helperAnchor = 'function inferContextWindowFromModel(';
  if (source.split(size).length !== 5 || source.split(result).length !== 2
    || source.split(switched).length !== 2 || source.split(helperAnchor).length !== 2) {
    throw new Error('Claude context-window anchors changed; audit the live-window patch');
  }
  const helper = `/** The window the CLI measures against, asked once per turn (bw-si0em). */
const atelierLiveWindows = new WeakMap<object, number>();

async function atelierLiveWindow(session: { query: Query; contextWindowSize: number }): Promise<number> {
  const known = atelierLiveWindows.get(session);
  if (known !== undefined) return known;
  const asked = await Promise.race([
    session.query.getContextUsage().then((usage) => usage.rawMaxTokens, () => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);
  if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) {
    return session.contextWindowSize;
  }
  atelierLiveWindows.set(session, asked);
  session.contextWindowSize = asked;
  return asked;
}

${helperAnchor}`;
  return source
    .replaceAll(size, 'size: await atelierLiveWindow(session),')
    .replace(result, `${result}
                // Settings can change between turns; ask again (bw-si0em).
                atelierLiveWindows.delete(session);`)
    .replace(switched, `${switched}
        atelierLiveWindows.delete(session);`)
    .replace(helperAnchor, helper);
}
