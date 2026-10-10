#!/usr/bin/env node
/**
 * Stands in for Claude when a commit message is generated in an end-to-end
 * run: started with CLAUDE_PATH pointing at it. It reads the prompt from
 * stdin as the real one does, writes down how it was called when
 * FAKE_COMMIT_AGENT_LOG names a file, and answers in the real one's JSON
 * envelope.
 */
import { appendFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const log = process.env.FAKE_COMMIT_AGENT_LOG;
  if (log) {
    appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), prompt })}\n`);
  }
  process.stdout.write(
    JSON.stringify({ type: 'result', is_error: false, result: 'Add the release notes\n' }),
  );
});
