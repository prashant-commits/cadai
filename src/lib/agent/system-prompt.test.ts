import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as prompts from './system-prompt';
import {
  systemPromptFor,
  CORE,
  SPEC_FIELDS,
  PLACEMENT_RULES,
  OPENSCAD_RULES,
  ARCHITECT_PLANNER_PREAMBLE,
  ARCHITECT_VARIANT_PREAMBLE,
  DRAFTER_PREAMBLE,
  DRAFTER_PLACEMENT_CONTRACT,
  CRITIC_PREAMBLE,
  REPAIR_PREAMBLE,
  SHEET_REVIEWER_PREAMBLE,
} from './system-prompt';
import { validateOpenScadCode } from './code-validator';
import { clearanceJointsNote } from './graph';
import { getFunctionalCadModuleTool } from './engineering-tools';
import { JUDGE_SYSTEM_PROMPT } from '../../../eval/generation/judge-prompt';

/** Every exported block and preamble. */
const BLOCKS: Record<string, string> = {
  CORE,
  SPEC_FIELDS,
  PLACEMENT_RULES,
  OPENSCAD_RULES,
  ARCHITECT_PLANNER_PREAMBLE,
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
  drafter: systemPromptFor('drafter'),
  drafterPlaced: systemPromptFor('drafter', { placements: true }),
  repair: systemPromptFor('repair'),
  critic: systemPromptFor('critic'),
  reviewer: systemPromptFor('reviewer'),
};

