import { describe, it, expect } from 'vitest';
import {
  CAD_AI_SYSTEM_PROMPT,
  ARCHITECT_PREAMBLE,
  DRAFTER_PREAMBLE,
  DRAFTER_PLACEMENT_CONTRACT,
  CRITIC_PREAMBLE,
  REPAIR_PREAMBLE,
} from './system-prompt';
import { validateOpenScadCode } from './code-validator';

const PROMPTS: Record<string, string> = {
  CAD_AI_SYSTEM_PROMPT,
  ARCHITECT_PREAMBLE,
  DRAFTER_PREAMBLE,
  DRAFTER_PLACEMENT_CONTRACT,
  CRITIC_PREAMBLE,
  REPAIR_PREAMBLE,
};

/** Every fenced block tagged `openscad`, with the prompt it came from. */
function openscadBlocks(): Array<{ prompt: string; index: number; code: string }> {
  const out: Array<{ prompt: string; index: number; code: string }> = [];
  for (const [prompt, text] of Object.entries(PROMPTS)) {
    const re = /```openscad\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    let index = 0;
    while ((m = re.exec(text)) !== null) {
      out.push({ prompt, index: index++, code: m[1] });
    }
  }
  return out;
}

const words = (s: string) => s.trim().split(/\s+/).length;

/**
 * Ceilings, not targets. The system prompt rides on every model call and each
 * preamble on its node's calls, so a rewrite that quietly doubles one of them
 * costs tokens on every run - this makes that a failing test rather than a
 * slow drift.
 */
const WORD_BUDGET: Record<string, number> = {
  CAD_AI_SYSTEM_PROMPT: 1300,
  ARCHITECT_PREAMBLE: 520,
  DRAFTER_PREAMBLE: 560,
  DRAFTER_PLACEMENT_CONTRACT: 260,
  CRITIC_PREAMBLE: 460,
  REPAIR_PREAMBLE: 460,
};

describe('system prompts', () => {
  it('embeds only OpenSCAD examples that compile to real 3D geometry', async () => {
    const blocks = openscadBlocks();
    // A prompt with zero examples would pass vacuously; the idioms are the point.
    expect(blocks.length).toBeGreaterThanOrEqual(4);

    for (const b of blocks) {
      expect(b.code, `${b.prompt} block ${b.index} uses 3D minkowski`).not.toMatch(/minkowski\s*\(/);
      const res = await validateOpenScadCode(b.code);
      expect(res.valid, `${b.prompt} block ${b.index} failed: ${res.error}\n${b.code}`).toBe(true);
      expect(res.isManifold, `${b.prompt} block ${b.index} is non-manifold`).not.toBe(false);
      // Silent corruption: an undeclared identifier compiles to the wrong solid.
      const silent = res.warnings.filter((w) => w.code === 'unknown_variable' || w.code === 'unknown_module');
      expect(silent, `${b.prompt} block ${b.index} references an undeclared identifier`).toHaveLength(0);
    }
  });

  it('keeps the substrings the graph and its tests depend on', () => {
    expect(DRAFTER_PLACEMENT_CONTRACT).toContain('PLACEMENT CONTRACT');
    // The contract is appended only when the spec has placements; a copy of
    // its heading in another prompt would defeat graph-placement.test.ts.
    for (const [name, text] of Object.entries(PROMPTS)) {
      if (name === 'DRAFTER_PLACEMENT_CONTRACT') continue;
      expect(text, `${name} duplicates the placement contract heading`).not.toContain('PLACEMENT CONTRACT');
      expect(text, `${name} blurs the compile/geometry split`).not.toContain('compilation or geometry error');
    }
  });

  it('teaches every node the spec fields for flat faces, corner categories and stress points', () => {
    for (const field of ['bedFace', 'matingFaces', 'edgeTreatments', 'stressPoints']) {
      expect(CAD_AI_SYSTEM_PROMPT).toContain(field);
      expect(ARCHITECT_PREAMBLE).toContain(field);
    }
    for (const category of ['stress_relief', 'printability', 'assembly_lead_in', 'ergonomic_cosmetic']) {
      expect(CAD_AI_SYSTEM_PROMPT).toContain(category);
    }
    // The drafter implements and the repair node must not undo.
    expect(DRAFTER_PREAMBLE).toContain('edgeTreatments');
    expect(DRAFTER_PREAMBLE).toContain('stressPoints');
    expect(REPAIR_PREAMBLE).toMatch(/never delete/i);
    expect(REPAIR_PREAMBLE).toContain('flat-packable');
    // The critic checks posture but is told not to judge sizes it cannot see.
    expect(CRITIC_PREAMBLE).toContain('bedFace');
    expect(CRITIC_PREAMBLE).toMatch(/empty findings list is the correct/i);
    expect(CAD_AI_SYSTEM_PROMPT).toMatch(/NEVER 3D minkowski/);
  });

  it('stays within its word budget', () => {
    for (const [name, text] of Object.entries(PROMPTS)) {
      expect(words(text), `${name} is ${words(text)} words`).toBeLessThanOrEqual(WORD_BUDGET[name]);
    }
  });
});
