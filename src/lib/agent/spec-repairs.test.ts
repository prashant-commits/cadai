import { describe, it, expect } from 'vitest';
import { normalizeClaudeSentinels, parseStringifiedFields } from './llm-schemas';
import { AssemblySpecSchema } from './assembly-spec';
import { nullsToUndefined } from './strict-schema';

// Format slips Haiku 5.5 made with thinking disabled (offline eval, 72 variant
// specs). Each is repaired in normalizeClaudeSentinels, before zod validation.

type Spec = Record<string, unknown>;

const PARAMS = [
  { name: 'plate_w', value: 60, min: 40, max: 100, unit: 'mm', description: 'Plate width.' },
  { name: 'wall', value: 5, min: 3, max: 10, unit: 'mm', description: 'Plate thickness.' },
  { name: 'plate_h', value: 80, min: 50, max: 120, unit: 'mm', description: 'Plate height.' },
  { name: 'hole_left_x', value: 10, min: 5, max: 20, unit: 'mm', description: 'Hole inset.' },
  { name: 'hole_top_z', value: 70, min: 40, max: 110, unit: 'mm', description: 'Hole height.' },
];

function plate(holes: unknown[], localExtents: unknown = ['plate_w', 'wall', 'plate_h']): Spec {
  return {
    name: 'back_plate',
    description: 'Wall plate.',
    localExtents,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    positionNote: '',
    shape: { kind: 'box' },
    holes,
  };
}

function spec(over: Spec = {}): Spec {
  return { assemblyName: 'wall_hook', parameters: PARAMS, components: [plate([])], guides: [], ...over };
}

const validate = (raw: unknown) => AssemblySpecSchema.safeParse(nullsToUndefined(normalizeClaudeSentinels(raw)));
const holesOf = (out: unknown, i = 0) => ((out as { components: Spec[] }).components[i].holes as Spec[]);

describe('two-item hole at: the axis coordinate is inserted as the + face', () => {
  it('y hole on a wall plate: at gets localExtents[1] at index 1', () => {
    const raw = spec({ components: [plate([{ d: 4, axis: 'y', at: ['hole_left_x', 'hole_top_z'], note: '' }])] });
    expect(holesOf(normalizeClaudeSentinels(raw))).toEqual([{ d: 4, axis: 'y', at: ['hole_left_x', 'wall', 'hole_top_z'] }]);
    expect(validate(raw).success).toBe(true);
    // Unrepaired, the same spec fails on the hole.
    const before = AssemblySpecSchema.safeParse(nullsToUndefined(raw));
    expect(before.success).toBe(false);
    expect(before.error?.issues[0].path.join('.')).toBe('components.0.holes.0.at');
  });

  it('z hole on a flat plate: at gets localExtents[2] at index 2', () => {
    const raw = spec({
      components: [plate([{ d: 'screw_d', axis: 'z', at: ['hole_x1', 'hole_y'] }], ['plate_l', 'plate_w', 'plate_t'])],
    });
    expect(holesOf(normalizeClaudeSentinels(raw))).toEqual([{ d: 'screw_d', axis: 'z', at: ['hole_x1', 'hole_y', 'plate_t'] }]);
  });

  it('x hole with numeric extents: at gets localExtents[0] at index 0', () => {
    const raw = spec({ components: [plate([{ d: 3.4, axis: 'x', at: [12, 7.5] }], [6, 40, 20])] });
    expect(holesOf(normalizeClaudeSentinels(raw))).toEqual([{ d: 3.4, axis: 'x', at: [6, 12, 7.5] }]);
  });

  it('a z hole in a 5 mm plate has at[2] = 5, matching the existing convention', () => {
    const raw = spec({ components: [plate([{ d: 3.4, axis: 'z', at: [10, 10] }], [40, 20, 5])] });
    expect(holesOf(normalizeClaudeSentinels(raw))[0].at).toEqual([10, 10, 5]);
  });

  it('leaves the hole to fail validation when there is no usable axis or extent', () => {
    const cases: Array<[Spec, unknown]> = [
      [{ d: 4, axis: 'w', at: [1, 2] }, [10, 10, 5]],
      [{ d: 4, at: [1, 2] }, [10, 10, 5]],
      [{ d: 4, axis: 'z', at: [1, 2] }, null],
      [{ d: 4, axis: 'z', at: [1, 2] }, [10, 10]],
      [{ d: 4, axis: 'z', at: [1, 2] }, [10, 10, '']],
      [{ d: 4, axis: 'z', at: [1, 2] }, [10, 10, null]],
    ];
    for (const [hole, extents] of cases) {
      const raw = spec({ components: [plate([hole], extents)] });
      expect(holesOf(normalizeClaudeSentinels(raw))[0].at).toEqual([1, 2]);
      expect(validate(raw).success).toBe(false);
    }
  });

  it('leaves three-item and one-item at untouched', () => {
    const raw = spec({
      components: [plate([{ d: 4, axis: 'y', at: [1, 2, 3] }, { d: 4, axis: 'y', at: [1] }])],
    });
    expect(holesOf(normalizeClaudeSentinels(raw)).map((h) => h.at)).toEqual([[1, 2, 3], [1]]);
  });
});

