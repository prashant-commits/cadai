import { describe, it, expect } from 'vitest';
import { parseStatedDims, statedDimConformance, namedDimCoverage } from './dimensions';
import type { DesignerFacts } from '../../../src/lib/agent/designer/types';

describe('dimensions metric', () => {
  const hingedBoxPrompt =
    'A box 100 x 70 x 50 mm with a separate lid that rotates on two pin hinges along the back edge. The pins are 4 mm in diameter and pass through knuckles on both the box and the lid with 0.3 mm clearance.';

  const pipeTeePrompt =
    'A pipe tee fitting: a 60 mm long main tube with 25 mm outer diameter and 2.5 mm walls, and a branch tube of the same size joining it at 90 degrees at its middle, hollow through both.';

  describe('parseStatedDims', () => {
    it('parses hinged-box dimensions accurately', () => {
      const dims = parseStatedDims(hingedBoxPrompt);
      expect(dims).toHaveLength(5);

      const w = dims.find((d) => d.axis === 'x');
      const d = dims.find((d) => d.axis === 'y');
      const h = dims.find((d) => d.axis === 'z');
      const pin = dims.find((d) => d.what.includes('pin') || d.what.includes('diameter'));
      const clr = dims.find((d) => d.what.includes('clearance'));

      expect(w).toMatchObject({ mm: 100, axis: 'x' });
      expect(d).toMatchObject({ mm: 70, axis: 'y' });
      expect(h).toMatchObject({ mm: 50, axis: 'z' });
      expect(pin).toMatchObject({ mm: 4 });
      expect(clr).toMatchObject({ mm: 0.3 });
    });

    it('parses pipe-tee dimensions accurately', () => {
      const dims = parseStatedDims(pipeTeePrompt);
      expect(dims).toHaveLength(3);

      const len = dims.find((d) => d.what.includes('length') || d.mm === 60);
      const od = dims.find((d) => d.what.includes('outer diameter') || d.mm === 25);
      const wall = dims.find((d) => d.what.includes('wall') || d.mm === 2.5);

      expect(len).toMatchObject({ mm: 60 });
      expect(od).toMatchObject({ mm: 25 });
      expect(wall).toMatchObject({ mm: 2.5 });
    });
  });

  describe('namedDimCoverage', () => {
    it('computes coverage of top-level name = value variables in hinged box script', () => {
      const dims = parseStatedDims(hingedBoxPrompt);
      const script = `
from build123d import *
box_w = 100
box_d = 70
box_h = 50
pin_d = 4
clr = 0.3
wall = 3
      `;
      const coverage = namedDimCoverage(dims, script);
      expect(coverage).toBe(1.0);
    });

    it('computes partial coverage when some variables are omitted', () => {
      const dims = parseStatedDims(hingedBoxPrompt); // 5 dims
      const script = `
box_w = 100
box_d = 70
box_h = 50
// pin_d and clr missing
      `;
      const coverage = namedDimCoverage(dims, script);
      expect(coverage).toBe(3 / 5);
    });

    it('computes coverage in pipe tee script', () => {
      const dims = parseStatedDims(pipeTeePrompt);
      const script = `
main_len = 60
od = 25
wall_t = 2.5
      `;
      const coverage = namedDimCoverage(dims, script);
      expect(coverage).toBe(1.0);
    });
  });

  describe('statedDimConformance', () => {
    it('matches dimensions from facts and script variables for hinged box', () => {
      const dims = parseStatedDims(hingedBoxPrompt);
      const script = `
box_w = 100
box_d = 70
box_h = 50
pin_d = 4
clr = 0.3
      `;
      const facts: DesignerFacts = {
        ok: true,
        parts: [
          { label: 'box_body', size: [100, 78, 50], valid: true },
          { label: 'lid', size: [100, 78, 4], valid: true },
          { label: 'pin', size: [4, 4, 30], valid: true },
        ],
        interferences: [],
        disconnected: [],
        dimensions: [
          { name: 'box_w', value: 100 },
          { name: 'box_d', value: 70 },
          { name: 'box_h', value: 50 },
          { name: 'pin_d', value: 4 },
          { name: 'clr', value: 0.3 },
        ],
        span: [100, 78, 54],
      };

      const score = statedDimConformance(dims, facts, script);
      expect(score).toBe(1.0);
    });

    it('is generous to bodies when knuckles protrude beyond part bbox', () => {
      const dims = parseStatedDims(hingedBoxPrompt);
      // Here box_d = 70 is not in named dimensions, but Box(100, 70, 50) is in script body!
      const script = `
body = Box(100, 70, 50)
body = body + Cylinder(5, 10) # knuckles extend Y to 78 mm
pin = Cylinder(2, 20)
clr = 0.3
      `;
      // facts bbox shows 78 mm in Y, but body was 70 mm
      const facts: DesignerFacts = {
        ok: true,
        parts: [
          { label: 'box_body', size: [100, 78, 50], valid: true },
        ],
        interferences: [],
        disconnected: [],
        dimensions: [
          { name: 'clr', value: 0.3 },
        ],
      };

      const score = statedDimConformance(dims, facts, script);
      // 100 matched (part size X & Box X), 70 matched (Box Y), 50 matched (part size Z & Box Z),
      // 4 matched (Cylinder diameter 2*2), 0.3 matched (clr variable)
      expect(score).toBe(1.0);
    });

    it('matches pipe tee dimensions with facts', () => {
      const dims = parseStatedDims(pipeTeePrompt);
      const script = `
main_len = 60
od = 25
wall_t = 2.5
      `;
      const facts: DesignerFacts = {
        ok: true,
        parts: [
          { label: 'main_tube', size: [60, 25, 25], valid: true },
          { label: 'branch_tube', size: [25, 25, 40], valid: true },
        ],
        interferences: [],
        disconnected: [],
        dimensions: [
          { name: 'main_len', value: 60 },
          { name: 'od', value: 25 },
          { name: 'wall_t', value: 2.5 },
        ],
        span: [60, 25, 52.5],
      };

      const score = statedDimConformance(dims, facts, script);
      expect(score).toBe(1.0);
    });
  });
});
