import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  assertRunDirWritable,
  runStoreDir,
  RUN_DIR_NOT_WRITABLE,
  maxRunning,
  dailyCostUsd,
} from './config';
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

  it('maxRunning readers obey defaults and bounds', () => {
    vi.stubEnv('CADAI_MAX_RUNNING', '');
    expect(maxRunning()).toBe(4);

    delete process.env.CADAI_MAX_RUNNING;
    expect(maxRunning()).toBe(4);

    vi.stubEnv('CADAI_MAX_RUNNING', '0');
    expect(maxRunning()).toBe(0);

    vi.stubEnv('CADAI_MAX_RUNNING', '8');
    expect(maxRunning()).toBe(8);

    vi.stubEnv('CADAI_MAX_RUNNING', '-1');
    expect(maxRunning()).toBe(4);

    vi.stubEnv('CADAI_MAX_RUNNING', 'not-a-number');
    expect(maxRunning()).toBe(4);
  });

  it('dailyCostUsd readers obey defaults and bounds', () => {
    vi.stubEnv('CADAI_DAILY_COST_USD', '');
    expect(dailyCostUsd()).toBeNull();

    delete process.env.CADAI_DAILY_COST_USD;
    expect(dailyCostUsd()).toBeNull();

    vi.stubEnv('CADAI_DAILY_COST_USD', '0');
    expect(dailyCostUsd()).toBeNull();

    vi.stubEnv('CADAI_DAILY_COST_USD', '-5');
    expect(dailyCostUsd()).toBeNull();

    vi.stubEnv('CADAI_DAILY_COST_USD', '12.5');
    expect(dailyCostUsd()).toBe(12.5);
  });
});
