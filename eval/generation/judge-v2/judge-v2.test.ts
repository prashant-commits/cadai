import { describe, it, expect, vi } from 'vitest';
import {
  buildEvidence,
  computeStability,
} from './evidence';
import {
  computeOverallScore,
  computeCoverageStats,
  RubricVerdictSchema,
  type RubricVerdict,
} from './rubric';
import {
  comparePair,
} from './pairwise';
import { getRequirements } from './requirements';
import { parseStlTriangles } from '@/lib/engine/stl-renderer';

// Helpers to generate ASCII STL box
function makeAsciiBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): string {
  return `solid box
  facet normal 0 0 -1
    outer loop
      vertex ${x0} ${y0} ${z0}
      vertex ${x1} ${y0} ${z0}
      vertex ${x1} ${y1} ${z0}
    endloop
  endfacet
  facet normal 0 0 -1
    outer loop
      vertex ${x0} ${y0} ${z0}
      vertex ${x1} ${y1} ${z0}
      vertex ${x0} ${y1} ${z0}
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex ${x0} ${y0} ${z1}
      vertex ${x1} ${y1} ${z1}
      vertex ${x1} ${y0} ${z1}
    endloop
  endfacet
  facet normal 0 0 1
    outer loop
      vertex ${x0} ${y0} ${z1}
      vertex ${x0} ${y1} ${z1}
      vertex ${x1} ${y1} ${z1}
    endloop
  endfacet
endsolid box`;
}

