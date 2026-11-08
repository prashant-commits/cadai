export const MAX_WALL_MS = 420_000;
export const COMMIT_RESERVE_MS = 30_000;
export const CHECK_RESERVE_MS = 120_000;
export const MIN_RETRY_LEFT_MS = 60_000;
export const MIN_DESIGNER_WALL_MS = 30_000;

/** min(MAX_WALL_MS, remaining − 30 s − 120 s), floored at MIN_DESIGNER_WALL_MS; MAX_WALL_MS when deadlineAt is undefined. */
export function designerWallBudgetMs(deadlineAt: number | undefined, now = Date.now()): number {
  if (deadlineAt === undefined) return MAX_WALL_MS;
  const remaining = deadlineAt - now;
  const budget = remaining - COMMIT_RESERVE_MS - CHECK_RESERVE_MS;
  return Math.max(MIN_DESIGNER_WALL_MS, Math.min(MAX_WALL_MS, budget));
}
