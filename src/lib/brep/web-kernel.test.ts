import { describe, expect, it, vi } from 'vitest';
import { parseParams } from '@/lib/design/parse-params';
import { setParamValue } from '@/lib/design/write-params';
import { detectLanguage } from '@/lib/brep/language';

// P2 web acceptance: the web app understands build123d code the agent produces.

const PY = `from build123d import *
from math import sin, radians

base_w = 80  # [40:1:200] Base width
base_t = 5.5  # [2:0.5:20] Base thickness
count = 4  # [1:1:8] Number of tubes
label = "x"

def base():
    return Box(base_w, base_w, base_t, align=(Align.MIN, Align.MIN, Align.MIN))

result = base()
`;

describe('detectLanguage', () => {
  it('recognises build123d and defaults to OpenSCAD', () => {
    expect(detectLanguage(PY)).toBe('build123d');
    expect(detectLanguage('w = 4; // [1:10]\ncube([w, w, w]);')).toBe('openscad');
    expect(detectLanguage('')).toBe('openscad');
  });
});

describe('parseParams on build123d code', () => {
  it('reads top-level numeric assignments with their # [min:step:max] description', () => {
    const ps = parseParams(PY);
    const w = ps.find((p) => p.name === 'base_w')!;
    expect(w).toMatchObject({ value: 80, min: 40, step: 1, max: 200, line: 4 });
    expect(w.label ?? '').toMatch(/Base width/);
    expect(ps.find((p) => p.name === 'base_t')).toMatchObject({ value: 5.5, min: 2, step: 0.5, max: 20 });
    expect(ps.map((p) => p.name)).not.toContain('label'); // strings are not sliders here
    expect(ps.map((p) => p.name)).not.toContain('sin'); // imports are not parameters
  });

  it('setParamValue rewrites only that value and keeps the comment', () => {
    const out = setParamValue(PY, 'base_t', 7);
    expect(out).toMatch(/^base_t = 7\s+# \[2:0\.5:20\] Base thickness$/m);
    expect(out.replace(/^base_t = .*$/m, '')).toBe(PY.replace(/^base_t = .*$/m, ''));
  });

  it('OpenSCAD parsing is unchanged', () => {
    const ps = parseParams('w = 4; // [1:1:10] width\ncube([w, w, w]);');
    expect(ps[0]).toMatchObject({ name: 'w', value: 4, min: 1, max: 10 });
  });
});

const runBrepMock = vi.fn();
vi.mock('@/lib/engine/brep-runner', () => ({ runBrep: (s: string) => runBrepMock(s) }));

describe('POST /api/compile', () => {
  it('sends build123d code to runBrep and returns the ASCII STL and the STEP file', async () => {
    const { POST } = await import('@/app/api/compile/route');
    const stl = 'solid m\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid m\n';
    runBrepMock.mockResolvedValue({ ok: true, parts: [], solids: 1, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, stl: Buffer.from(stl).toString('base64'), step: 'U1RFUA==', ms: 5 });
    const res = await POST(new Request('http://x/api/compile', { method: 'POST', body: JSON.stringify({ code: PY }) }) as never);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.stl ?? j.stlContent).toContain('facet normal');
    expect(j.step).toBe('U1RFUA==');
    expect(runBrepMock).toHaveBeenCalledWith(PY);
  });

  it('returns 422 with the traceback tail when the script fails', async () => {
    const { POST } = await import('@/app/api/compile/route');
    runBrepMock.mockResolvedValue({ ok: false, error: 'TypeError: bad', parts: [], solids: 0, ms: 5 });
    const res = await POST(new Request('http://x/api/compile', { method: 'POST', body: JSON.stringify({ code: PY }) }) as never);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/TypeError/);
  });
});