describe('Judge v2: Geometry facts & fixtures', () => {
  it('detects interference between overlapping boxes', async () => {
    const box1Stl = Buffer.from(makeAsciiBox(0, 0, 0, 20, 20, 20)).toString('base64');
    const box2Stl = Buffer.from(makeAsciiBox(15, 0, 0, 35, 20, 20)).toString('base64');

    const fakeRunBrep = vi.fn().mockResolvedValue({
      ok: true,
      solids: 2,
      parts: [
        { label: 'box_a', valid: true, volume: 8000, min: [0, 0, 0], max: [20, 20, 20], centroid: [10, 10, 10] },
        { label: 'box_b', valid: true, volume: 8000, min: [15, 0, 0], max: [35, 20, 20], centroid: [25, 10, 10] },
      ],
      partMeshes: {
        box_a: box1Stl,
        box_b: box2Stl,
      },
      bbox: { min: [0, 0, 0], max: [35, 20, 20] },
      interferences: [{ a: 'box_a', b: 'box_b', volume: 2000 }],
    });

    const script = `
from build123d import *
a = Box(20, 20, 20); a.label = 'box_a'
b = Pos(15, 0, 0) * Box(20, 20, 20); b.label = 'box_b'
result = Compound([a, b])
`;

    const ev = await buildEvidence({ script, runBrepFn: fakeRunBrep });
    expect(ev.facts.interferences.closed).toHaveLength(1);
    expect(ev.facts.interferences.closed[0]).toEqual({
      a: 'box_a',
      b: 'box_b',
      volume: 2000,
    });
    expect(ev.factsMarkdown).toContain("**Closed state collision**: 'box_a' collides with 'box_b'");
  });

  it('detects disconnected parts that do not touch and are not within 1 mm of any other part', async () => {
    const box1Stl = Buffer.from(makeAsciiBox(0, 0, 0, 20, 20, 20)).toString('base64');
    const box2Stl = Buffer.from(makeAsciiBox(50, 0, 0, 70, 20, 20)).toString('base64');

    const fakeRunBrep = vi.fn().mockResolvedValue({
      ok: true,
      solids: 2,
      parts: [
        { label: 'main_body', valid: true, volume: 8000, min: [0, 0, 0], max: [20, 20, 20], centroid: [10, 10, 10] },
        { label: 'floating_pin', valid: true, volume: 8000, min: [50, 0, 0], max: [70, 20, 20], centroid: [60, 10, 10] },
      ],
      partMeshes: {
        main_body: box1Stl,
        floating_pin: box2Stl,
      },
      bbox: { min: [0, 0, 0], max: [70, 20, 20] },
      disconnected: ['floating_pin'],
    });

    const script = `
from build123d import *
a = Box(20, 20, 20); a.label = 'main_body'
b = Pos(50, 0, 0) * Box(20, 20, 20); b.label = 'floating_pin'
result = Compound([a, b])
`;

    const ev = await buildEvidence({ script, runBrepFn: fakeRunBrep });
    expect(ev.facts.disconnected).toEqual(['floating_pin']);
    expect(ev.factsMarkdown).toContain("- **DISCONNECTED**: Part 'floating_pin' does not touch and is not within 1 mm of any other part in the closed state.");
  });

  it('computes a negative stability margin for a top-heavy overhanging part', () => {
    // Footprint is [0, 50] x [0, 50] at z <= 0.5 mm
    const footprintTriangles = parseStlTriangles(makeAsciiBox(0, 0, 0, 50, 50, 1));
    // Center of mass hangs way out to the right at x = 80, y = 25
    const com: [number, number, number] = [80, 25, 100];

    const stability = computeStability(com, footprintTriangles);
    expect(stability.isStable).toBe(false);
    expect(stability.marginMm).toBeLessThan(0);
    // Footprint max X is 50, com X is 80 -> margin should be approx -30 mm
    expect(stability.marginMm).toBeCloseTo(-30, 0);
  });

  it('detects a lid parameter with a range and renders the pose at max range', async () => {
    const boxStl = Buffer.from(makeAsciiBox(0, 0, 0, 50, 50, 10)).toString('base64');
    const fakeRunBrep = vi.fn().mockImplementation(async (s: string) => {
      const isPose = s.includes('lid_open_deg = 90');
      return {
        ok: true,
        solids: 2,
        parts: [
          { label: 'base', valid: true, volume: 5000, min: [0, 0, 0], max: [50, 50, 10], centroid: [25, 25, 5] },
          { label: 'lid', valid: true, volume: 1000, min: [0, 0, 10], max: [50, 50, 14], centroid: [25, 25, 12] },
        ],
        partMeshes: {
          base: boxStl,
          lid: boxStl,
        },
        bbox: { min: [0, 0, 0], max: [50, 50, isPose ? 55 : 14] },
        interferences: isPose ? [{ a: 'base', b: 'lid', volume: 50 }] : [],
      };
    });

    const script = `
from build123d import *
lid_open_deg = 0  # [0:10:90] lid opening angle in degrees
base = Box(50, 50, 10); base.label = 'base'
lid = Box(50, 50, 4); lid.label = 'lid'
result = Compound([base, lid])
`;

    const ev = await buildEvidence({ script, runBrepFn: fakeRunBrep });
    expect(ev.poseRenders).toHaveLength(1);
    expect(ev.poseRenders[0].paramName).toBe('lid_open_deg');
    expect(ev.poseRenders[0].value).toBe(90);
    expect(ev.poseRenders[0].views).toHaveLength(2); // iso + right
    expect(ev.poseRenders[0].views.map((v) => v.name)).toEqual(['iso', 'right']);

    // Check that pose interference was recorded in facts table
    expect(ev.facts.interferences.poses['lid_open_deg=90']).toBeDefined();
    expect(ev.facts.interferences.poses['lid_open_deg=90']).toHaveLength(1);
  });

  it('lid-hidden render removes the lid part from the view', async () => {
    const baseStl = Buffer.from(makeAsciiBox(0, 0, 0, 50, 50, 20)).toString('base64');
    const lidStl = Buffer.from(makeAsciiBox(0, 0, 20, 50, 50, 24)).toString('base64');

    const fakeRunBrep = vi.fn().mockResolvedValue({
      ok: true,
      solids: 2,
      parts: [
        { label: 'storage_box', valid: true, volume: 5000, min: [0, 0, 0], max: [50, 50, 20], centroid: [25, 25, 10] },
        { label: 'top_lid', valid: true, volume: 1000, min: [0, 0, 20], max: [50, 50, 24], centroid: [25, 25, 22] },
      ],
      partMeshes: {
        storage_box: baseStl,
        top_lid: lidStl,
      },
      bbox: { min: [0, 0, 0], max: [50, 50, 24] },
    });

    const script = `
from build123d import *
b = Box(50, 50, 20); b.label = 'storage_box'
l = Box(50, 50, 4); l.label = 'top_lid'
result = Compound([b, l])
`;

    const ev = await buildEvidence({ script, runBrepFn: fakeRunBrep });
    expect(ev.closedViews).toHaveLength(6);
    expect(ev.lidHiddenViews).toHaveLength(2); // iso and top
    expect(ev.lidHiddenViews.map((v) => v.name)).toEqual(['iso', 'top']);
  });
});

