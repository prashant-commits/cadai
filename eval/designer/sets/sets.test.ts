import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { EvalPrompt } from '../types';
import { generateIterativeSet } from './gen-iterative';

function loadJson<T>(filename: string): T {
  const p = join(__dirname, filename);
  return JSON.parse(readFileSync(p, 'utf8'));
}

describe('eval prompt sets', () => {
  it('validates open.json (12 product-like prompts)', () => {
    const prompts = loadJson<EvalPrompt[]>('open.json');
    expect(prompts).toHaveLength(12);
    for (const p of prompts) {
      expect(p.id).toBeDefined();
      expect(p.set).toBe('open');
      expect(p.request).toBeDefined();
      expect(p.request.length).toBeGreaterThan(10);
    }
    // Check dock prompt is present
    const dock = prompts.find((p) => p.id === 'user_dock' || p.id === 'dock');
    expect(dock).toBeDefined();
    expect(dock?.request).toContain('phone and a tablet upright');
  });

  it('validates prescriptive.json (13 A/B prompts with statedDims)', () => {
    const prompts = loadJson<EvalPrompt[]>('prescriptive.json');
    expect(prompts).toHaveLength(13);
    for (const p of prompts) {
      expect(p.id).toBeDefined();
      expect(p.set).toBe('prescriptive');
      expect(p.request).toBeDefined();
      expect(p.statedDims).toBeDefined();
      expect(p.statedDims!.length).toBeGreaterThan(0);
      for (const d of p.statedDims!) {
        expect(d.what).toBeDefined();
        expect(d.mm).toBeGreaterThan(0);
      }
    }
  });

  it('validates mechanism.json (6 motion and fit prompts)', () => {
    const prompts = loadJson<EvalPrompt[]>('mechanism.json');
    expect(prompts).toHaveLength(6);
    for (const p of prompts) {
      expect(p.id).toBeDefined();
      expect(p.set).toBe('mechanism');
      expect(p.request).toBeDefined();
    }
  });

  it('validates edits.json (6 sequences, each with 2 follow-ups of kind edit)', () => {
    const prompts = loadJson<EvalPrompt[]>('edits.json');
    expect(prompts).toHaveLength(6);
    for (const p of prompts) {
      expect(p.id).toBeDefined();
      expect(p.set).toBe('edits');
      expect(p.request).toBeDefined();
      expect(p.followUps).toHaveLength(2);
      for (const f of p.followUps!) {
        expect(f.kind).toBe('edit');
        expect(f.probe).toBeDefined();
        expect(f.probe.kind).toBeDefined();
      }
    }
  });

  it('validates adversarial.json (5 attack prompts)', () => {
    const prompts = loadJson<EvalPrompt[]>('adversarial.json');
    expect(prompts).toHaveLength(5);
    for (const p of prompts) {
      expect(p.id).toBeDefined();
      expect(p.set).toBe('adversarial');
      expect(p.request).toBeDefined();
      expect(p.adversarial?.attack).toBeDefined();
      expect(p.adversarial!.attack.length).toBeGreaterThan(5);
    }
  });

  it('validates iterative.json (12 sequences, 4x1, 4x2, 4x3 follow-ups, distinct kinds, >=2 conflicts)', () => {
    const prompts = loadJson<EvalPrompt[]>('iterative.json');
    expect(prompts).toHaveLength(12);

    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    let conflicts = 0;

    for (const p of prompts) {
      expect(p.id).toBeDefined();
      expect(p.set).toBe('iterative');
      expect(p.followUps).toBeDefined();

      const n = p.followUps!.length;
      expect([1, 2, 3]).toContain(n);
      counts[n] = (counts[n] || 0) + 1;

      // Ensure no two follow-ups share the same kind in the same sequence
      const kinds = p.followUps!.map((f) => f.kind);
      expect(new Set(kinds).size).toBe(kinds.length);

      for (const f of p.followUps!) {
        expect(f.probe).toBeDefined();
        expect(f.probe.kind).toBeDefined();
        if (f.kind === 'conflict') conflicts++;
      }
    }

    expect(counts).toEqual({ 1: 4, 2: 4, 3: 4 });
    expect(conflicts).toBeGreaterThanOrEqual(2);

    // Verify determinism from SEED
    const generated = generateIterativeSet();
    expect(generated).toEqual(prompts);
  });
});
