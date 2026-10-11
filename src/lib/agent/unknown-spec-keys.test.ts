import { describe, it, expect } from 'vitest';
import { unknownSpecKeys } from './assembly-spec';

describe('unknownSpecKeys', () => {
  it('returns nothing for a spec made only of known keys', () => {
    expect(
      unknownSpecKeys({
        assemblyName: 'a',
        sheet: '',
        components: [{ name: 'n', description: 'd', shape: { kind: 'box' } }],
        guides: [{ label: 'g', kind: 'line' }],
      })
    ).toEqual([]);
  });

  it('names unknown top-level keys, with the skeleton hint', () => {
    const out = unknownSpecKeys({ skeleton: {}, extra: 1, assemblyName: 'a' });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('skeleton');
    expect(out[0]).toContain('put components and the other fields at the top level');
    expect(out[1]).toContain('extra');
    expect(out[1]).not.toContain(' - ');
  });

  it('names unknown component and shape keys by path, hinting kind for type', () => {
    const out = unknownSpecKeys({
      components: [{ name: 'n', color: 'red', type: 'box', shape: { type: 'box' } }, { name: 'm', shape: { kind: 'box', radius: 3 } }],
    });
    expect(out.join('\n')).toContain('components.0.color');
    expect(out.find((m) => m.startsWith('components.0.type '))).toContain('shape is an object with a `kind`');
    expect(out.find((m) => m.includes('components.0.shape.type'))).toContain('the key is `kind`');
    expect(out.join('\n')).toContain('components.1.shape.radius');
  });

  it('names unknown guide keys and hints kind for type', () => {
    const out = unknownSpecKeys({ guides: [{ label: 'g', type: 'line' }] });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('guides.0.type');
    expect(out[0]).toContain('the key is `kind`');
  });

  it('tolerates non-object input and string shapes', () => {
    expect(unknownSpecKeys(null)).toEqual([]);
    expect(unknownSpecKeys('x')).toEqual([]);
    expect(unknownSpecKeys({ components: [null, { shape: 'box' }] })).toEqual([]);
  });
});
