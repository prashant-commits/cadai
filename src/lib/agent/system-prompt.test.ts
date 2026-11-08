import { BREP_CHEATSHEET } from '../brep/cheatsheet';
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as prompts from './system-prompt';
import {
  systemPromptFor,
  type PromptNode,
  CORE,
  SPEC_FIELDS,
  PLACEMENT_RULES,
  OPENSCAD_RULES,
  BUILD_GUARDRAILS,
  ARCHITECT_PLANNER_PREAMBLE,
  ARCHITECT_VARIANT_POSE,
  ARCHITECT_VARIANT_PREAMBLE,
  DRAFTER_PREAMBLE,
  DRAFTER_PLACEMENT_CONTRACT,
  CRITIC_PREAMBLE,
  REPAIR_PREAMBLE,
  SHEET_REVIEWER_PREAMBLE,
} from './system-prompt';

/** Every exported block and preamble. */
const BLOCKS: Record<string, string> = {
  CORE,
  SPEC_FIELDS,
  PLACEMENT_RULES,
  OPENSCAD_RULES,
  BUILD_GUARDRAILS,
  ARCHITECT_PLANNER_PREAMBLE,
  ARCHITECT_VARIANT_POSE,
  ARCHITECT_VARIANT_PREAMBLE,
  DRAFTER_PREAMBLE,
  DRAFTER_PLACEMENT_CONTRACT,
  CRITIC_PREAMBLE,
  REPAIR_PREAMBLE,
  SHEET_REVIEWER_PREAMBLE,
};

/** The system prompt each model call actually receives. */
const COMPOSED: Record<string, string> = {
  planner: systemPromptFor('planner'),
  variant: systemPromptFor('variant'),
  build: systemPromptFor('build'),
  drafter: systemPromptFor('drafter'),
  drafterPlaced: systemPromptFor('drafter', { placements: true }),
  repair: systemPromptFor('repair'),
  critic: systemPromptFor('critic'),
  reviewer: systemPromptFor('reviewer'),
};

const words = (s: string) => s.trim().split(/\s+/).length;
const countCI = (text: string, phrase: string) => text.toLowerCase().split(phrase.toLowerCase()).length - 1;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');



/**
 * Ceilings, not targets: what rides on each model call. Measured before the
 * cleanup (267f928): planner 1283, variant 2077, drafter with placements 1713,
 * repair 1578, critic 1442, reviewer 162. A rewrite that quietly grows a
 * prompt fails here instead of drifting.
 */
const BLOCK_BUDGET: Record<string, number> = {
  CORE: 210,
  SPEC_FIELDS: 580, // +60 for the relational fields and expression grammar (Task 3)
  PLACEMENT_RULES: 200,
  OPENSCAD_RULES: 330,
  BUILD_GUARDRAILS: 140,
};
const NODE_BUDGET: Record<string, number> = {
  planner: 450,
  variant: 1440, // lowered from 1460 by the council rewrite (no bbox arithmetic, no pose essay)
  drafter: 1360,
  drafterPlaced: 1530,
  repair: 1670,
  critic: 650,
  reviewer: 250,
  build: 700, // was 1251 before the council slimmed it
};

/**
 * Fabrication vocabulary that must not return. cadai is a parametric modelling
 * tool; process framing made models import constraints nobody asked for and
 * reshape the requested geometry to satisfy them. Printability belongs to a
 * separate, opt-in node. The tool description rides on every drafter call, so
 * it is guarded too.
 */
const FABRICATION_TERMS =
  /\b(FDM|nozzle|PLA|PETG|ABS\/ASA|filament|slicer|slicing|layer height|layer adhesion|extrusion width|infill|raft|brim|overhang|unsupported area|bridging|support structures?|build plate|warp|heat-set|zero-assembly)\b/i;

