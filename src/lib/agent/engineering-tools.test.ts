import { describe, it, expect } from 'vitest';
import { getFunctionalCadModuleTool, ENGINEERING_MODULE_REGISTRY } from './engineering-tools';

describe('Engineering Tools Registry', () => {
  /**
   * The registry's prose - descriptions, parameter help and design notes - is
   * handed to the Drafter as a tool schema, so it is prompt text with a
   * different name. It used to carry fabrication advice ("orient the beam flat
   * in XY for layer strength", "0.35mm standard for FDM") that primed the model
   * to reason about a process this pipeline does not model, and then to reshape
   * geometry to suit it. Dimensions stay; the process lore does not.
   *
   * 'print_in_place_hinge' is exempt: it is a registry key and an emitted
   * OpenSCAD module name, and renaming it would invalidate the useModules
   * values in every spec already stored.
   */
  it('keeps fabrication-process framing out of the text the Drafter is shown', () => {
    const FABRICATION =
      /\b(FDM|nozzle|PLA|PETG|filament|slicer|layer (height|strength|adhesion)|overhang|build plate|printing|printed|printab\w*)\b/i;
    for (const [key, entry] of Object.entries(ENGINEERING_MODULE_REGISTRY)) {
      const prose = [entry.name, entry.description, ...entry.engineeringParameters, ...entry.designRules].join('\n');
      const hit = FABRICATION.exec(prose);
      expect(hit?.[0], `${key} describes a fabrication process ("${hit?.[0]}")`).toBeUndefined();
    }
  });

  /**
   * The same text was telling the Drafter to add a fillet at a cantilever root
   * and a lead-in chamfer on a dovetail, while every prompt told it edges stay
   * sharp. The prompts already have this guard; the registry is prompt text
   * too, and it was contradicting them.
   *
   * designRules are instructions and must not ask for an edge treatment.
   * engineeringParameters may still NAME one (`chamfer` is a parameter of the
   * gusset template), since naming a knob is not telling the model to turn it.
   */
  it('never instructs the Drafter to add an edge treatment', () => {
    const TREATMENT = /\b(fillets?|chamfers?|rounds?|rounding|teardrops?|lead-ins?|elephant)\b/i;
    for (const [key, entry] of Object.entries(ENGINEERING_MODULE_REGISTRY)) {
      for (const rule of entry.designRules) {
        const hit = TREATMENT.exec(rule);
        expect(hit?.[0], `${key} designRule asks for an edge treatment ("${hit?.[0]}"): ${rule}`).toBeUndefined();
      }
    }
  });

  it('should have all key functional mechanical and mathematical modules', () => {
    const requiredKeys = [
      'fastener_hardware',
      'cantilever_snap_fit',
      'enclosure_features',
      'structural_ribs_gussets',
      'sliding_dovetail_joint',
      'print_in_place_hinge',
      'honeycomb_lattice',
      'polar_bolt_circle',
      'involute_spur_gear',
    ];

    for (const key of requiredKeys) {
      expect(ENGINEERING_MODULE_REGISTRY[key]).toBeDefined();
      expect(ENGINEERING_MODULE_REGISTRY[key].codeTemplate).toContain('module ');
    }
  });

  it('should successfully retrieve tool definitions via getFunctionalCadModuleTool', async () => {
    const rawResult = await getFunctionalCadModuleTool.invoke({
      moduleKey: 'fastener_hardware',
    });

    const parsed = JSON.parse(rawResult);
    expect(parsed.name).toContain('Fastener');
    expect(parsed.codeTemplate).toContain('bolt_clearance_hole');
    expect(parsed.codeTemplate).toContain('hex_nut_trap');
    expect(parsed.designRules.length).toBeGreaterThan(0);
  });

  it('should retrieve cantilever snap-fit parameters and strain rules', async () => {
    const rawResult = await getFunctionalCadModuleTool.invoke({
      moduleKey: 'cantilever_snap_fit',
    });

    const parsed = JSON.parse(rawResult);
    expect(parsed.name).toContain('Snap-Fit');
    expect(parsed.codeTemplate).toContain('snap_fit_cantilever');
  });

  it('should retrieve mathematical honeycomb lattice module', async () => {
    const rawResult = await getFunctionalCadModuleTool.invoke({
      moduleKey: 'honeycomb_lattice',
    });

    const parsed = JSON.parse(rawResult);
    expect(parsed.category).toBe('mathematical_lattice');
    expect(parsed.codeTemplate).toContain('honeycomb_lattice_cutout');
  });
});

describe('orientation idioms', () => {
  it('is registered and listed in the tool', async () => {
    expect(ENGINEERING_MODULE_REGISTRY.orientation_idioms.category).toBe('orientation');
    const raw = await getFunctionalCadModuleTool.invoke({ moduleKey: 'orientation_idioms' });
    expect(JSON.parse(raw).codeTemplate).toContain('module profile_extrude_y');
  });

  // The test is the oracle for the sign conventions: every idiom must compile
  // and land its min corner exactly on the origin.
  it.each([
    ['profile_extrude_y([[0,0],[30,0],[0,20]], 4);', [30, 4, 20]],
    ['profile_extrude_x([[0,0],[30,0],[0,20]], 4);', [4, 30, 20]],
    ['cylinder_along_x(10, 50);', [50, 10, 10]],
    ['cylinder_along_y(10, 50);', [10, 50, 10]],
    ['box_at_origin([10, 20, 30]);', [10, 20, 30]],
  ])('%s sits at the origin with the documented extents', async (call, size) => {
    const { compileScad } = await import('../engine/scad-compiler');
    const template = ENGINEERING_MODULE_REGISTRY.orientation_idioms.codeTemplate;
    const r = await compileScad(`$fn = 32;\n${template}\n${call}\n`);
    expect(r.valid, r.error).toBe(true);
    const bb = r.summary!.boundingBox!;
    bb.min.forEach((v) => expect(Math.abs(v)).toBeLessThan(0.05));
    bb.size.forEach((v, i) => expect(v).toBeCloseTo(size[i], 1));
  });
});