describe('Judge v2: Requirements checklist caching', () => {
  it('reads cached requirements from disk without invoking the LLM', async () => {
    const checklist = await getRequirements('dock', 'dummy prompt text');
    expect(checklist.promptId).toBe('dock');
    expect(checklist.requirements.length).toBeGreaterThan(15);

    const ids = checklist.requirements.map((r) => r.id);
    expect(ids).toContain('base_dimensions');
    expect(ids).toContain('mounting_holes_features');
    expect(ids).toContain('phone_cradle_placement');
    expect(ids).toContain('lid_dimensions');
    expect(ids).toContain('param_lean_angle');
  });
});

describe('Judge v2: Rubric score calculation and schema', () => {
  it('correctly validates rubric output schema and weights criterion scores into 0-100', () => {
    const sampleVerdict: RubricVerdict = {
      requirements: [
        { id: 'req_1', status: 'met', evidence: '180x120 base verified' },
        { id: 'req_2', status: 'partly', evidence: 'hole diameter is 4mm instead of 5mm' },
        { id: 'req_3', status: 'unmet', evidence: 'no lid found' },
        { id: 'req_4', status: 'unverifiable', evidence: 'internal bore clearance' },
      ],
      criteria: {
        requirementsCoverage: { score: 5, justification: 'Good coverage' }, // weight 25 -> 25
        layoutAndClearances: { score: 4, justification: 'Minor overlap' }, // weight 12 -> 9.6
        functionAndMotion: { score: 5, justification: 'Smooth' }, // weight 18 -> 18
        accessibility: { score: 3, justification: 'Screws blocked' }, // weight 8 -> 4.8
        manufacturabilityAndRobustness: { score: 5, justification: 'Very stable' }, // weight 12 -> 12
        parametricQuality: { score: 4, justification: 'Good sliders' }, // weight 10 -> 8
        formAndAesthetics: { score: 4, justification: 'Cohesive form' }, // weight 15 -> 12
      },
      findings: [
        { issue: 'Blocked screws', severity: 'minor', criterion: 'accessibility' },
      ],
      summary: 'Solid overall design with minor access issue.',
    };

    // Validate Zod schema
    const parsed = RubricVerdictSchema.parse(sampleVerdict);
    expect(parsed).toEqual(sampleVerdict);

    // Expected score = 25 + 9.6 + 18 + 4.8 + 12 + 8 + 12 = 89.4 -> 89
    const overall = computeOverallScore(parsed.criteria);
    expect(overall).toBe(89);

    // Check coverage stats: 1 met, 1 partly, 1 unmet, 1 unverifiable -> total 4, effective 1.5/4 = 38%
    const stats = computeCoverageStats(parsed.requirements);
    expect(stats.met).toBe(1);
    expect(stats.partly).toBe(1);
    expect(stats.unmet).toBe(1);
    expect(stats.unverifiable).toBe(1);
    expect(stats.percent).toBe(38);
  });

  it('scores 100 for all-5 criteria and 0 for all-0 criteria', () => {
    const perfectCriteria: RubricVerdict['criteria'] = {
      requirementsCoverage: { score: 5, justification: '' },
      layoutAndClearances: { score: 5, justification: '' },
      functionAndMotion: { score: 5, justification: '' },
      accessibility: { score: 5, justification: '' },
      manufacturabilityAndRobustness: { score: 5, justification: '' },
      parametricQuality: { score: 5, justification: '' },
      formAndAesthetics: { score: 5, justification: '' },
    };
    expect(computeOverallScore(perfectCriteria)).toBe(100);

    const zeroCriteria: RubricVerdict['criteria'] = {
      requirementsCoverage: { score: 0, justification: '' },
      layoutAndClearances: { score: 0, justification: '' },
      functionAndMotion: { score: 0, justification: '' },
      accessibility: { score: 0, justification: '' },
      manufacturabilityAndRobustness: { score: 0, justification: '' },
      parametricQuality: { score: 0, justification: '' },
      formAndAesthetics: { score: 0, justification: '' },
    };
    expect(computeOverallScore(zeroCriteria)).toBe(0);
  });
});

