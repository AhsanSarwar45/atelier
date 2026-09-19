#!/usr/bin/env node
/**
 * Builds the MCP catalogue the app falls back to, and the categories it browses
 * by (bw-6ecp.6).
 *
 * Two sources, joined on the repository each server is published from:
 *
 *  - Docker's MCP catalogue (`docker/mcp-registry`) is the curated half. Each
 *    server there has a category, an icon and a title somebody wrote, which is
 *    what makes a list browsable rather than a wall of package names.
 *  - The official MCP registry is the runnable half: it says which npm, PyPI or
 *    remote endpoint actually starts the server, which is what an entry must
 *    have for Add to mean anything.
 *
 * The app searches the official registry live; this file is what it shows when
 * there is no network, and where every category and icon comes from either way.
 *
 * Run: node scripts/build-mcp-catalogue.mjs [--out server/assets/mcp-catalogue.json]
 */
import { writeFileSync } from 'node:fs';

const REGISTRY = 'https://registry.modelcontextprotocol.io/v0/servers';
const DOCKER_TREE = 'https://api.github.com/repos/docker/mcp-registry/git/trees/main?recursive=1';
const DOCKER_RAW = 'https://raw.githubusercontent.com/docker/mcp-registry/main';
const CATALOG = 'https://desktop.docker.com/mcp/catalog/v2/catalog.yaml';

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'server/assets/mcp-catalogue.json';

const wait = (ms) => new Promise((go) => setTimeout(go, ms));

/** Retried, because a few hundred searches in a row is enough to be throttled. */
async function json(url, tries = 4) {
  for (let go = 0; ; go += 1) {
    const r = await fetch(url, { headers: { 'user-agent': 'beads-web-catalogue-builder' } }).catch(() => null);
    if (r?.ok) return r.json();
    if (go + 1 >= tries) throw new Error(`${r?.status ?? 'no answer'} ${url}`);
    await wait(500 * 2 ** go);
  }
}

