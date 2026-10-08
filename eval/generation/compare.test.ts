import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildReport, loadArm, parseArmArgs, type CompareRow } from './compare';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<CompareRow> & Pick<CompareRow, 'id'>): CompareRow {
  return {
    compileOk: true,
    extentsOk: true,
    shellsOk: true,
    floorOk: true,
    visualMatch: true,
    errorKinds: [],
    wallMs: 0,
    reviewRounds: 0,
    ...over,
  };
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadai-compare-'));
  dirs.push(dir);
  return dir;
}

describe('eval compare', () => {
  it('parses several globs on one arm', () => {
    const arms = parseArmArgs([
      '--arm',
      'A=eval/results/baseline-A-*.jsonl,eval/results/baseline-A2-*.jsonl',
      '--arm',
      'B=eval/results/b.jsonl',
    ]);
    expect(arms).toEqual([
      { label: 'A', patterns: ['eval/results/baseline-A-*.jsonl', 'eval/results/baseline-A2-*.jsonl'] },
      { label: 'B', patterns: ['eval/results/b.jsonl'] },
    ]);
  });

  it('merges two fixture arms and prints the comparison', () => {
    const dir = tempDir();
    const a1 = [
      row({ id: 'p1', wallMs: 10000, reviewRounds: 1 }),
      row({ id: 'p2', shellsOk: false, visualMatch: null, errorKinds: ['shells'], wallMs: 30000, reviewRounds: 3 }),
    ];
    const a2 = [
      row({ id: 'p2', floorOk: false, errorKinds: ['floor'], wallMs: 20000, reviewRounds: 2 }),
      row({ id: 'p3', compileOk: false, extentsOk: null, shellsOk: null, floorOk: null, visualMatch: null, wallMs: 0, reviewRounds: 0 }),
    ];
    fs.writeFileSync(path.join(dir, 'arm-a-1.jsonl'), a1.map((item) => JSON.stringify(item)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'arm-a-2.jsonl'), a2.map((item) => JSON.stringify(item)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'arm-b.json'), JSON.stringify({
      rows: [
        row({ id: 'p1', extentsOk: false, visualMatch: false, errorKinds: ['extents'], wallMs: 5000, reviewRounds: 2 }),
        row({ id: 'p2', wallMs: 15000, reviewRounds: 1 }),
      ],
    }));

    const arms = [
      { label: 'A', rows: loadArm([path.join(dir, 'arm-a-*.jsonl')]) },
      { label: 'B', rows: loadArm([path.join(dir, 'arm-b.json')]) },
    ];
    expect(arms[0].rows.map((item) => item.id)).toEqual(['p1', 'p2', 'p3']);
    expect(arms[0].rows.find((item) => item.id === 'p2')?.errorKinds).toEqual(['floor']);

    const report = buildReport(arms);
    expect(report).toContain('| arm | n | error-free | compileOk | extentsOk | shellsOk | floorOk | visualMatch | mean wall s | mean review rounds |');
    expect(report).toContain('| A | 3 | 1/3 | 2/3 | 2/2 | 2/2 | 1/2 | 2/2 | 10.0 | 1.0 |');
    expect(report).toContain('| B | 2 | 1/2 | 2/2 | 1/2 | 2/2 | 2/2 | 1/2 | 10.0 | 1.5 |');
    expect(report).toContain('| arm | extents | floor |');
    expect(report).toContain('| A | 0 | 1 |');
    expect(report).toContain('| B | 1 | 0 |');
    expect(report).toContain('| p1 | ok | extents |');
    expect(report).toContain('| p2 | floor | ok |');
    expect(report).toContain('| p3 | compile | - |');
  });

  it('rejects an arm glob that matches nothing', () => {
    const dir = tempDir();
    expect(() => loadArm([path.join(dir, 'missing-*.jsonl')])).toThrow(/no files matched/);
  });
});
