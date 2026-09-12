// Preserve upstream's held prompt and permission handling, but expose why the
// prompt is still open after the parent's result (upstream issues 864/866).
export function patchClaudeTurnPhase(source) {
  const definition = 'const settleOrDefer = (outcome: PromptResponse) => {';
  const deferred = 'session.activeTurn.deferredSettle = outcome;';
  const calls = /(?<!await )settleOrDefer\(turnOutcome\(session, (?:"cancelled"|"refusal"|"end_turn"|stopReason)\)\);/g;
  if (source.split(definition).length !== 2 || source.split(deferred).length !== 2 || [...source.matchAll(calls)].length !== 4) {
    throw new Error('Claude deferred-settlement anchors changed; audit the pinned adapter');
  }
  return source.replace(definition, definition.replace('= (', '= async ('))
    .replace(deferred, `${deferred}
        await sendUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            _meta: { atelier: { turnPhase: "waiting_for_agents" } },
          },
        });`)
    .replace(calls, call => `await ${call}`);
}
