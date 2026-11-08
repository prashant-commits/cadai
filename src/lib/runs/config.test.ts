import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assertRunDirWritable, runStoreDir, RUN_DIR_NOT_WRITABLE } from './config';
import { getDb, closeDb } from '@/lib/db/db';

describe('config', () => {
  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
  });

  it('an unwritable CADAI_RUN_DIR fails startup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-config-test-'));
    const regularFile = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(regularFile, 'hello');
    const unwritablePath = path.join(regularFile, 'sub');

    vi.stubEnv('CADAI_RUN_DIR', unwritablePath);

    expect(() => assertRunDirWritable()).toThrow(RUN_DIR_NOT_WRITABLE);

    vi.stubEnv('CADAI_DB', 'pglite');
    vi.stubEnv('CADAI_PGLITE_DIR', '');
    vi.stubEnv('VITEST', '');

    expect(() => getDb()).toThrow(RUN_DIR_NOT_WRITABLE);

    vi.stubEnv('CADAI_RUN_DIR', '');
    vi.stubEnv('VERCEL', '1');
    const dir = runStoreDir();
    expect(dir.startsWith(os.tmpdir())).toBe(false);
    expect(dir).toBe(path.join(process.cwd(), '.cadai', 'runs'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
