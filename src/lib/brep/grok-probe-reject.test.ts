import { describe, it, expect } from 'vitest';
import { checkPythonScript, MAX_SCRIPT_BYTES } from './body-check';

describe('Grok review probe-reject regressions', () => {
  const globals = "raise Exception('LEAK:' + _round.__globals__['os'].environ['CADAI_PROBE_CANARY'])\n";
  const frame = "try:\n    raise Exception('marker')\nexcept Exception as e:\n    b = e.__traceback__.tb_frame.f_back.f_builtins\n    data = b['open']('x').read()\n    raise Exception(data)\n";
  const alloc = 'x = "a" * (8 * 1024 * 1024)\nresult = Box(1, 1, 1)\n';

  it('rejects globals probe using dunder name', () => {
    const res = checkPythonScript(globals);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining('dunder') });
  });

  it('rejects frame walk probe using dunder name', () => {
    const res = checkPythonScript(frame);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: expect.stringContaining('dunder') });
  });

  it('accepts clean 8 MiB allocation probe under the size cap', () => {
    const res = checkPythonScript(alloc);
    expect(res.ok).toBe(true);
  });

  it('rejects scripts exceeding the 256 KiB cap', () => {
    const oversized = 'x = 1\n'.repeat((MAX_SCRIPT_BYTES / 6) + 100);
    const res = checkPythonScript(oversized);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ reason: 'script too large' });
  });
});
