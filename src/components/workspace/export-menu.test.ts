import { describe, it, expect } from 'vitest';
import {
  exportFileName,
  EXPORT_FORMATS,
  exportOptions,
  viewedExportVersion,
  type ExportOptionsState,
} from './export-menu';

describe('export menu and file naming', () => {
  it('exportFileName("Motor mount", 3, "step") is "motor-mount-v3.step"', () => {
    expect(exportFileName('Motor mount', 3, 'step')).toBe('motor-mount-v3.step');
    expect(exportFileName('Motor Mount', 3, 'step')).toBe('motor-mount-v3.step');
  });

  it('exportFileName with a null version ends in -draft', () => {
    expect(exportFileName('Motor mount', null, 'stl')).toBe('motor-mount-draft.stl');
    // Symbols fallback to 'design-draft'
    expect(exportFileName('!@#$%', null, 'stl')).toBe('design-draft.stl');
    expect(exportFileName('', null, '3mf')).toBe('design-draft.3mf');
    expect(exportFileName('---', null, 'step')).toBe('design-draft.step');
    expect(exportFileName('Bracket v2', null, 'step')).toBe('bracket-v2-draft.step');
  });

  it('the export menu offers STL, STEP and 3MF', () => {
    expect(EXPORT_FORMATS.map((f) => ({ id: f.id, ext: f.ext }))).toEqual([
      { id: 'stl', ext: 'stl' },
      { id: 'step', ext: 'step' },
      { id: '3mf', ext: '3mf' },
    ]);

    // When content is missing, options are disabled
    const emptyState: ExportOptionsState = {
      stlContent: null,
      geometry: null,
      step: null,
      threads: [],
      activeThreadId: null,
      viewingVersion: null,
      code: '',
    };
    const optsEmpty = exportOptions(emptyState);
    expect(optsEmpty).toHaveLength(3);
    expect(optsEmpty.map((o) => o.ext)).toEqual(['stl', 'step', '3mf']);
    expect(optsEmpty.find((o) => o.ext === 'stl')?.disabled).toBe(true);
    expect(optsEmpty.find((o) => o.ext === 'step')?.disabled).toBe(true);
    expect(optsEmpty.find((o) => o.ext === '3mf')?.disabled).toBe(true);

    // STL enabled when stlContent exists
    const withStl = exportOptions({ ...emptyState, stlContent: 'solid test' });
    expect(withStl.find((o) => o.ext === 'stl')?.disabled).toBe(false);
    expect(withStl.find((o) => o.ext === 'step')?.disabled).toBe(true);
    expect(withStl.find((o) => o.ext === '3mf')?.disabled).toBe(true);

    // 3MF enabled when geometry exists
    const with3mf = exportOptions({ ...emptyState, geometry: {} });
    expect(with3mf.find((o) => o.ext === '3mf')?.disabled).toBe(false);

    // STEP enabled when store step exists
    const withStep = exportOptions({ ...emptyState, step: 'base64step' });
    expect(withStep.find((o) => o.ext === 'step')?.disabled).toBe(false);

    // STEP enabled when viewed version has step artifact and code matches
    const withVersionStep = exportOptions({
      ...emptyState,
      activeThreadId: 't1',
      viewingVersion: 1,
      code: 'box = Box(10, 10, 10)',
      threads: [
        {
          id: 't1',
          code: 'box = Box(10, 10, 10)',
          versions: [
            {
              version: 1,
              step: 'artifact-p1',
              body: 'box = Box(10, 10, 10)',
            },
          ],
        },
      ],
    });
    expect(withVersionStep.find((o) => o.ext === 'step')?.disabled).toBe(false);

    // viewedExportVersion returns { version, isDraft }
    expect(viewedExportVersion(emptyState)).toEqual({ version: null, isDraft: true });
    expect(
      viewedExportVersion({
        threads: [{ id: 't1', code: 'box', versions: [{ version: 1, body: 'box' }] }],
        activeThreadId: 't1',
        viewingVersion: 1,
        code: 'box-edited',
      })
    ).toEqual({ version: null, isDraft: true });
    expect(
      viewedExportVersion({
        threads: [{ id: 't1', code: 'box', versions: [{ version: 1, body: 'box' }] }],
        activeThreadId: 't1',
        viewingVersion: 1,
        code: 'box',
      })
    ).toEqual({ version: 1, isDraft: false });
  });
});