const words = (s: string) => s.trim().split(/\s+/).length;
const countCI = (text: string, phrase: string) => text.toLowerCase().split(phrase.toLowerCase()).length - 1;
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Every fenced block tagged `openscad`, with the block it came from. */
function openscadBlocks(): Array<{ name: string; index: number; code: string }> {
  const out: Array<{ name: string; index: number; code: string }> = [];
  for (const [name, text] of Object.entries(BLOCKS)) {
    const re = /```openscad\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    let index = 0;
    while ((m = re.exec(text)) !== null) out.push({ name, index: index++, code: m[1] });
  }
  return out;
}

/**
 * Ceilings, not targets: what rides on each model call. Measured before the
 * cleanup (267f928): planner 1283, variant 2077, drafter with placements 1713,
 * repair 1578, critic 1442, reviewer 162. A rewrite that quietly grows a
 * prompt fails here instead of drifting.
 */
const BLOCK_BUDGET: Record<string, number> = {
  CORE: 210,
  SPEC_FIELDS: 520,
  PLACEMENT_RULES: 200,
  OPENSCAD_RULES: 330,
};
const NODE_BUDGET: Record<string, number> = {
  planner: 450,
  variant: 1340,
  drafter: 1300,
  drafterPlaced: 1470,
  repair: 1610,
  critic: 650,
  reviewer: 250,
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
    expect(COMPOSED.variant).toBe(join(CORE, SPEC_FIELDS, PLACEMENT_RULES, ARCHITECT_VARIANT_PREAMBLE));
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
    expect(SPEC_FIELDS).toContain('stressPoints');

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
    expect(v).toContain('WHAT WILL BE MEASURED');
    expect(v).toMatch(/COHERENCE IS CHECKED/);
    expect(v).toContain('DESIGN CONTRACT');
    for (const field of [
      'localExtents',
      'positionNote',
      'stressPoints[].gusset',
      'corner [x, y, z]',
      "along ('x' | 'y')",
      "floorDir ('+' | '-')",
      'legMm',
      'thicknessMm',
      'at[]',
    ]) {
      expect(v, `variant prompt lost ${field}`).toContain(field);
    }
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

  it('changes the parked critic preamble by its bedFace sentence only', () => {
    // The frozen judge is the pre-cleanup CAD_AI_SYSTEM_PROMPT + '\n\n' + CRITIC_PREAMBLE.
    const start = JUDGE_SYSTEM_PROMPT.indexOf('You are the Design Inspector.');
    expect(start).toBeGreaterThan(0);
    const before = JUDGE_SYSTEM_PROMPT.slice(start);
    expect(CRITIC_PREAMBLE).toBe(before.replace(' Compare with the expected bedFace(s) you are given.', ''));
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
    const surfaces: Record<string, string> = { ...COMPOSED, toolDescription: getFunctionalCadModuleTool.description };
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

  it('embeds one OpenSCAD example with no top-level call, which compiles once its modules are called', async () => {
    const blocks = openscadBlocks();
    expect(blocks.length).toBe(1);
    for (const b of blocks) {
      const topLevel = b.code
        .split('\n')
        .filter((l) => /^\S/.test(l) && !/^(\/\/|\/\*|\*|module\s|function\s|\}|\$?[A-Za-z_]\w*\s*=)/.test(l));
      expect(topLevel, `${b.name} block ${b.index} has top-level statements`).toEqual([]);
      expect(b.code, `${b.name} block ${b.index} uses 3D minkowski`).not.toMatch(/minkowski\s*\(/);

      const modules = [...b.code.matchAll(/^module\s+([A-Za-z_]\w*)\s*\(/gm)].map((m) => m[1]);
      expect(modules.length, `${b.name} block ${b.index} defines no module`).toBeGreaterThan(0);
      const res = await validateOpenScadCode(`${b.code}\n${modules.map((m) => `${m}();`).join('\n')}\n`);
      expect(res.valid, `${b.name} block ${b.index} failed: ${res.error}\n${b.code}`).toBe(true);
      expect(res.isManifold, `${b.name} block ${b.index} is non-manifold`).not.toBe(false);
      // Silent corruption: an undeclared identifier compiles to the wrong solid.
      const silent = res.warnings.filter((w) => w.code === 'unknown_variable' || w.code === 'unknown_module');
      expect(silent, `${b.name} block ${b.index} references an undeclared identifier`).toHaveLength(0);
    }
  });

  it('does not offer the drafter a gusset template', () => {
    const keys = (getFunctionalCadModuleTool.schema as unknown as { shape: { moduleKey: { options: string[] } } })
      .shape.moduleKey.options;
    expect(keys).not.toContain('structural_ribs_gussets');
    expect(keys).toContain('fastener_hardware');
    expect(getFunctionalCadModuleTool.description).not.toContain('structural_ribs_gussets');
  });
});

describe('graph wiring', () => {
  const graphSrc = readFileSync(new URL('./graph.ts', import.meta.url), 'utf8');

  it('builds every system message through systemPromptFor', () => {
    expect(graphSrc).not.toMatch(/\b[A-Z_]+_PREAMBLE\b|DRAFTER_PLACEMENT_CONTRACT|CAD_AI_SYSTEM_PROMPT/);
    for (const node of ['planner', 'variant', 'reviewer', 'drafter', 'repair', 'critic']) {
      expect(graphSrc, `graph.ts never calls systemPromptFor('${node}')`).toContain(`systemPromptFor('${node}'`);
    }
  });

  it('drops the human-message text the cleanup retired', () => {
    expect(graphSrc).toContain('Implement the Architect Spec below as one complete OpenSCAD script.');
    expect(graphSrc).toContain('rest it on z = 0');
    for (const gone of ['Honour every field', 'choose a bedFace', 'apply the stress-point mitigations the part needs', 'print posture']) {
      expect(graphSrc, `graph.ts still says "${gone}"`).not.toContain(gone);
    }
  });

  it('Task D / L3: the code-cut note names the joints it covers and is empty without clearance joints', () => {
    const base = { assemblyName: 'x', sheet: '', boundingBox: { width: 1, length: 1, height: 1 }, components: [], guides: [], stressPoints: [], assumptions: [], openQuestions: [] };
    const withJoint = { ...base, jointContracts: [{ type: 'snap_fit', clearance: 0.2, partA: 'base', partB: 'tab' }] } as never;
    const note = clearanceJointsNote(withJoint);
    expect(note).toContain('Mating cavities for clearance joints are cut by code after your script (host = partA)');
    expect(note).toContain('tab into base (0.2 mm)');
    expect(note).toContain('Do not model slots, sockets or holes for the inserted parts of these joints');
    expect(clearanceJointsNote({ ...base } as never)).toBe('');
    expect(clearanceJointsNote({ ...base, jointContracts: [{ type: 'press_fit', clearance: 0, partA: 'a', partB: 'b' }] } as never)).toBe('');
    expect(clearanceJointsNote(null)).toBe('');
  });
});
