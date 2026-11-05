import { describe, expect, it } from 'vitest';
import { systemPromptFor } from './system-prompt';

// Council 2026-11-06, items 3 and 4 (and the prose that items 1 and 2 make
// unnecessary): code owns contact and the bounding box, the Builder gets only
// what it needs, the sheet comes last and short, and the pose comes first.

const build = systemPromptFor('build', { placements: true });
const variant = systemPromptFor('variant', { placements: true });
const planner = systemPromptFor('planner', { placements: true });

describe('build prompt (Architect Builder)', () => {
  it('drops the spec vocabulary, the full-script FORMAT and every Drafter reference', () => {
    expect(build).not.toMatch(/SPEC VOCABULARY/);
    expect(build).not.toMatch(/Drafter|DRAFTER/);
    expect(build).not.toMatch(/Parameter block first/i);
  });

  it('no longer asks the model to fix contact with hull(); it shows one @body example instead', () => {
    expect(build).not.toMatch(/hull\(\) the round outline/);
    expect(build).not.toMatch(/JOINS\./);
    expect(build.match(/@body [a-z_]+\n/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('is at least 200 words shorter than before the council (1251 words)', () => {
    expect(build.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(1050);
  });
});

describe('variant prompt (Architect Specifier)', () => {
  it('no longer asks for a hand-computed boundingBox', () => {
    expect(variant).not.toMatch(/you redo it/);
    expect(variant).not.toMatch(/boundingBox included/);
  });

  it('opens the variant instructions with the insertion-axis pose line, before the field vocabulary', () => {
    const pose = variant.search(/Enters along \+Z/);
    expect(pose).toBeGreaterThan(-1);
    expect(pose).toBeLessThan(variant.search(/SPEC VOCABULARY/));
  });

  it('asks for the skeleton first and a short sheet last', () => {
    expect(variant).toMatch(/sheet[^.\n]*(last|at the end)/i);
    expect(variant).toMatch(/200 words/);
    expect(variant).not.toMatch(/Write 'sheet' first/);
  });
});

describe('planner prompt', () => {
  it('asks each variant to name the direction the object enters', () => {
    expect(planner).toMatch(/enters along|insertion axis/i);
  });
});

describe('no node carries the stale two-author pipeline text', () => {
  it.each(['planner', 'variant', 'build', 'reviewer'] as const)('%s', (node) => {
    expect(systemPromptFor(node, { placements: true })).not.toMatch(/NOT THE DRAFTER'S/);
  });
});
