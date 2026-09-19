import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import { describe, expect, it } from 'vitest';

function sourceFiles(root: string, extensions = /\.(?:ts|tsx)$/): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path, extensions);
    return extensions.test(entry.name) && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

const USER_FACING_FILES = [
  ...sourceFiles('src'),
  ...sourceFiles('scripts', /\.(?:js|mjs|py|sh)$/),
  ...sourceFiles('server/src', /\.rs$/),
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
  'Reach it from away',
  'That did not happen',
  'Not there yet',
  'Every account',
  'What reaches the bell and this device',
  'Give this chat a name that is easy to find in the sidebar',
  'This project keeps no policy file yet',
  'Writing it to the board. This can take a moment while agents are working.',
  'The helper behind this list is out of date, so no chat here can say what it is doing.',
  'the board, the screens and the chat',
  'Set this computer up to be reached from away',
  'Show how far along that setup is',
  'turning reaching-from-away on and off',
  'There is nothing at',
  'is not a file, so there is no shell',
  'This computer will not say where your home folder is',
  'is not something it does',
  'this computer names no folder',
];

describe('user-facing copy', () => {
  it('does not restore the audited narrative labels', () => {
    const strings: string[] = [];
    for (const file of USER_FACING_FILES) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node)) strings.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    const copy = strings.join('\n');
    for (const phrase of OVERWRITTEN_COPY) expect(copy).not.toContain(phrase);
  });
});
