import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

interface BaselineEntry {
  source: string;
  scriptPath?: string;
  stlPath?: string;
}

describe('baselines manifest', () => {
  const manifestPath = join(__dirname, 'manifest.json');
  expect(existsSync(manifestPath)).toBe(true);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  it('maps prescriptive prompt ids to existing baseline scripts', () => {
    const prescriptiveIds = [
      'hinged_lid_box',
      'snap_fit_case',
      'desk_clamp_tilted_post',
      'hex_grid_organizer',
      'pipe_tee',
      'gear_blanks_on_plate',
      'curved_wall_arm',
      'drawer_on_rails',
      'angled_lamp_mount',
      'stackable_crate',
      'headphone_saddle_stand',
      'adjustable_shelf_bracket',
      'phone_tablet_dock',
    ];

    for (const id of prescriptiveIds) {
      const entry = manifest[id] as BaselineEntry | undefined;
      expect(entry, `Entry for ${id} should exist`).toBeDefined();
      expect(entry?.source).toBeDefined();
      expect(entry?.scriptPath).toBeDefined();

      const absScript = join(process.cwd(), entry!.scriptPath!);
      expect(existsSync(absScript), `File ${absScript} should exist`).toBe(true);
      expect(statSync(absScript).size).toBeGreaterThan(0);
    }
  });

  it('contains dd1 outputs for both designer and reviewer arms', () => {
    expect(manifest.dd1).toBeDefined();
    expect(manifest.dd1.designer).toBeDefined();
    expect(manifest.dd1.reviewer).toBeDefined();

    for (const arm of ['designer', 'reviewer'] as const) {
      const armEntries = manifest.dd1[arm] as Record<string, BaselineEntry>;
      expect(Object.keys(armEntries).length).toBe(6);
      for (const [, entry] of Object.entries(armEntries)) {
        expect(entry.source).toBeDefined();
        expect(entry.scriptPath).toBeDefined();
        const absScript = join(process.cwd(), entry.scriptPath!);
        expect(existsSync(absScript), `File ${absScript} should exist`).toBe(true);
        expect(statSync(absScript).size).toBeGreaterThan(0);
      }
    }
  });

  it('contains argon and cc dock reference STLs', () => {
    expect(manifest.references).toBeDefined();
    const refs = manifest.references as Record<string, BaselineEntry>;
    const refKeys = ['cc_dock', 'cc_dock_open', 'argon_dock', 'argon_dock_open'];
    for (const k of refKeys) {
      const entry = refs[k];
      expect(entry, `Reference ${k} should exist`).toBeDefined();
      expect(entry.source).toBeDefined();
      expect(entry.stlPath).toBeDefined();

      const absStl = join(process.cwd(), entry.stlPath!);
      expect(existsSync(absStl), `STL file ${absStl} should exist`).toBe(true);
      expect(statSync(absStl).size).toBeGreaterThan(100_000);
    }

    // Default mapping for user_dock / dock
    const userDock = manifest['user_dock'] as BaselineEntry | undefined;
    const dock = manifest['dock'] as BaselineEntry | undefined;
    expect(userDock?.stlPath).toBeDefined();
    expect(dock?.stlPath).toBeDefined();
  });
});
