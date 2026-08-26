import { describe, expect, it } from 'vitest';

import { conversationTitle } from '../conversation-title.ts';

describe('conversationTitle', () => {
  it('names the subject instead of copying a clipped opening prompt', () => {
    const prompt = 'look at all these chats. they are just being names with the first message not an agent defined message like in normal chat apps';
    const title = conversationTitle(prompt);

    expect(title).toBe('Agent Defined Message Normal Chat Apps');
    expect(prompt.startsWith(title ?? '')).toBe(false);
  });

  it('drops conversational request scaffolding and keeps technical terms', () => {
    expect(conversationTitle('Could you please fix the WebSocket reconnect loop in APIClient?'))
      .toBe('Fix WebSocket Reconnect Loop APIClient');
  });

  it('returns no invented name for an empty or markup-only turn', () => {
    expect(conversationTitle('   <context></context>   ')).toBeNull();
  });
});
