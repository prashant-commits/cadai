import { describe, it, expect } from 'vitest';
import { getFunctionalCadModuleTool, ENGINEERING_MODULE_REGISTRY } from './engineering-tools';

describe('Engineering Tools Registry', () => {
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