describe('fields sent as JSON strings', () => {
  it('components as a JSON string of the array is parsed (and its holes repaired)', () => {
    const components = [plate([{ d: 4, axis: 'y', at: ['hole_left_x', 'hole_top_z'] }])];
    const raw = spec({ components: JSON.stringify(components) });
    const out = normalizeClaudeSentinels(raw) as Spec;
    expect(out.components).toEqual([
      {
        name: 'back_plate',
        description: 'Wall plate.',
        localExtents: ['plate_w', 'wall', 'plate_h'],
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        shape: { kind: 'box' },
        holes: [{ d: 4, axis: 'y', at: ['hole_left_x', 'wall', 'hole_top_z'] }],
      },
    ]);
    expect(validate(raw).success).toBe(true);
  });

  it('parameters[1] as a JSON string of an object is parsed', () => {
    const p1 = { name: 'base_thickness', value: 5, min: 2, max: 15, step: 0.5, unit: 'mm', description: 'Thickness of the solid base plate (Z).' };
    const raw = spec({ parameters: [PARAMS[0], JSON.stringify(p1), ...PARAMS.slice(1)] });
    expect((normalizeClaudeSentinels(raw) as Spec).parameters).toEqual([PARAMS[0], p1, ...PARAMS.slice(1)]);
    expect(validate(raw).success).toBe(true);
  });

  it('every listed array field and boundingBox are parsed from JSON strings of the right kind', () => {
    const value = {
      parameters: PARAMS,
      derived: [{ name: 'half_w', expr: 'plate_w / 2' }],
      relations: [{ expr: 'hole_top_z < plate_h', why: 'Hole stays on the plate.' }],
      components: [plate([])],
      guides: [{ label: 'wall', kind: 'line', points: [[0, 0, 0], [0, 0, 100]] }],
      jointContracts: [{ type: 'press', clearance: 0.2, partA: 'a', partB: 'b' }],
      assumptions: [{ field: 'wall', value: '5', rationale: 'Stiff enough.' }],
      openQuestions: [{ id: 'q1', question: 'Screw size?', options: ['M3', 'M4'], suggestedAnswer: 'M4' }],
    };
    const bbox = { width: 60, length: 5, height: 80 };
    const raw: Spec = { assemblyName: 'wall_hook', boundingBox: JSON.stringify(bbox) };
    for (const [k, v] of Object.entries(value)) raw[k] = JSON.stringify(v);
    const out = parseStringifiedFields(raw);
    expect(out).toEqual({ assemblyName: 'wall_hook', boundingBox: bbox, ...value });
    expect(validate(raw).success).toBe(true);
  });

  it('every listed array field has its JSON-object string elements parsed, other elements untouched', () => {
    const q = { id: 'q1', question: 'Screw size?' };
    const out = parseStringifiedFields({
      openQuestions: [JSON.stringify(q), 'not json', '42', '[1,2]', q],
      derived: [JSON.stringify({ name: 'h', expr: 'a/2' })],
    });
    expect(out.openQuestions).toEqual([q, 'not json', '42', '[1,2]', q]);
    expect(out.derived).toEqual([{ name: 'h', expr: 'a/2' }]);
  });

  it('a string that is not valid JSON stays a string and fails validation as before', () => {
    // Real eval output: bare expressions inside profile points make the string invalid JSON.
    const broken = '[{"name":"clamp_body","description":"C clamp","localExtents":["clamp_w","clamp_d","clamp_h"],"shape":{"kind":"profile","plane":"xz","points":[[0,0],[wall+desk_t,0]]}}]';
    const raw = spec({ components: broken });
    expect((normalizeClaudeSentinels(raw) as Spec).components).toBe(broken);
    const res = validate(raw);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path).toEqual(['components']);
    expect(res.error?.issues[0].message).toBe('Invalid input: expected array, received string');
  });

  it('a string that parses as JSON of the wrong kind stays a string', () => {
    expect(parseStringifiedFields({ components: '{"name":"x"}', boundingBox: '[1,2,3]' })).toEqual({
      components: '{"name":"x"}',
      boundingBox: '[1,2,3]',
    });
  });
});

describe('guides points with two items', () => {
  it('are left alone: line points are assembly coordinates with no axis to place a third', () => {
    const raw = spec({ guides: [{ label: 'wall plane', kind: 'line', points: [[0, 0], [0, 0]] }] });
    expect((normalizeClaudeSentinels(raw) as { guides: Spec[] }).guides[0].points).toEqual([[0, 0], [0, 0]]);
    const res = validate(raw);
    expect(res.success).toBe(false);
    expect(res.error?.issues[0].path.join('.')).toBe('guides.0.points.0');
  });
});