describe('system prompt composition', () => {
  it('composes each node from the shared blocks, each block once', () => {
    const join = (...parts: string[]) => parts.join('\n\n');
    expect(COMPOSED.planner).toBe(join(CORE, ARCHITECT_PLANNER_PREAMBLE));
    expect(COMPOSED.variant).toBe(join(CORE, ARCHITECT_VARIANT_POSE, SPEC_FIELDS, PLACEMENT_RULES, ARCHITECT_VARIANT_PREAMBLE));
    expect(COMPOSED.drafter).toBe(join(CORE, SPEC_FIELDS, OPENSCAD_RULES, DRAFTER_PREAMBLE));
    expect(COMPOSED.drafterPlaced).toBe(join(CORE, SPEC_FIELDS, OPENSCAD_RULES, DRAFTER_PREAMBLE, DRAFTER_PLACEMENT_CONTRACT));
    expect(COMPOSED.repair).toBe(join(CORE, SPEC_FIELDS, PLACEMENT_RULES, OPENSCAD_RULES, REPAIR_PREAMBLE));
    expect(COMPOSED.critic).toBe(join(CORE, CRITIC_PREAMBLE));
    expect(COMPOSED.reviewer).toBe(SHEET_REVIEWER_PREAMBLE);
  });

  it('exports trimmed, non-empty blocks and no monolithic shared prompt', () => {
    for (const [name, text] of Object.entries(BLOCKS)) {
      expect(text, `${name} has leading or trailing whitespace`).toBe(text.trim());
      expect(text.length, `${name} is empty`).toBeGreaterThan(0);
    }
    expect((prompts as Record<string, unknown>).CAD_AI_SYSTEM_PROMPT).toBeUndefined();
  });

  it('stays within its word budget', () => {
    for (const [name, max] of Object.entries(BLOCK_BUDGET)) {
      expect(words(BLOCKS[name]), `${name} is ${words(BLOCKS[name])} words`).toBeLessThanOrEqual(max);
    }
    for (const [node, max] of Object.entries(NODE_BUDGET)) {
      expect(words(COMPOSED[node]), `${node} is ${words(COMPOSED[node])} words`).toBeLessThanOrEqual(max);
    }
  });

  it('states each shared rule once per call', () => {
    const ONCE = [
      'two cross-axis extents are equal and are the diameter',
      'DRAWN but NEVER BUILT',
      'freeform markdown design sheet',
      'mirror()',
      'partA is the host',
      'Edges stay sharp',
      'about its OWN min corner',
      'Standard clearance holes',
      'nothing is ever below it',
    ];
    for (const [node, text] of Object.entries(COMPOSED)) {
      for (const phrase of ONCE) {
        expect(countCI(text, phrase), `${node} states "${phrase}" more than once`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('puts each shared rule in the block the nodes that act on it receive', () => {
    expect(CORE).toMatch(/Edges stay sharp/);
    expect(CORE).toMatch(/ground plane; nothing is ever below it/);

    expect(SPEC_FIELDS).toMatch(/xz\s*->\s*\(x,\s*z\),\s*extruded along y/i);
    expect(SPEC_FIELDS).toMatch(/two cross-axis extents are equal and are the diameter/i);
    expect(SPEC_FIELDS).toContain('DRAWN but NEVER BUILT');
    expect(SPEC_FIELDS).toContain('freeform markdown design sheet');
    expect(SPEC_FIELDS).toMatch(/partA is the HOST/i);
    expect(SPEC_FIELDS).toMatch(/partB is the INSERTED part/i);
    expect(SPEC_FIELDS).toMatch(/cuts the host's cavity/i);
    expect(SPEC_FIELDS).toMatch(/do NOT model mating cavities yourself/i);
    expect(SPEC_FIELDS).toContain('Standard clearance holes');
    expect(SPEC_FIELDS).toContain('holes');

    expect(PLACEMENT_RULES).toMatch(/about its OWN min corner/);
    expect(PLACEMENT_RULES).toMatch(/180 - a/);

    expect(OPENSCAD_RULES).toMatch(/NEVER 3D minkowski/);
    expect(OPENSCAD_RULES).toContain('mirror()');
  });
});

describe('node preambles', () => {
  it('keeps the planner to planning: no code rules, the shape kinds by name', () => {
    expect(COMPOSED.planner).not.toContain('```openscad');
    expect(COMPOSED.planner).not.toMatch(/minkowski/i);
    expect(COMPOSED.planner).not.toContain('Standard clearance holes');
    for (const kind of ['box', 'cylinder', 'tube', 'shell', 'profile']) {
      expect(ARCHITECT_PLANNER_PREAMBLE, `planner does not name the ${kind} shape`).toContain(kind);
    }
    expect(ARCHITECT_PLANNER_PREAMBLE).toContain('Mechanical Architect Planner');
    expect(ARCHITECT_PLANNER_PREAMBLE).toMatch(/BUILD WHAT WAS ASKED FOR/);
    expect(countCI(ARCHITECT_PLANNER_PREAMBLE, 'build what was asked for')).toBe(1);
    expect(ARCHITECT_PLANNER_PREAMBLE).toMatch(/VISIBLE STRUCTURE/);
    expect(ARCHITECT_PLANNER_PREAMBLE).toMatch(/Variant A follows the request literally/i);
    expect(ARCHITECT_PLANNER_PREAMBLE).toMatch(/When fewer than 2 visibly different variants make sense, plan only 1/i);
  });

  it('keeps the variant preamble to what the specifier decides', () => {
    const v = COMPOSED.variant;
    expect(ARCHITECT_VARIANT_PREAMBLE).toContain('Mechanical Architect Specifier');
    expect(v).not.toMatch(/WHAT WILL BE MEASURED|COHERENCE IS CHECKED/);
    expect(v).toContain('DESIGN CONTRACT');
    for (const field of ['localExtents', 'positionNote']) {
      expect(v, `variant prompt lost ${field}`).toContain(field);
    }
    // Stress points and gussets are engineering analysis, not modelling: the Architect is not asked for them.
    expect(ARCHITECT_VARIANT_PREAMBLE).not.toContain('stressPoints');
    expect(SPEC_FIELDS).not.toContain('stressPoints');
    // The model is built in the pose it is used in, never laid out for manufacture.
    expect(ARCHITECT_VARIANT_POSE).toMatch(/Wall-mounted means upright against a vertical wall/);
    expect(countCI(v, 'never laid flat')).toBe(1);
    expect(v).toMatch(/holds or supports an object/i);
    expect(v).toMatch(/guides envelope at its resting pose/i);
  });

  it('keeps the drafter tool sentence consistent with the rest of the prompt', () => {
    expect(DRAFTER_PREAMBLE).toContain('get_functional_cad_module');
    expect(DRAFTER_PREAMBLE).toContain('fastener_hardware');
    expect(DRAFTER_PREAMBLE).not.toContain('structural_ribs_gussets');
    expect(DRAFTER_PREAMBLE).toMatch(/never model a gusset/i);
    expect(DRAFTER_PREAMBLE).toContain('stressPoints');
    expect(DRAFTER_PREAMBLE).toContain('localExtents');
    expect(DRAFTER_PREAMBLE).toContain('holes');
    expect(DRAFTER_PLACEMENT_CONTRACT).toContain('localExtents');
    expect(COMPOSED.drafter).toContain('mirror()');
  });

  it('leaves the parked repair and sheet reviewer preambles byte-identical', () => {
    expect(sha256(REPAIR_PREAMBLE)).toBe('40ecbd7d62a6b609565d42d742e79c425afb01e2f05f89b7f651e42d4aef070a');
    expect(sha256(SHEET_REVIEWER_PREAMBLE)).toBe('ff28ebfe17aa0f2209effb5e658ba13507d6adc348f4dc0c99cebfb54a2167cc');
  });



  it('keeps the placement contract heading in the contract only', () => {
    expect(DRAFTER_PLACEMENT_CONTRACT).toContain('PLACEMENT CONTRACT');
    for (const [name, text] of Object.entries(BLOCKS)) {
      if (name === 'DRAFTER_PLACEMENT_CONTRACT') continue;
      expect(text, `${name} duplicates the placement contract heading`).not.toContain('PLACEMENT CONTRACT');
    }
    expect(COMPOSED.drafter).not.toContain('PLACEMENT CONTRACT');
    expect(countCI(COMPOSED.drafterPlaced, 'PLACEMENT CONTRACT')).toBe(1);
  });
});

describe('prompt content guards', () => {
  it('frames the work as parametric modelling, with no fabrication process', () => {
    const surfaces: Record<string, string> = { ...COMPOSED };
    for (const [name, text] of Object.entries(surfaces)) {
      const hit = FABRICATION_TERMS.exec(text);
      expect(hit?.[0], `${name} reintroduces fabrication framing ("${hit?.[0]}")`).toBeUndefined();
    }
  });

  it('teaches no edge treatment anywhere', () => {
    // Sentences that prohibit them ("never", "no", "sharp") are the only place the words may appear.
    const withoutProhibitions = (text: string) =>
      text.split(/(?<=\.)\s+|\n/).filter((s) => !/\b(never|no|sharp)\b/i.test(s)).join('\n');
    for (const [name, text] of Object.entries(COMPOSED)) {
      expect(withoutProhibitions(text), `${name} still teaches an edge treatment`).not.toMatch(
        /edgeTreatment|elephant|lead-in|lead_in|teardrop|\b(fillets?|chamfers?|rounding)\b/i
      );
    }
  });

  it('drops retired fields, bedFace and stale references', () => {
    const STALE = [
      'registry family',
      '12 keys',
      'fastener_hardware tool',
      'feature-free',
      'reorient',
      'REQUIRED CHANGES',
      'Changes in this revision',
      'compilation or geometry error',
    ];
    for (const [name, text] of Object.entries(COMPOSED)) {
      expect(text, `${name} mentions a retired spec field`).not.toMatch(/\b(dimensions|form|useModules|matingFaces)\b/);
      expect(text, `${name} still teaches bedFace`).not.toMatch(/bedFace|bed face/i);
      expect(text, `${name} talks about print pose`).not.toMatch(/PRINT pose|print layout/i);
      for (const stale of STALE) {
        expect(text, `${name} still says "${stale}"`).not.toContain(stale);
      }
    }
  });
});

describe('council review round 1', () => {
  const build = systemPromptFor('build');
  const example = build.slice(build.indexOf('@body base_plate\n'), build.lastIndexOf('@end') + 4);

  it('the @body example uses only names a spec can be assumed to declare', () => {
    expect(example.length).toBeGreaterThan(0);
    expect(build).not.toMatch(/margin/i);
    const ids = new Set((example.replace(/\/\/.*$/gm, '').match(/[a-z_][a-z0-9_]*/g) ?? []));
    const allowed = new Set(['body', 'base_plate', 'difference', 'cube', 'translate', 'end',
      'plate_w', 'plate_d', 'plate_t', 'slot_x', 'slot_y', 'slot_w', 'slot_len']);
    expect([...ids].filter((id) => !allowed.has(id))).toEqual([]);
    expect(build).toMatch(/names stand for parameters your spec declares/);
  });

  it('the planner does not anchor the entry axis on +Z', () => {
    const planner = systemPromptFor('planner');
    expect(planner).toMatch(/enters along/i);
    expect(planner).not.toMatch(/[+-][XYZ]\b/);
  });

  it('build keeps the hole and jointContract rules and says one piece outranks scope', () => {
    expect(build).toMatch(/holes\[\]: cut each at its d and axis/);
    expect(build).toMatch(/no depth means through/);
    expect(build).toMatch(/jointContracts: code cuts the host's mating cavity, so never model one/);
    expect(build).toMatch(/ONE PIECE OUTRANKS SCOPE/);
  });

  it('build carries no spec-only audits and no inter-part overlap contradiction', () => {
    expect(BUILD_GUARDRAILS).not.toMatch(/self-coherence|bounding box vs spec|shells <=|'wall' in its name/);
    expect(build).not.toMatch(/write no lands or overlaps of your own/);
  });

  it('the variant prompt headers the pose line, keeps the spec-side join rule and orders the pipeline skeleton first', () => {
    expect(ARCHITECT_VARIANT_POSE).toMatch(/^## ENTRY AND POSE/);
    expect(ARCHITECT_VARIANT_PREAMBLE).toMatch(/never specify a cut that splits a component/i);
    expect(ARCHITECT_VARIANT_PREAMBLE).toMatch(/Name every wall-thickness parameter with 'wall'/);
    expect(CORE).toMatch(/skeleton \+ sheet/);
    expect(CORE).not.toMatch(/sheet \+ skeleton/);
  });
});

describe('relational spec prompt (Task 3)', () => {
  it('asks the Architect for parameters, derived values, relations and expressions', () => {
    for (const field of ['parameters[]', 'derived[]', 'relations[]']) {
      expect(SPEC_FIELDS, field).toContain(field);
    }
    expect(ARCHITECT_VARIANT_PREAMBLE).toMatch(/parameter/i);
    expect(ARCHITECT_VARIANT_PREAMBLE).toMatch(/expression/i);
    expect(ARCHITECT_VARIANT_PREAMBLE).toMatch(/Every parameter must drive at least one component dimension or position/);
  });

  it('states the expression grammar once, in SPEC_FIELDS', () => {
    expect(SPEC_FIELDS).toMatch(/\+ - \* \//);
    expect(SPEC_FIELDS).toMatch(/min\(.*max\(.*sqrt\(/);
    expect(ARCHITECT_VARIANT_PREAMBLE).not.toMatch(/sqrt\(/);
  });

  it('keeps the relational instructions out of the planner', () => {
    expect(ARCHITECT_PLANNER_PREAMBLE).not.toContain('derived[]');
  });

  it('the brep-build prompt never tells the model to import', () => {
    const prompt = systemPromptFor('brep-build');
    expect(prompt).not.toMatch(/^\s*(from \S+ )?import /m);
    expect(prompt).toContain('already has these in scope');
    expect(prompt).toContain('## Primitives');
  });

  it('the brep-build prompt says bodies are algebra mode only, in the preamble and the cheat sheet', () => {
    const prompt = systemPromptFor('brep-build');
    expect(prompt.match(/algebra mode only/gi)?.length).toBeGreaterThanOrEqual(2);
    expect(prompt).toContain('extrude(Plane.YZ * Polygon(*pts, align=None), amount=w)');
    expect(prompt).toContain('extrude(make_face(Polyline(*pts, close=True)), amount=w)');
    expect(prompt).toContain('Never write `with BuildPart`, `with BuildSketch` or `with BuildLine`');
  });

  it('no example in the cheat sheet teaches builder mode', () => {
    const fences = [...BREP_CHEATSHEET.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(fences.length).toBeGreaterThan(3);
    for (const fence of fences) expect(fence).not.toMatch(/\bBuild(?:Part|Sketch|Line)\b/);
  });

  describe('kernel-aware prompts (DL1)', () => {
    it('OpenSCAD prompts are byte-identical whether kernel is omitted or explicit', () => {
      const nodes: PromptNode[] = ['planner', 'variant', 'drafter', 'repair', 'critic', 'reviewer', 'build'];
      for (const node of nodes) {
        expect(systemPromptFor(node, { kernel: 'openscad' })).toBe(systemPromptFor(node));
      }
    });

    it('OpenSCAD prompt snapshots/hashes remain pinned', () => {
      // Literal pinned pre-dl1 sha256 hashes of OpenSCAD system prompts
      expect(sha256(systemPromptFor('planner', { kernel: 'openscad' }))).toBe('d14bab577c58b50cc5c894704f4d3189143eceb0a91840175ca2fb19772dc013');
      expect(sha256(systemPromptFor('variant', { kernel: 'openscad' }))).toBe('6089ee4b4393d165c75590e9ceca6b9dbe86bbaf915bfbcd5580cc99db47b157');
      expect(sha256(systemPromptFor('drafter', { kernel: 'openscad' }))).toBe('3eed6c25e5836af205a02554d22a10d7a5005d7ae20170aac2732b5130787aa2');
      expect(sha256(systemPromptFor('drafter', { placements: true, kernel: 'openscad' }))).toBe('822e0e9c80c9732cc04d8898be3b9e6462cd80b8c836976a29512b52f2110a43');
      expect(sha256(systemPromptFor('repair', { kernel: 'openscad' }))).toBe('803e8e4801d47d82640710b7bff8e40c27f19281608c65b263fadeffa8a617e3');
      expect(sha256(systemPromptFor('critic', { kernel: 'openscad' }))).toBe('c786bcf29b2da378d4b6fe1fabc9d85661b505bb2a95268436f4e83be2f10906');
      expect(sha256(systemPromptFor('reviewer', { kernel: 'openscad' }))).toBe('ff28ebfe17aa0f2209effb5e658ba13507d6adc348f4dc0c99cebfb54a2167cc');
      expect(sha256(systemPromptFor('build', { kernel: 'openscad' }))).toBe('df8f22131318d039183dbcb498190b919c739741ef4cc60955a61a7f8b5b25f6');
    });

    it('B-rep prompts contain design-language guidance and no "no fillets" text', () => {
      const brepPlanner = systemPromptFor('planner', { kernel: 'brep' });
      const brepVariant = systemPromptFor('variant', { kernel: 'brep' });
      const brepReviewer = systemPromptFor('reviewer', { kernel: 'brep' });
      const brepBuild = systemPromptFor('brep-build', { kernel: 'brep' });

      for (const [name, prompt] of Object.entries({ brepPlanner, brepVariant, brepReviewer, brepBuild })) {
        expect(prompt, `${name} has 'no chamfers'`).not.toMatch(/no chamfers, fillets, rounds/i);
        expect(prompt, `${name} has 'no fillets or chamfers'`).not.toMatch(/no fillets or chamfers/i);
        expect(prompt, `${name} has 'never ask for chamfers'`).not.toMatch(/never ask for chamfers or fillets/i);
      }

      expect(brepPlanner).toContain('designLanguage');
      expect(brepPlanner).toContain('differ in form, not only structure');

      expect(brepVariant).toContain('designLanguage');
      expect(brepVariant).toContain('edgeRadius');
      expect(brepVariant).toContain('edge_r');

      expect(brepReviewer).toContain('Geometry and design language only');
      expect(brepReviewer).not.toContain('Check that outer edge treatment matches');

      expect(brepBuild).toContain('BUILD GUIDANCE');
      expect(brepBuild).toContain('apply the variant\'s designLanguage');
      expect(brepBuild).toContain('Round outer edges with the radius family');
    });
  });
});
