#!/usr/bin/env node
/**
 * Stands in for `claude -p` in the AI search test. Like a real agent it only
 * has the MCP tools the app hands it: it searches with the question, reads the
 * first chat found, and answers in Claude's stream-json with that chat and one
 * id nobody has, which the app must drop.
 */
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1];
const { url, headers } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.chats;
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
const found = JSON.parse((await rpc('tools/call', { name: 'search_chats', arguments: { query: question } })).content[0].text);
const chat = found.chats[0];
if (chat) await rpc('tools/call', { name: 'read_chat', arguments: { id: chat.id } });
const answer = {
  chats: [
    ...(chat ? [{ id: chat.id, reason: `It is where ${question} came up` }] : []),
    { id: 'a-chat-nobody-had', reason: 'Made up' },
  ],
};
process.stdout.write(
  `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `Found it.\n${JSON.stringify(answer)}` })}\n`,
);
