import { describe, it, expect } from 'vitest';
import { composeAssembly, instantiationFor } from './compose-assembly';
import { AssemblySpec } from '../agent/assembly-spec';
import { checkInterference } from '../engine/assembly-verifier';
import { compileScad } from '../engine/scad-compiler';
import { blockoutScad, shapeScad } from '../spec-sheet/blockout-scad';
import { analyzeStl } from '../engine/geometry-utils';
import { measureModuleFrames } from '../engine/module-frames';
import { fixtureSpec } from '../spec-sheet/fixtures';
import { checkAssemblyFit } from '../agent/graph';

describe('mating cuts', () => {
  it('Peg in a block: cylinder B through box A with clearance 0.2 (z >= 0)', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'peg_block',
      boundingBox: { width: 100, length: 100, height: 100 },
      jointContracts: [
        { type: 'insert', clearance: 0.2, partA: 'box_a', partB: 'peg_b' }
      ],
      components: [
        { 
          name: 'box_a', 
          description: 'A', 
          localExtents: [40, 40, 20], 
          position: [0, 0, 0], 
          shape: { kind: 'box' } 
        },
        { 
          name: 'peg_b', 
          description: 'B', 
          localExtents: [8, 8, 40], 
          position: [20, 20, 0], 
          shape: { kind: 'cylinder', axis: 'z' } 
        }
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: []
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['box_a', 'peg_b']);
    
    // Check initial compile of box A (without cuts)
    const initCode = `${blockout}\nbox_a();`;
    const plainRes = await compileScad(initCode);
    expect(plainRes.valid).toBe(true);
    const plainVol = analyzeStl(plainRes.stl!).volumeMm3;

    // Compose assembly (which applies mating cuts to box_a)
    const result = composeAssembly(blockout, spec, frames);
    expect(result.composed).toBe(true);
    const composedCode = result.code;

    // Verify it compiles
    const compRes = await compileScad(composedCode);
    expect(compRes.valid).toBe(true);

    // Verify no interference
    const callA = instantiationFor(spec, 'box_a', frames);
    const callB = instantiationFor(spec, 'peg_b', frames);
    expect(callA).toBeTruthy();
    expect(callB).toBeTruthy();
    const interf = await checkInterference(blockout, callA!, callB!);
    expect(interf.hasInterference).toBe(false);

    // Check volume dropped by roughly the grown cylinder
    const cutCode = `${blockout}\n${callA}`;
    const cutRes = await compileScad(cutCode);
    expect(cutRes.valid, cutCode).toBe(true);
    const cutVol = analyzeStl(cutRes.stl!).volumeMm3;
    const diff = plainVol - cutVol;
    expect(diff).toBeGreaterThan(1100);
    expect(diff).toBeLessThan(1120);
  });

  it('Tilted backrest through a plate with cut volume drop (z >= 0)', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'phone_stand',
      boundingBox: { width: 120, length: 80, height: 110 },
      jointContracts: [
        { type: 'slot_fit', clearance: 0.2, partA: 'plate_a', partB: 'backrest_b' }
      ],
      components: [
        { 
          name: 'plate_a', 
          description: 'A', 
          localExtents: [120, 80, 10], 
          position: [0, 0, 0], 
          shape: { kind: 'box' } 
        },
        { 
          name: 'backrest_b', 
          description: 'B', 
          localExtents: [90, 4, 110], 
          position: [15, 30, 2], 
          rotation: [25, 0, 0],
          shape: { kind: 'box' } 
        }
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: []
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['plate_a', 'backrest_b']);

    // Plain volume of plate
    const plainRes = await compileScad(`${blockout}\nplate_a();`);
    expect(plainRes.valid).toBe(true);
    const plainVol = analyzeStl(plainRes.stl!).volumeMm3;

    const callA = instantiationFor(spec, 'plate_a', frames);
    const callB = instantiationFor(spec, 'backrest_b', frames);
    expect(callA).toBeTruthy();
    expect(callB).toBeTruthy();

    // Cut volume of plate
    const cutRes = await compileScad(`${blockout}\n${callA}`);
    expect(cutRes.valid).toBe(true);
    const cutVol = analyzeStl(cutRes.stl!).volumeMm3;

    // Verify slot volume dropped
    expect(plainVol - cutVol).toBeGreaterThan(500);

    const interf = await checkInterference(blockout, callA!, callB!);
    expect(interf.hasInterference).toBe(false);
  });

  it('Profile insert: L-profile B into A with clearance 0.3 (z >= 0)', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'profile_insert',
      boundingBox: { width: 100, length: 100, height: 100 },
      jointContracts: [
        { type: 'insert', clearance: 0.3, partA: 'box_a', partB: 'profile_b' }
      ],
      components: [
        { 
          name: 'box_a', 
          description: 'A', 
          localExtents: [40, 40, 20], 
          position: [0, 0, 0], 
          shape: { kind: 'box' } 
        },
        { 
          name: 'profile_b', 
          description: 'B', 
          localExtents: [20, 20, 40], 
          position: [10, 10, 0], 
          shape: { 
            kind: 'profile', 
            plane: 'xy',
            points: [[0, 0], [20, 0], [20, 4], [4, 4], [4, 20], [0, 20]]
          } 
        }
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: []
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['box_a', 'profile_b']);

    const result = composeAssembly(blockout, spec, frames);
    expect(result.code).toContain('offset(delta = 0.3)');

    const callA = instantiationFor(spec, 'box_a', frames);
    const callB = instantiationFor(spec, 'profile_b', frames);
    const interf = await checkInterference(blockout, callA!, callB!);
    expect(interf.hasInterference).toBe(false);
  });

  it('A 0-clearance joint gets NO cut (z >= 0)', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'zero_clearance',
      boundingBox: { width: 100, length: 100, height: 100 },
      jointContracts: [
        { type: 'insert', clearance: 0, partA: 'box_a', partB: 'peg_b' }
      ],
      components: [
        { 
          name: 'box_a', 
          description: 'A', 
          localExtents: [40, 40, 20], 
          position: [0, 0, 0], 
          shape: { kind: 'box' } 
        },
        { 
          name: 'peg_b', 
          description: 'B', 
          localExtents: [8, 8, 40], 
          position: [20, 20, 0], 
          shape: { kind: 'cylinder', axis: 'z' } 
        }
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: []
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['box_a', 'peg_b']);

    const result = composeAssembly(blockout, spec, frames);
    expect(result.code).not.toContain('difference() {');
  });

  it('blockoutScad output for the existing fixture is byte-identical to before', () => {
    const code = blockoutScad(fixtureSpec()).code;
    expect(code.replace(/\r\n/g, '\n')).toMatchInlineSnapshot(`
      "$fn = 48; // segment count for cylinders, tubes and hole cutters

      module base_plate() {
          difference() { // holes of base_plate
              cube([80, 50, 6]); // localExtents of base_plate
              translate([20, 25, -0.01]) cylinder(h = 6.02, d = 5); // through hole of base_plate along z; d is hole.d; h spans localExtents plus 0.01 mm overshoot at each end
          }
      }

      module post() {
          translate([7, 7, 0]) cylinder(h = 36, d = 14); // cylinder of post; h is localExtents.z; d is the cross-section extent; centred on the other two axes
      }

      module sleeve() {
          difference() { // bore of sleeve
              translate([9, 9, 0]) cylinder(h = 12, d = 18); // outer cylinder of sleeve; h is localExtents.z; d is the cross-section extent; centred on the other two axes
              translate([9, 9, -0.01]) cylinder(h = 12.02, d = 8); // inner cylinder of sleeve; d is innerD; h is localExtents.z plus 0.01 mm past each end
          }
      }

      module tray() {
          difference() { // shell cavity of tray, open +Z
              cube([26, 16, 12]); // localExtents of tray
              translate([2, 2, 2]) cube([22, 12, 10.01]); // wall of tray inset from each closed face, 0.01 mm overshoot through the open face
          }
      }

      module link() {
          difference() { // holes of link
              linear_extrude(height = 5) polygon(points = [[0, 0], [28, 0], [28, 16], [0, 16], [8, 11], [18, 11], [18, 5], [8, 5]], paths = [[0, 1, 2, 3], [4, 5, 6, 7]]); // xy profile of link; height is localExtents.z; points are the outline and holes
              translate([4, 4, 2]) cylinder(h = 3.01, d = 3); // blind hole of link along z; d is hole.d; h bores inward from the entry face to hole.depth, with 0.01 mm outward overshoot
          }
      }

      module rail() {
          cube([40, 8, 8]); // localExtents of rail
      }
      "
    `);
  });

  it('H1: Chain base <- post <- pin compiles and checkAssemblyFit is empty', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'chain_test',
      boundingBox: { width: 50, length: 50, height: 60 },
      jointContracts: [
        { type: 'socket', clearance: 0.2, partA: 'base', partB: 'post' },
        { type: 'cross_pin', clearance: 0.2, partA: 'post', partB: 'pin' },
      ],
      components: [
        {
          name: 'base',
          description: 'base plate',
          localExtents: [40, 40, 20],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'post',
          description: 'upright post',
          localExtents: [8, 8, 40],
          position: [16, 16, 0],
          shape: { kind: 'cylinder', axis: 'z' },
        },
        {
          name: 'pin',
          description: 'cross pin',
          localExtents: [2, 12, 2],
          position: [19, 14, 30],
          shape: { kind: 'cylinder', axis: 'y' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['base', 'post', 'pin']);

    const callBase = instantiationFor(spec, 'base', frames);
    const callPost = instantiationFor(spec, 'post', frames);
    expect(callBase).toContain('post');
    expect(callPost).toContain('pin');

    const result = composeAssembly(blockout, spec, frames);
    expect(result.composed).toBe(true);

    const fit = await checkAssemblyFit(result.code, spec, frames);
    expect(fit).toEqual([]);
  });

  it('H1: Host cut by two parts has two cut lines in one difference()', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'two_cuts',
      boundingBox: { width: 80, length: 80, height: 30 },
      jointContracts: [
        { type: 'socket', clearance: 0.2, partA: 'base', partB: 'peg1' },
        { type: 'socket', clearance: 0.2, partA: 'base', partB: 'peg2' },
      ],
      components: [
        {
          name: 'base',
          description: 'base plate',
          localExtents: [80, 80, 20],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'peg1',
          description: 'peg 1',
          localExtents: [8, 8, 30],
          position: [20, 20, 0],
          shape: { kind: 'cylinder', axis: 'z' },
        },
        {
          name: 'peg2',
          description: 'peg 2',
          localExtents: [8, 8, 30],
          position: [50, 50, 0],
          shape: { kind: 'cylinder', axis: 'z' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['base', 'peg1', 'peg2']);

    const result = composeAssembly(blockout, spec, frames);
    expect(result.composed).toBe(true);
    expect(result.code).toContain('difference() {');
    expect(result.code).toContain('cut for peg1');
    expect(result.code).toContain('cut for peg2');

    const fit = await checkAssemblyFit(result.code, spec, frames);
    expect(fit).toEqual([]);
  });

  it('Opus M1: d 4 peg with no global $fn gives no interference (circumscribed $fn = 96)', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'peg_no_fn',
      boundingBox: { width: 30, length: 30, height: 20 },
      jointContracts: [
        { type: 'socket', clearance: 0.2, partA: 'base', partB: 'peg' },
      ],
      components: [
        {
          name: 'base',
          description: 'base block',
          localExtents: [30, 30, 10],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'peg',
          description: 'small peg',
          localExtents: [4, 4, 20],
          position: [13, 13, 0],
          shape: { kind: 'cylinder', axis: 'z' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    // Script with NO global $fn
    const code = `
module base() {
    cube([30, 30, 10]);
}
module peg() {
    cylinder(h = 20, d = 4);
}
`;
    const frames = await measureModuleFrames(code, ['base', 'peg']);
    const callA = instantiationFor(spec, 'base', frames);
    const callB = instantiationFor(spec, 'peg', frames);
    expect(callA).toContain('$fn = 96');

    const interf = await checkInterference(code, callA!, callB!);
    expect(interf.hasInterference).toBe(false);
  });

  it('Opus M2: Editing tab_pos_x moves the cavity with the tab', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'param_move',
      boundingBox: { width: 100, length: 50, height: 20 },
      jointContracts: [
        { type: 'slot_fit', clearance: 0.2, partA: 'plate', partB: 'tab' },
      ],
      components: [
        {
          name: 'plate',
          description: 'plate',
          localExtents: [100, 50, 10],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'tab',
          description: 'tab',
          localExtents: [10, 20, 15],
          position: [30, 15, 0],
          shape: { kind: 'box' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    const blockout = blockoutScad(spec).code;
    const frames = await measureModuleFrames(blockout, ['plate', 'tab']);
    const result = composeAssembly(blockout, spec, frames);

    expect(result.code).toContain('tab_pos_x = 30;');
    expect(result.code).toContain('translate([tab_pos_x,');

    // Simulate parametric edit in the design panel
    const edited = result.code.replace('tab_pos_x = 30;', 'tab_pos_x = 45;');
    const compRes = await compileScad(edited);
    expect(compRes.valid).toBe(true);
  });

  it('Non-zero frame-correction test: offset module and cut cavity align at spec position', async () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'correction_test',
      boundingBox: { width: 50, length: 50, height: 30 },
      jointContracts: [
        { type: 'socket', clearance: 0.2, partA: 'base', partB: 'peg' },
      ],
      components: [
        {
          name: 'base',
          description: 'base block',
          localExtents: [40, 40, 20],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'peg',
          description: 'peg with offset origin',
          localExtents: [8, 8, 30],
          position: [16, 16, 0],
          shape: { kind: 'cylinder', axis: 'z' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    // Peg is authored offset from its origin by [10, 10, 0]
    const code = `
$fn = 48;
module base() {
    cube([40, 40, 20]);
}
module peg() {
    translate([10, 10, 0]) cylinder(h = 30, d = 8);
}
`;
    const frames = await measureModuleFrames(code, ['base', 'peg']);
    const pegFrame = frames.find((f) => f.name === 'peg');
    expect(pegFrame?.min).toEqual([6, 6, 0]);

    const result = composeAssembly(code, spec, frames);
    expect(result.composed).toBe(true);
    expect(result.code).toContain('local-frame correction: peg');

    const callA = instantiationFor(spec, 'base', frames);
    const callB = instantiationFor(spec, 'peg', frames);
    const interf = await checkInterference(code, callA!, callB!);
    expect(interf.hasInterference).toBe(false);
  });

  it('Fable L1: Undrawable profile falls back to grown box envelope with report note', () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'fallback_test',
      boundingBox: { width: 50, length: 50, height: 30 },
      jointContracts: [
        { type: 'slot', clearance: 0.2, partA: 'host', partB: 'bad_insert' },
      ],
      components: [
        {
          name: 'host',
          description: 'host block',
          localExtents: [40, 40, 20],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'bad_insert',
          description: 'profile with fewer than 3 points',
          localExtents: [10, 10, 20],
          position: [15, 15, 0],
          shape: {
            kind: 'profile',
            plane: 'xy',
            points: [[0, 0], [10, 0]], // only 2 points
          },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    const blockout = blockoutScad(spec).code;
    const result = composeAssembly(blockout, spec, []);
    expect(result.report?.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('fell back to box envelope')])
    );
    expect(result.code).toContain('cube([10.4, 10.4, 20.4])');
  });

  it('The hollow-insert question: Profile insert with holes cuts a solid cavity', () => {
    const comp = {
      name: 'hollow_profile',
      description: 'profile with hole',
      localExtents: [20, 20, 10],
      position: [0, 0, 0],
      shape: {
        kind: 'profile' as const,
        plane: 'xy' as const,
        points: [[0, 0], [20, 0], [20, 20], [0, 20]],
        holes: [[[5, 5], [15, 5], [15, 15], [5, 15]]],
      },
    };

    const cutScad = shapeScad(comp, 0.2);
    // Outer points are present and grown
    expect(cutScad).toContain('offset(delta = 0.2)');
    expect(cutScad).toContain('[0, 0]');
    expect(cutScad).toContain('[20, 20]');
    // Hole path indices [4, 5, 6, 7] must NOT be present (solid cavity)
    expect(cutScad).not.toContain('[4, 5, 6, 7]');
  });

  it('Nit: Silent skip when inserted component is missing gets a report note', () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'missing_insert',
      boundingBox: { width: 50, length: 50, height: 30 },
      jointContracts: [
        { type: 'socket', clearance: 0.2, partA: 'host', partB: 'phantom' },
      ],
      components: [
        {
          name: 'host',
          description: 'host block',
          localExtents: [40, 40, 20],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    const blockout = blockoutScad(spec).code;
    const result = composeAssembly(blockout, spec, []);
    expect(result.report?.notes).toContain('skipped cut for phantom (missing component)');
  });

  it('Cycle skip: Mutual cycle A <- B and B <- A skips cut with report note', () => {
    const spec: AssemblySpec = {
      sheet: 'test',
      assemblyName: 'cycle_test',
      boundingBox: { width: 50, length: 50, height: 30 },
      jointContracts: [
        { type: 'socket', clearance: 0.2, partA: 'part_a', partB: 'part_b' },
        { type: 'socket', clearance: 0.2, partA: 'part_b', partB: 'part_a' },
      ],
      components: [
        {
          name: 'part_a',
          description: 'part A',
          localExtents: [20, 20, 20],
          position: [0, 0, 0],
          shape: { kind: 'box' },
        },
        {
          name: 'part_b',
          description: 'part B',
          localExtents: [20, 20, 20],
          position: [10, 0, 0],
          shape: { kind: 'box' },
        },
      ],
      guides: [],
      stressPoints: [],
      assumptions: [],
      openQuestions: [],
    };

    const blockout = blockoutScad(spec).code;
    const result = composeAssembly(blockout, spec, []);
    expect(result.report?.notes).toContain('skipped mutual cut cycle between part_a and part_b');
    expect(result.code).not.toContain('difference() {');
  });
});
