import * as os from 'os';
import * as path from 'path';

/**
 * Which storage backs run state (run records, event logs, LangGraph checkpoints).
 *
 *  - `local` (default): files on this machine's disk. Two server instances that
 *    share that disk (e.g. two `next start` processes, a mounted volume) see
 *    the same runs and checkpoints, so a resume can land on either.
 *  - A shared network store (Postgres / Redis) is NOT implemented yet. On
 *    Vercel every function instance has its own /tmp, so a paused run can only
 *    be resumed on the instance that paused it until that store exists.
 */
export type RunStoreKind = 'local';

export function runStoreKind(): RunStoreKind {
  const raw = (process.env.CADAI_RUN_STORE ?? 'local').trim().toLowerCase();
  if (raw === '' || raw === 'local') return 'local';
  throw new Error(`Unsupported CADAI_RUN_STORE "${raw}". Only "local" is implemented.`);
}

/** CADAI_RUN_DIR, or `<cwd>/.cadai/runs` (`<tmp>/cadai/runs` on Vercel, where cwd is read-only). */
export function runStoreDir(): string {
  const configured = process.env.CADAI_RUN_DIR?.trim();
  if (configured) return path.resolve(/*turbopackIgnore: true*/ configured);
  return process.env.VERCEL
    ? path.join(os.tmpdir(), 'cadai', 'runs')
    : path.join(/*turbopackIgnore: true*/ process.cwd(), '.cadai', 'runs');
}
