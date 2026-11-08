import { describe, expect, it } from 'vitest';
import {
  CHECK_RESERVE_MS,
  COMMIT_RESERVE_MS,
  designerWallBudgetMs,
  MAX_WALL_MS,
  MIN_DESIGNER_WALL_MS,
  MIN_RETRY_LEFT_MS,
} from './budget';

describe('designer budget', () => {
  it('defines the expected constants', () => {
    expect(MAX_WALL_MS).toBe(420_000);
    expect(COMMIT_RESERVE_MS).toBe(30_000);
    expect(CHECK_RESERVE_MS).toBe(120_000);
    expect(MIN_RETRY_LEFT_MS).toBe(60_000);
    expect(MIN_DESIGNER_WALL_MS).toBe(30_000);
  });

  it('calculates wall budgets with fallback, cap, and floor', () => {
    const now = 1_000_000;
    // Undefined deadline falls back to MAX_WALL_MS
    expect(designerWallBudgetMs(undefined, now)).toBe(MAX_WALL_MS);
    // Large deadline is capped at MAX_WALL_MS
    expect(designerWallBudgetMs(now + 900_000, now)).toBe(MAX_WALL_MS);
    // Normal budget: 400s - 30s - 120s = 250s
    expect(designerWallBudgetMs(now + 400_000, now)).toBe(250_000);
    // Short budget floored at MIN_DESIGNER_WALL_MS (30s)
    expect(designerWallBudgetMs(now + 160_000, now)).toBe(MIN_DESIGNER_WALL_MS);
    // Even if budget would be negative, floored at MIN_DESIGNER_WALL_MS
    expect(designerWallBudgetMs(now + 50_000, now)).toBe(MIN_DESIGNER_WALL_MS);
    expect(designerWallBudgetMs(now - 10_000, now)).toBe(MIN_DESIGNER_WALL_MS);
  });
});
