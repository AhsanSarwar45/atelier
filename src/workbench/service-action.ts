/** Provider-neutral interpretation of an external-service tool call. */

export type ServiceEffect = 'read' | 'search' | 'create' | 'update' | 'delete' | 'communicate' | 'authenticate' | 'execute';
export type ServiceRisk = 'read-only' | 'mutating' | 'destructive' | 'unknown';

export interface ServiceAction {
  server: string;
  method: string;
  effect: ServiceEffect;
  risk: ServiceRisk;
  target?: string;
  summary: string;
  confidence: 'schema' | 'parsed' | 'heuristic' | 'unknown';
}

const READ = new Set(['get', 'read', 'fetch', 'list', 'show', 'lookup', 'open', 'inspect', 'view', 'describe', 'download', 'status', 'check', 'validate', 'count', 'history', 'version']);
const SEARCH = new Set(['search', 'find', 'query']);
const CREATE = new Set(['create', 'add', 'publish', 'upload']);
const UPDATE = new Set(['update', 'edit', 'set', 'move', 'copy', 'write', 'change', 'apply', 'label']);
const COMMUNICATE = new Set(['send', 'post', 'comment', 'reply', 'notify']);
const DELETE = new Set(['delete', 'remove', 'revoke', 'destroy', 'purge']);
const AUTH = new Set(['authenticate', 'login', 'connect', 'authorize']);
const EXECUTE = new Set(['execute', 'run', 'invoke', 'trigger']);

const words = (value: string): string[] => value.split(/[_\-\s]+/).filter(Boolean);
const displayServer = (value: string): string => value
  .replace(/^(?:claude_ai_|plugin_)/i, '')
  .split(/[_-]+/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

/** Claude `mcp__s__m` and Codex `s/m` become the same identity. */
export function serviceIdentity(name: string): { server: string; method: string } | null {
  if (name.startsWith('mcp__')) {
    const [, server = '', ...method] = name.split('__');
    return server && method.length ? { server, method: method.join('__') } : null;
  }
  const slash = name.indexOf('/');
  return slash > 0 && slash < name.length - 1
    ? { server: name.slice(0, slash), method: name.slice(slash + 1) }
    : null;
}

function targetIn(input: Record<string, unknown>): string | undefined {
  for (const key of ['id', 'issueId', 'issue_id', 'pageId', 'page_id', 'query', 'name', 'path', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 60);
  }
  return undefined;
}

function objectIn(method: string, verb: string): string {
  const rest = words(method).filter((word) => word.toLowerCase() !== verb);
  if (!rest.length) return 'data';
  return rest.join(' ').replace(/\bids\b/i, 'items');
}

/** Classify service capability from normalized identity, annotations, and input. */
export function normalizeServiceAction(
  name: string,
  input: Record<string, unknown> = {},
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
): ServiceAction | null {
  const identity = serviceIdentity(name);
  if (!identity) return null;
  const server = displayServer(identity.server) || 'Service';
  const methodWords = words(identity.method);
  // Some servers repeat their name in every method (codegraph_explore).
  if (methodWords[0]?.toLowerCase() === words(identity.server)[0]?.toLowerCase()) methodWords.shift();
  const lower = methodWords.map((word) => word.toLowerCase());
  // Tool servers commonly namespace the operation (`issues_get`) or qualify
  // it (`batch_update_issues`). Prefer the most consequential capability the
  // method actually names instead of assuming its first word is the verb.
  const pick = (set: Set<string>): string => lower.find((word) => set.has(word)) ?? '';
  const verb = pick(DELETE) || pick(CREATE) || pick(UPDATE) || pick(COMMUNICATE) ||
    pick(AUTH) || pick(EXECUTE) || pick(SEARCH) || pick(READ);
  const target = targetIn(input);
  const object = objectIn(methodWords.join('_'), verb);

  let effect: ServiceEffect;
  let risk: ServiceRisk;
  let phrase: string;
  if (DELETE.has(verb) || annotations.destructiveHint) {
    effect = 'delete'; risk = 'destructive'; phrase = 'Deleted';
  } else if (annotations.readOnlyHint) {
    effect = 'read'; risk = 'read-only'; phrase = verb === 'list' ? 'Listed' : 'Read';
  } else if (READ.has(verb)) {
    effect = 'read'; risk = 'read-only'; phrase = verb === 'list' ? 'Listed' : 'Read';
  } else if (SEARCH.has(verb)) {
    effect = 'search'; risk = 'read-only'; phrase = 'Searched';
  } else if (CREATE.has(verb)) {
    effect = 'create'; risk = 'mutating'; phrase = verb === 'publish' ? 'Published' : verb === 'upload' ? 'Uploaded' : 'Created';
  } else if (UPDATE.has(verb)) {
    effect = 'update'; risk = 'mutating'; phrase = 'Updated';
  } else if (COMMUNICATE.has(verb)) {
    effect = 'communicate'; risk = 'mutating'; phrase = 'Sent';
  } else if (AUTH.has(verb)) {
    effect = 'authenticate'; risk = 'mutating'; phrase = 'Authenticated with';
  } else if (EXECUTE.has(verb)) {
    effect = 'execute'; risk = 'unknown'; phrase = 'Ran';
  } else {
    effect = 'execute'; risk = 'unknown';
    return {
      server, method: identity.method, effect, risk, target,
      summary: `Asked ${server} to ${methodWords.join(' ') || 'do something'}${target ? ` for ${target}` : ''}`,
      confidence: 'unknown',
    };
  }

  return {
    server, method: identity.method, effect, risk, target,
    summary: `${phrase} ${server}${object === 'data' ? '' : ` ${object}`}${target ? ` ${target}` : ''}`,
    confidence: annotations.readOnlyHint || annotations.destructiveHint ? 'schema' : 'heuristic',
  };
}
