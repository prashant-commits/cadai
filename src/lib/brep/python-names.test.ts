import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BUILD123D_NAMES, MATH_NAMES, PYTHON_BUILTINS, PYTHON_KEYWORDS } from './python-names';
import { geoPython } from './test-run';

const run = existsSync(geoPython()) ? it : it.skip;

describe('python-names', () => {
  // If this fails after a build123d upgrade, regenerate src/lib/brep/python-names.ts from these four lists.
  run('covers everything the interpreter binds that a spec name could shadow', () => {
    const out = execFileSync(
      geoPython(),
      [
        '-I',
        '-c',
        [
          'import builtins, keyword, math, json',
          'ns = {}',
          'exec("from build123d import *", ns)',
          'ns.pop("__builtins__", None)',
          'print(json.dumps({"kw": keyword.kwlist + keyword.softkwlist, "b": [n for n in dir(builtins) if not n.startswith("_")],',
          '"m": [n for n in dir(math) if not n.startswith("_")], "x": list(ns)}))',
        ].join('\n'),
      ],
      { encoding: 'utf-8' },
    );
    const got = JSON.parse(out) as { kw: string[]; b: string[]; m: string[]; x: string[] };
    expect(got.kw.filter((n) => !PYTHON_KEYWORDS.has(n))).toEqual([]);
    expect(got.b.filter((n) => !PYTHON_BUILTINS.has(n))).toEqual([]);
    expect(got.m.filter((n) => !MATH_NAMES.has(n))).toEqual([]);
    expect(got.x.filter((n) => !BUILD123D_NAMES.has(n))).toEqual([]);
  });
  it('names the ones the emitter calls', () => {
    for (const n of ['extrude', 'offset', 'radians', 'min', 'max', 'abs', 'sin', 'class', 'Kind']) {
      expect(PYTHON_KEYWORDS.has(n) || PYTHON_BUILTINS.has(n) || MATH_NAMES.has(n) || BUILD123D_NAMES.has(n), n).toBe(true);
    }
  });
});