describe('Judge v2: Pairwise order-swap tie logic', () => {
  it('agrees when both order presentations favor the same design', async () => {
    const fakeEv = {
      closedViews: [],
      lidHiddenViews: [],
      poseRenders: [],
      legend: [],
      facts: {} as never,
      factsMarkdown: '',
    };

    // Mock structuredFor to return 'first' when A is first (order 1), and 'second' when B is first (order 2)
    // Both mean Design A is better!
    let callCount = 0;
    const fakeStructured = {
      invoke: vi.fn().mockImplementation(async () => {
        callCount++;
        const winner = callCount === 1 ? 'first' : 'second';
        return {
          winner,
          criteria: {
            requirementsCoverage: winner,
            layoutAndClearances: winner,
            functionAndMotion: winner,
            accessibility: winner,
            manufacturabilityAndRobustness: winner,
            parametricQuality: winner,
            formAndAesthetics: winner,
          },
          reasons: {
            requirementsCoverage: '',
            layoutAndClearances: '',
            functionAndMotion: '',
            accessibility: '',
            manufacturabilityAndRobustness: '',
            parametricQuality: '',
            formAndAesthetics: '',
            overall: '',
          },
        };
      }),
    };

    // Spy on structuredFor in llm-schemas
    const llmSchemas = await import('@/lib/agent/llm-schemas');
    const spy = vi.spyOn(llmSchemas, 'structuredFor').mockReturnValue(fakeStructured as never);

    const res = await comparePair({
      request: 'req',
      checklist: { promptId: 'p', requirements: [] },
      evA: fakeEv,
      evB: fakeEv,
    });

    expect(res.winner).toBe('A');
    expect(res.agreed).toBe(true);
    spy.mockRestore();
  });

  it('counts a disagreement between order presentations as a tie', async () => {
    const fakeEv = {
      closedViews: [],
      lidHiddenViews: [],
      poseRenders: [],
      legend: [],
      facts: {} as never,
      factsMarkdown: '',
    };

    // Both calls return 'first' (order bias: whichever design was presented first wins)
    // Order 1 says A wins; Order 2 says B wins. This is a disagreement -> consensus must be 'tie'!
    const fakeStructured = {
      invoke: vi.fn().mockResolvedValue({
        winner: 'first',
        criteria: {
          requirementsCoverage: 'first',
          layoutAndClearances: 'first',
          functionAndMotion: 'first',
          accessibility: 'first',
          manufacturabilityAndRobustness: 'first',
          parametricQuality: 'first',
          formAndAesthetics: 'first',
        },
        reasons: {
          requirementsCoverage: '',
          layoutAndClearances: '',
          functionAndMotion: '',
          accessibility: '',
          manufacturabilityAndRobustness: '',
          parametricQuality: '',
          formAndAesthetics: '',
          overall: '',
        },
      }),
    };

    const llmSchemas = await import('@/lib/agent/llm-schemas');
    const spy = vi.spyOn(llmSchemas, 'structuredFor').mockReturnValue(fakeStructured as never);

    const res = await comparePair({
      request: 'req',
      checklist: { promptId: 'p', requirements: [] },
      evA: fakeEv,
      evB: fakeEv,
    });

    expect(res.winner).toBe('tie');
    expect(res.agreed).toBe(false);
    expect(res.criteria.layoutAndClearances.winner).toBe('tie');
    expect(res.criteria.layoutAndClearances.agreed).toBe(false);
    spy.mockRestore();
  });
});
