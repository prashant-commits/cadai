import { describe, it, expect, afterEach, vi } from 'vitest';

describe('run-control', () => {
  afterEach(() => {
    globalThis.__cadaiRunControllers?.clear();
  });

  it('run-control works across two copies of the module', async () => {
    vi.resetModules();
    const A = await import('@/lib/runs/run-control');
    vi.resetModules();
    const B = await import('@/lib/runs/run-control');
    expect(A).not.toBe(B);

    const controllerA = A.registerRun('r1');
    expect(controllerA.signal.aborted).toBe(false);

    const aborted = B.abortRun('r1');
    expect(aborted).toBe(true);
    expect(controllerA.signal.aborted).toBe(true);

    B.unregisterRun('r1', controllerA);
    expect(B.abortRun('r1')).toBe(false);
  });
});
