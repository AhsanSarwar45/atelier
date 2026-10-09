// Preserve upstream's held prompt and permission handling, but expose why the
// prompt is still open after the parent's result (upstream issues 864/866).
//
// Also pass on the CLI's own processing state. Claude starts a turn by itself
// when a background command ends or a wakeup fires; that turn belongs to no
// prompt, so nothing else on the wire says it began or ended. The CLI says
// `running` before every cycle and `idle` after it ("authoritative turn-over
// signal", SDKSessionStateChangedMessage), and upstream reads it and drops it.
export function patchClaudeTurnPhase(source) {
  const definition = 'const settleOrDefer = (outcome: PromptResponse) => {';
  const deferred = 'session.activeTurn.deferredSettle = outcome;';
  const cycle = 'session.lastSessionState = message.state;';
  const calls = /(?<!await )settleOrDefer\(turnOutcome\(session, (?:"cancelled"|"refusal"|"end_turn"|stopReason)\)\);/g;
  if (source.split(definition).length !== 2 || source.split(deferred).length !== 2
    || source.split(cycle).length !== 2 || [...source.matchAll(calls)].length !== 4) {
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
    .replace(cycle, `${cycle}
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "session_info_update",
                    _meta: { atelier: { cycle: message.state } },
                  },
                });`)
    .replace(calls, call => `await ${call}`);
}
