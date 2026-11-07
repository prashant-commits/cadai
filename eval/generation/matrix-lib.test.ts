import { describe, it, expect } from 'vitest';
import { childArgs } from './matrix';
import {
  latestRows, parseJsonl, pendingRuns, percentile, planRuns, renderReport, validateCells, type Cell, type MatrixRow,
} from './matrix-lib';
import type { GenerationMetrics } from './metrics';

const cells: Cell[] = [
  { name: 'openscad-off', kernel: 'openscad', thinking: 'off', attempts: 3 },
  { name: 'brep-adaptive', kernel: 'brep', thinking: 'adaptive', effort: 'low', attempts: 3 },
];
const prompts = [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }];

function m(over: Partial<GenerationMetrics> = {}): GenerationMetrics {
  return {
    id: 'a', model: 'x', kernel: 'openscad', specOk: true, composed: true, compileOk: true, floorOk: true, floatingCount: 0,
    localFrameOk: true, extentsOk: true, shellsOk: true, errorKinds: [], attempts: 1, wallMs: 10_000, paramCount: 4, liveParams: 4,
    deadParams: 0, variantCount: 0, variantsValidated: 0, reviewRounds: 0, chosenValidated: null, visualMatch: null, visualFindings: null,
    workable: true, failureStage: 'none', costUsd: 0.02, ...over,
  };
}
const row = (cell: string, promptId: string, sample: number, metrics: GenerationMetrics | null, crashed?: string): MatrixRow =>
  ({ cell, promptId, sample, metrics, crashed, at: 't' });

describe('plan and resume', () => {
  it('plans cells x prompts x samples', () => expect(planRuns(cells, prompts, 2)).toHaveLength(8));

  it('skips finished runs and retries crashed ones', () => {
    const plan = planRuns(cells, prompts, 1);
    const existing = [
      row('openscad-off', 'a', 1, m()),
      row('brep-adaptive', 'a', 1, null, 'exit 1: 429'),
      row('openscad-off', 'b', 1, m({ workable: false })),
    ];
    const todo = pendingRuns(plan, existing).map((r) => `${r.cell.name}/${r.promptId}`);
    expect(todo).toEqual(['brep-adaptive/a', 'brep-adaptive/b']);
  });

  it('resumes from a jsonl with a torn last line', () => {
    const text = JSON.stringify(row('openscad-off', 'a', 1, m())) + '\n{"cell":"brep-adap';
    expect(parseJsonl(text)).toHaveLength(1);
  });

  it('a retried crash replaces its earlier row', () => {
    const rows = latestRows([row('c', 'a', 1, null, 'boom'), row('c', 'a', 1, m())]);
    expect(rows).toHaveLength(1);
    expect(rows[0].metrics).not.toBeNull();
  });

  it('rejects bad cell files', () => {
    expect(() => validateCells([])).toThrow();
    expect(() => validateCells([{ name: 'x', kernel: 'cad' }])).toThrow(/kernel/);
    expect(() => validateCells([{ name: 'x', kernel: 'brep' }, { name: 'x', kernel: 'brep' }])).toThrow(/duplicate/);
  });
});

describe('child flags', () => {
  it('passes the cell onto run.ts flags', () => {
    const [run] = planRuns([cells[1]], prompts, 1);
    const args = childArgs(run, '/out', '/out/row.json', 't').join(' ');
    expect(args).toContain('--kernel brep');
    expect(args).toContain('--thinking adaptive');
    expect(args).toContain('--effort low');
    expect(args).toContain('--attempts 3');
    expect(args).toContain('--model claude-haiku-5.5');
    expect(args).toContain('--only a');
    expect(args).toContain('--no-langfuse');
  });
});

describe('percentile', () => {
  it('is nearest-rank', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([], 90)).toBeNull();
  });
});

describe('renderReport', () => {
  const rows = [
    row('openscad-off', 'a', 1, m({ wallMs: 10_000 })),
    row('openscad-off', 'b', 1, m({ workable: false, failureStage: 'params', failureDetail: '1/4 parameters change the model', liveParams: 1 })),
    row('brep-adaptive', 'a', 1, m({ kernel: 'brep', brepOk: true, stepOk: true, wallMs: 30_000, costUsd: 0.04 })),
    row('brep-adaptive', 'b', 1, null, 'exit 1: ANTHROPIC 429'),
  ];
  const md = renderReport('t', rows, ['openscad-off', 'brep-adaptive']);

  it('has one column per cell with the headline rows', () => {
    expect(md).toContain('| metric | openscad-off | brep-adaptive |');
    expect(md).toContain('| **workable** | 1/2 (50%) | 1/2 (50%) |');
    expect(md).toContain('| stepOk (B-rep) | - | 1/1 (100%) |');
    expect(md).toContain('| live params (>= 80% per run) | 5/8 (63%) | 4/4 (100%) |');
    expect(md).toContain('| median wall | 10.0 s | 30.0 s |');
    expect(md).toContain('| mean cost / run | $0.0200 | $0.0400 |');
  });

  it('has the per-prompt grid', () => {
    expect(md).toContain('| a | 1/1 | 1/1 |');
    expect(md).toContain('| b | 0/1 | 0/1 |');
  });

  it('lists every failed run, crashes included', () => {
    expect(md).toContain('## Failed runs (2)');
    expect(md).toContain('| openscad-off | b | 1 | params | 1/4 parameters change the model |');
    expect(md).toContain('| brep-adaptive | b | 1 | crash | exit 1: ANTHROPIC 429 |');
  });
});
