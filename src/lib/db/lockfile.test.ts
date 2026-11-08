import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { getDb, closeDb } from './db';
import { acquireLock } from './lockfile';

describe('lockfile', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await closeDb();
    delete process.env.CADAI_PGLITE_DIR;
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it("a second PGlite process on the same dir fails fast; a dead pid's lock is broken", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-lock-test-'));
    dirs.push(dir);

    process.env.CADAI_PGLITE_DIR = dir;
    const db = getDb();
    await db.query('SELECT 1');

    // Spawn ONE child process that imports lockfile.ts and calls acquireLock(dir)
    const lockfilePath = path.resolve(__dirname, 'lockfile.ts');
    const childScript = `
      import { acquireLock } from ${JSON.stringify(lockfilePath)};
      try {
        acquireLock(${JSON.stringify(dir)});
        process.exit(0);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    `;

    const res = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', childScript],
      { encoding: 'utf8' }
    );

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(`already open in another process (pid ${process.pid})`);

    // Close the db (releases lock)
    await closeDb();

    // Write a lock file holding a dead pid
    const deadProcess = spawnSync(process.execPath, ['-e', '']);
    const deadPid = deadProcess.pid;
    const lockFile = path.join(dir, '.cadai-lock');
    fs.writeFileSync(lockFile, String(deadPid), 'utf8');

    // acquireLock(dir) succeeds and the file now holds process.pid
    const release = acquireLock(dir);
    const content = fs.readFileSync(lockFile, 'utf8').trim();
    expect(content).toBe(String(process.pid));

    // Also: a lock holding process.pid is treated as stale
    // (Don't call release yet: the file has process.pid)
    const release2 = acquireLock(dir);
    const content2 = fs.readFileSync(lockFile, 'utf8').trim();
    expect(content2).toBe(String(process.pid));

    release2();
    release();
  });
});
