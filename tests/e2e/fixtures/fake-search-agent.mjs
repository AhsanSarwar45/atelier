#!/usr/bin/env node
/**
 * Stands in for `claude -p` in the AI search tests, for whatever is being
 * searched. Like a real agent it only has the MCP tools the app hands it: it
 * searches with the question using the first tool, reads the first thing found
 * with the second, and answers in Claude's stream-json naming that thing and
 * one id nobody has, which the app must drop.
 */
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const [[name, { url, headers }]] = Object.entries(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers);
const question = prompt.split('The person is looking for:')[1].trim();

let asked = 0;
async function rpc(method, params) {
  const answer = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++asked, method, params }),
  });
  if (!answer.ok) throw new Error(`${method} answered ${answer.status}: ${await answer.text()}`);
  return (await answer.json()).result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
const [search, read] = (await rpc('tools/list', {})).tools;
const query = search.inputSchema.required[0];
const found = JSON.parse((await rpc('tools/call', { name: search.name, arguments: { [query]: question } })).content[0].text);
const first = found[name][0];
if (first) await rpc('tools/call', { name: read.name, arguments: { [read.inputSchema.required[0]]: first.id } });
const answer = {
  [name]: [
    ...(first ? [{ id: first.id, reason: `It is where ${question} came up`, ...(first.line ? { line: first.line } : {}) }] : []),
    { id: `a-${name.replace(/s$/, '')}-nobody-had`, reason: 'Made up' },
  ],
};
process.stdout.write(
  `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Found it.\n${JSON.stringify(answer)}` })}\n`,
);
