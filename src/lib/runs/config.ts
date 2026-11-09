import * as fs from 'fs';
import * as path from 'path';

/**
 * Which storage backs run state (run records, event logs).
 *
 *  - `local` (default): files on this machine's disk. Two server instances that
 *    share that disk (e.g. two `next start` processes, a mounted volume) see
 *    the same runs.
 *  - A shared network store (Postgres / Redis) is NOT implemented yet.
 */
export type RunStoreKind = 'local';

export function runStoreKind(): RunStoreKind {
  const raw = (process.env.CADAI_RUN_STORE ?? 'local').trim().toLowerCase();
  if (raw === '' || raw === 'local') return 'local';
  throw new Error(`Unsupported CADAI_RUN_STORE "${raw}". Only "local" is implemented.`);
}

export const RUN_DIR_NOT_WRITABLE =
  'The run directory is not writable. Set CADAI_RUN_DIR to a writable directory.';

/** CADAI_RUN_DIR, or `<cwd>/.cadai/runs`. */
export function runStoreDir(): string {
  const configured = process.env.CADAI_RUN_DIR?.trim();
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  return path.join(/*turbopackIgnore: true*/ process.cwd(), '.cadai', 'runs');
}

export function assertRunDirWritable(dir = runStoreDir()): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(
      dir,
      `.probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.writeFileSync(probe, 'probe', 'utf8');
    fs.unlinkSync(probe);
    return dir;
  } catch {
    throw new Error(`${RUN_DIR_NOT_WRITABLE} (${dir})`);
  }
}

export type ArtifactStoreKind = 'local';

export function artifactStoreKind(): ArtifactStoreKind {
  const raw = (process.env.CADAI_ARTIFACT_STORE ?? 'local').trim().toLowerCase();
  if (raw === '' || raw === 'local') return 'local';
  throw new Error(`Unsupported CADAI_ARTIFACT_STORE "${raw}". Only "local" is implemented.`);
}

/** `<run store dir>/artifacts`. */
export function artifactStoreDir(): string {
  return path.join(/*turbopackIgnore: true*/ runStoreDir(), 'artifacts');
}

/** CADAI_INLINE_PAYLOADS=1 keeps the legacy inline stl / step / sheetSvg fields on events. Default off. */
export function inlinePayloads(): boolean {
  return process.env.CADAI_INLINE_PAYLOADS?.trim() === '1';
}

/** Maximum concurrent building runs across all processes (default 4; 0 = no cap). */
export function maxRunning(): number {
  const raw = process.env.CADAI_MAX_RUNNING;
  if (raw === undefined || raw === null || raw.trim() === '') return 4;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return 4;
  return n;
}

/** Daily (UTC) build budget in USD. Unset / non-positive = off. */
export function dailyCostUsd(): number | null {
  const raw = process.env.CADAI_DAILY_COST_USD;
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const n = Number(raw.trim());
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}
