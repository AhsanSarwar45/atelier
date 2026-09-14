import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const USER_FACING_FILES = [
  'src/workbench/agent-view.tsx',
  'src/workbench/chat-right-rail.tsx',
  'src/workbench/sent-away.tsx',
  'src/workbench/token-view.tsx',
  'src/workbench/usage-view.tsx',
  'src/workbench/accounts-settings.tsx',
  'src/workbench/paths-in-html.ts',
  'src/workbench/terminal-window.tsx',
  'src/app/page.tsx',
  'src/app/settings/page.tsx',
  'src/components/settings/provider-schema.ts',
  'scripts/spend-counted-once.mjs',
  'server/src/command_line.rs',
  'server/src/main.rs',
];

const OVERWRITTEN_COPY = [
  'Cards it has touched',
  'Sent away',
  'This one said nothing of its own',
  'Extra usage credits',
  'In the window right now',
  'Room left',
  'This task, from its first word',
  'Read back',
  'Kept ready',
  'Sent fresh',
  'Written back',
  'Where it went',
  'This chat itself',
  'There is nothing else to start',
  'Manage Your Projects',
  'Highly recommended to use with',
  'Who each provider runs as',
  'The command-line tools the app runs on your behalf',
  'What the account recommends',
  'The conversation is made of',
  'What the tools answered',
  'What the models wrote',
  'The calls themselves',
  'whole token picture',
  'whole usage picture',
  'the accounts on this computer',
  'That page gave me a code',
  'Hand it over',
  'Put ${title} back',
  'Fill the screen with ${title}',
  'Click to open this file in the Files tab',
];

describe('user-facing copy', () => {
  it('does not restore the audited narrative labels', () => {
    const source = USER_FACING_FILES.map((file) => readFileSync(file, 'utf8')).join('\n');
    for (const phrase of OVERWRITTEN_COPY) expect(source).not.toContain(phrase);
  });
});
