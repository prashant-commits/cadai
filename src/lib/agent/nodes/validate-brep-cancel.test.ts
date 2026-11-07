import { describe, it, expect, vi } from 'vitest';

const runBrep = vi.hoisted(() => vi.fn());
vi.mock('../../engine/brep-runner', () => ({ runBrep }));

import { validateBrep } from './validate-brep';

const state = { currentCode: 'result = 1', assemblySpec: null, attemptCount: 1, compileFailures: 0 } as never;

describe('validateBrep and the run stop signal', () => {
  it('passes the graph config signal to the geometry runner', async () => {
    const ac = new AbortController();
    runBrep.mockResolvedValue({ ok: false, error: 'boom', parts: [], solids: 0, ms: 1 });
    await validateBrep(state, { signal: ac.signal });
    expect(runBrep.mock.calls[0][1]).toEqual({ signal: ac.signal });
  });

  it('a run stopped during the geometry run ends the node with AbortError, not a validation report', async () => {
    const ac = new AbortController();
    runBrep.mockImplementation(async () => {
      ac.abort();
      return { ok: false, error: 'cancelled', parts: [], solids: 0, ms: 1 };
    });
    await expect(validateBrep(state, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
