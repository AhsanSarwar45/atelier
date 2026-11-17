#!/usr/bin/env node
/**
 * Stands in for Claude as the grid coverage reviewer in an end-to-end run:
 * started with CLAUDE_PATH pointing at it. It reads the prompt from stdin,
 * appends it to FAKE_REVIEW_AGENT_LOG when that names a file, and answers in
 * the real one's JSON envelope. It finds one gap, "the sun low on the
 * horizon", until the cases cover a low sun or a dismissal answers it.
 */
import { appendFileSync } from 'node:fs';

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const log = process.env.FAKE_REVIEW_AGENT_LOG;
  if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), prompt })}\n`);
  const covered = prompt.includes('low-sun') || prompt.includes('covered by the gpu column');
  const gaps = covered ? [] : [{ scenario: 'the sun low on the horizon' }];
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ gaps }) }));
});
