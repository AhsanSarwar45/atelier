/** A replacement helper waits out the old helper's last SQLite write. */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../workbench/src/store.ts';

const rounds = 20;
const root = mkdtempSync(join(tmpdir(), 'atelier-db-reload-'));
const path = join(root, 'workbench.db');
new Store(path).close();

try {
  for (let round = 1; round <= rounds; round++) {
    const holder = spawn(process.execPath, [
      '--no-warnings', '--experimental-strip-types', '--input-type=module', '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(${JSON.stringify(path)});
       db.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE');
       process.send('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); }, 75);`,
    ], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((resolve, reject) => {
      holder.once('exit', resolve);
      holder.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      holder.once('message', resolve);
      holder.once('error', reject);
      holder.once('exit', (code) => reject(new Error(`lock holder exited before locking: ${code}`)));
    });

    const replacement = new Store(path);
    replacement.markAllDormant();
    replacement.close();
    const code = await exited;
    if (code !== 0) throw new Error(`lock holder failed in round ${round}: ${code}`);
  }
  console.log(`${rounds}/${rounds} reload rounds; 0 SQLITE_BUSY or database locked failures`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