async function text(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'beads-web-catalogue-builder' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

/** A repository URL as a key both sources agree on: host and path, nothing else. */
function repoKey(url) {
  if (!url) return null;
  const at = String(url)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .toLowerCase();
  const parts = at.split('/').filter(Boolean);
  // github.com/owner/repo, ignoring /tree/<commit> and the rest.
  if (parts.length < 3) return null;
  return `${parts[0]}/${parts[1]}/${parts[2]}`;
}

/** Enough of a YAML reader for the handful of scalars each server.yaml holds. */
function readServerYaml(body) {
  const lines = body.split('\n');
  const at = (indent, key) => {
    const want = `${' '.repeat(indent)}${key}:`;
    const line = lines.find((l) => l.startsWith(want));
    if (!line) return null;
    const value = line.slice(want.length).trim();
    return value ? value.replace(/^["']|["']$/g, '') : null;
  };
  /** The lines under `parent:` at this indent, as blocks starting at each `- `. */
  const blocks = (path, indent) => {
    const head = lines.findIndex((l) => l.startsWith(path));
    if (head < 0) return [];
    const rows = [];
    let one = null;
    for (const line of lines.slice(head + 1)) {
      if (line.trim() && !line.startsWith(' '.repeat(indent))) break;
      const item = line.match(new RegExp(`^ {${indent}}- (\\w+): (.*)$`));
      const more = line.match(new RegExp(`^ {${indent + 2}}(\\w+): (.*)$`));
      if (item) {
        one = { [item[1]]: item[2].replace(/^["']|["']$/g, '') };
        rows.push(one);
      } else if (more && one) {
        one[more[1]] = more[2].replace(/^["']|["']$/g, '');
      }
    }
    return rows;
  };
  /** `run.env`: fixed values the server is started with, name to value. */
  const runEnv = () => {
    const head = lines.findIndex((l) => l === '  env:');
    if (head < 0) return {};
    const fixed = {};
    for (const line of lines.slice(head + 1)) {
      if (line.trim() && !line.startsWith('    ')) break;
      const pair = line.match(/^ {4}(\w+): (.*)$/);
      if (pair) fixed[pair[1]] = pair[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    }
    return fixed;
  };
  return {
    name: at(0, 'name'),
    image: at(0, 'image'),
    category: at(2, 'category'),
    title: at(2, 'title'),
    description: at(2, 'description'),
    icon: at(2, 'icon'),
    project: at(2, 'project'),
    secrets: blocks('  secrets:', 4),
    runEnv: runEnv(),
  };
}

/**
 * The official registry's entry for one repository, if it has one.
 *
 * Asked one repository at a time rather than by walking the whole registry:
 * there are over six thousand published servers and the walk is alphabetical,
 * so the entry wanted is as likely to be eighty pages in as on the first.
 */
async function registryFor(project) {
  const key = repoKey(project);
  if (!key) return null;
  const term = key.split('/').pop();
  const body = await json(`${REGISTRY}?version=latest&limit=50&search=${encodeURIComponent(term)}`).catch((e) => {
    process.stderr.write(`\n  no answer for ${term}: ${e.message}\n`);
    return null;
  });
  for (const row of body?.servers ?? []) {
    if (repoKey(row.server?.repository?.url) === key) return row.server;
  }
  return null;
}

/** Docker's published catalogue, which has the description and icon its repo files often leave out. */
async function dockerCatalogue() {
  const body = await text(CATALOG);
  const entries = new Map();
  let id = null;
  for (const line of body.split('\n')) {
    const head = line.match(/^ {2}([\w.-]+):$/);
    if (head) {
      id = head[1];
      entries.set(id, {});
      continue;
    }
    const pair = line.match(/^ {4}(description|title|icon|image): (.*)$/);
    if (pair && id) entries.get(id)[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
  }
  return entries;
}

/**
 * The command a server is started with, in the provider's own shape.
 *
 * The order is the order a reader would want it tried: a package they already
 * have a runner for, then a remote endpoint, then the container image Docker
 * publishes it as.
 */
export function launch(server, image, pass = []) {
  for (const pkg of server?.packages ?? []) {
    const args = (pkg.runtimeArguments ?? []).map((a) => a.value).filter(Boolean);
    const named = (pkg.packageArguments ?? []).filter((a) => a.isRequired === false).length === 0;
    if (!named) continue;
    if (pkg.registryType === 'npm') {
      return { transport: 'stdio', command: 'npx', args: ['-y', ...args, pkg.identifier] };
    }
    if (pkg.registryType === 'pypi') {
      return { transport: 'stdio', command: 'uvx', args: [...args, pkg.identifier] };
    }
  }
  const remote = (server?.remotes ?? [])[0];
  if (remote?.url) return { transport: 'http', url: remote.url };
  if (image) {
    // `-e NAME` with no value forwards the variable the client already set on
    // the docker process, which is how the reader's answers reach the server.
    const forward = pass.flatMap((name) => ['-e', name]);
    return { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', ...forward, image.split('@')[0]], container: true };
  }
  return null;
}

/**
 * Docker's categories as the app groups them.
 *
 * The repository's own are a reader's list that grew: `ai` and `ai-ml`,
 * `developer-tools`, `devtools`, `development` and `code`, all naming the same
 * shelf. Anything not named here is kept as it is.
 */
const SAME = {
  'ai-ml': 'ai',
  'developer-tools': 'development',
  devtools: 'development',
  code: 'development',
  'data-analytics': 'data',
  'data-visualization': 'data',
  database: 'data',
  messaging: 'communication',
  maps: 'geospatial',
  integration: 'productivity',
  business: 'productivity',
};

/** The variables a reader has to fill in before the server will start. */
function needs(server) {
  const pkg = (server?.packages ?? [])[0];
  return (pkg?.environmentVariables ?? [])
    .filter((v) => v.isRequired)
    .map((v) => ({ name: v.name, description: v.description ?? '' }));
}

async function main() {
  process.stderr.write("Reading Docker's published catalogue…\n");
  const published = await dockerCatalogue();
  process.stderr.write(`  ${published.size} published servers\n`);

  process.stderr.write("Reading Docker's catalogue repository…\n");
  const tree = await json(DOCKER_TREE);
  const files = tree.tree.filter((f) => /^servers\/[^/]+\/server\.yaml$/.test(f.path)).map((f) => f.path);
  process.stderr.write(`  ${files.length} curated servers\n`);

  const entries = [];
  const batch = 12;
  for (let i = 0; i < files.length; i += batch) {
    const bodies = await Promise.all(files.slice(i, i + batch).map((p) => text(`${DOCKER_RAW}/${p}`).catch(() => null)));
    const parsed = bodies.filter(Boolean).map(readServerYaml).filter((it) => it.name && it.category);
    const found = await Promise.all(parsed.map((it) => registryFor(it.project)));
    for (const [n, it] of parsed.entries()) {
      const also = published.get(it.name) ?? {};
      it.title = it.title ?? also.title;
      it.description = it.description || also.description || '';
      it.icon = it.icon ?? also.icon;
      it.image = it.image ?? also.image;
      const server = found[n];
      // What the reader has to supply: the registry's required variables when
      // it knows the server, and Docker's declared secrets when it does not.
      const wanted = server
        ? needs(server)
        : (it.secrets ?? []).map((s) => ({ name: s.env ?? s.name, description: s.example ? `e.g. ${s.example}` : '' }));
      const fixed = it.runEnv ?? {};
      const how = launch(server, it.image, [...wanted.map((w) => w.name), ...Object.keys(fixed)]);
      if (!how) continue;
      entries.push({
        id: it.name,
        title: it.title ?? it.name,
        description: it.description ?? '',
        category: SAME[it.category] ?? it.category,
        icon: it.icon ?? null,
        repository: it.project ?? null,
        registryName: server?.name ?? null,
        needs: wanted,
        ...how,
        ...(Object.keys(fixed).length ? { env: fixed } : {}),
      });
    }
    process.stderr.write(`  ${Math.min(i + batch, files.length)}/${files.length}\r`);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(out, `${JSON.stringify({ builtAt: new Date().toISOString().slice(0, 10), entries }, null, 2)}\n`);
  process.stderr.write(`\nWrote ${entries.length} entries to ${out}\n`);
}

await main();
