import { describe, it, expect } from 'vitest';
import { stlToAscii, toModuleFrames } from './measurements';
import { sanitizePythonBody, parseBuild } from '../agent/build-format';
import { extractFunctionBody } from '../agent/nodes/brep-build';

describe('stlToAscii', () => {
  it('converts a binary STL to ASCII and passes ASCII through', () => {
    const buf = Buffer.alloc(84 + 50);
    buf.writeUInt32LE(1, 80);
    [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => buf.writeFloatLE(v, 84 + i * 4));
    const ascii = stlToAscii(buf.toString('base64'));
    expect(ascii).toContain('facet normal 0 0 1');
    expect(ascii.match(/vertex/g)).toHaveLength(3);
    expect(stlToAscii(Buffer.from(ascii).toString('base64'))).toBe(ascii);
  });
});

describe('toModuleFrames', () => {
  it('maps parts to frames', () => {
    const frames = toModuleFrames({ ok: true, solids: 1, ms: 1, parts: [{ label: 'a', valid: true, volume: 1, min: [0, 0, 0], max: [1, 2, 3] }] });
    expect(frames[0]).toMatchObject({ name: 'a', valid: true, size: [1, 2, 3] });
  });
});

describe('sanitizePythonBody', () => {
  const names = ['box', 'lid'];
  it('peels a def wrapper and dedents', () => {
    expect(sanitizePythonBody('def box():\n    p = Box(1, 1, 1)\n    return p', names, [])).toBe('p = Box(1, 1, 1)\nreturn p');
  });
  it('drops assignments to parameters', () => {
    expect(sanitizePythonBody('w = 5\nreturn Box(w, w, w)', names, ['w'])).toBe('return Box(w, w, w)');
  });
  it.each(['import os\nreturn Box(1,1,1)', 'exec("x")\nreturn Box(1,1,1)', 'open("f")\nreturn Box(1,1,1)', 'return Box(1,1,1).__class__', 'return lid()', 'p = Box(1,1,1)'])('rejects %j', (body) => {
    expect(sanitizePythonBody(body, names, [])).toBeNull();
  });
  it('a rejected body is dropped so the blockout is used', () => {
    const parsed = parseBuild('@body box\nimport os\nreturn Box(1,1,1)\n@end', names, [], { language: 'python' });
    expect(parsed.dropped).toEqual(['box']);
    expect(parsed.bodies).toEqual({});
  });
});

describe('extractFunctionBody', () => {
  it('reads a function body back out of an emitted script', () => {
    const code = 'def box():\n    a = 1\n\n    return Box(a, a, a)\n\n_p_box = box()\n';
    expect(extractFunctionBody(code, 'box')).toBe('a = 1\n\nreturn Box(a, a, a)');
    expect(extractFunctionBody(code, 'nope')).toBeNull();
  });
});
