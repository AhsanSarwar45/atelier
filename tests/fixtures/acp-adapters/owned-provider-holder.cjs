const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const sessionId = process.argv[2];
const config = process.env.CLAUDE_CONFIG_DIR;
if (!sessionId || !config || !process.env.ATELIER_PROVIDER_OWNER) process.exit(2);

const sessions = join(config, 'sessions');
mkdirSync(sessions, { recursive: true });
const marker = join(sessions, `${process.pid}.json`);
const stat = readFileSync('/proc/self/stat', 'utf8');
const procStart = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
writeFileSync(marker, JSON.stringify({
  sessionId,
  pid: process.pid,
  cwd: process.cwd(),
  startedAt: Date.now(),
  procStart,
  entrypoint: 'sdk-ts',
  kind: 'interactive',
  status: 'idle',
}));

const release = () => {
  rmSync(marker, { force: true });
  process.exit(0);
};
process.on('SIGTERM', release);
process.on('SIGINT', release);
setInterval(() => {}, 60_000);
