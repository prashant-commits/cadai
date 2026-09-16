/**
 * Runs every mutation against every fixture and prints the blind-spot map.
 *
 *   npx tsx eval/placement/run.ts
 *
 * No model calls: the whole pipeline below the Architect is deterministic, so
 * this is free to run as often as the audits change.
 */
import {
  auditFixture,
  runMutations,
  setRotation,
  shiftPosition,
  wrapModuleBody,
  type Fixture,
  type Mutation,
  type Outcome,
  type RunResult,
} from './harness';
import { angledPlates, boltedBracket, stackedBox } from './fixtures';

/** Mutations that apply to any fixture's named component. */
function transformMutations(part: string): Mutation[] {
  return [
    shiftPosition(part, 0, 10),
    shiftPosition(part, 1, 10),
    shiftPosition(part, 2, 10),
    {
      name: `architect: ${part}.localExtents scaled 2x`,
      tier: 'architect',
      breaks: 'the spec claims the part is twice its real size',
      apply: (f: Fixture) => {
        const c = f.spec.components!.find((x) => x.name === part)!;
        c.localExtents = (c.localExtents as number[]).map((n) => n * 2);
        return f;
      },
    },
    wrapModuleBody(part, 'scale([2, 2, 2])', `${part} scaled 2x in the script`,
      'the drafter built the part at twice the spec size'),
    wrapModuleBody(part, 'scale([1, 1, 2])', `${part} scaled 2x in z only`,
      'the drafter stretched one axis'),
    wrapModuleBody(part, 'mirror([1, 0, 0])', `${part} mirrored in x`,
      'the part is handed the wrong way round'),
    wrapModuleBody(part, 'translate([5, 0, 0])', `${part} offset 5 mm inside its module`,
      'the module is authored off its local origin'),
    wrapModuleBody(part, 'rotate([0, 0, 90])', `${part} rotated 90 deg in the script`,
      'the drafter rotated the part into a different pose'),
  ];
}

const SUITES: { fixture: Fixture; mutations: Mutation[] }[] = [
  {
    fixture: stackedBox,
    mutations: [
      ...transformMutations('box_lid'),
      shiftPosition('box_lid', 2, -10),
      setRotation('box_lid', [180, 0, 0], 'the lid is flipped upside down'),
      setRotation('box_lid', [0, 0, 90], 'the lid is turned 90 deg and overhangs the box'),
    ],
  },
  {
    fixture: angledPlates,
    mutations: [
      ...transformMutations('angled_plate'),
      setRotation('angled_plate', [120, 0, 0], 'the joint is the opposite angle (60 deg interior, not 120)'),
      setRotation('angled_plate', [45, 0, 0], 'the joint is 45 deg, not 60'),
      setRotation('angled_plate', [0, 60, 0], 'the plate is tilted about the wrong axis'),
      {
        name: 'architect: angled_plate.rotation removed',
        tier: 'architect',
        breaks: 'the second plate is flat, not angled at all',
        apply: (f: Fixture) => {
          delete f.spec.components!.find((x) => x.name === 'angled_plate')!.rotation;
          return f;
        },
      },
    ],
  },
  {
    fixture: boltedBracket,
    mutations: [
      ...transformMutations('mount_plate'),
      {
        name: 'drafter: bolt hole moved to the far edge',
        tier: 'drafter',
        breaks: 'the hole is at the opposite end from where the spec put it',
        apply: (f: Fixture) => {
          f.code = f.code.replace('translate([8, plate_d / 2', 'translate([32, plate_d / 2');
          return f;
        },
      },
      {
        name: 'drafter: bolt hole enlarged to 8 mm',
        tier: 'drafter',
        breaks: 'an M3 clearance hole became an 8 mm hole',
        apply: (f: Fixture) => {
          f.code = f.code.replace('d = 3.4', 'd = 8');
          return f;
        },
      },
      {
        name: 'drafter: bolt hole deleted',
        tier: 'drafter',
        breaks: 'the feature the user asked for is simply absent',
        apply: (f: Fixture) => {
          f.code = f.code.replace(/^.*cylinder\(d = 3\.4.*$\n/m, '');
          return f;
        },
      },
    ],
  },
];

function table(rows: RunResult[]): string {
  const head = ['mutation', 'tier', 'outcome', 'by', 'bbox', 'shells'];
  const body = rows.map((r) => [
    r.mutation,
    r.tier,
    r.outcome,
    r.kinds.join(',') || '-',
    r.bbox,
    String(r.shells ?? '?'),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

(async () => {
  const all: RunResult[] = [];
  for (const { fixture, mutations } of SUITES) {
    const baseline = await auditFixture(fixture);
    const baseErrors = baseline.violations.filter((v) => v.severity === 'error');
    console.log(`\n### ${fixture.name} - "${fixture.intent}"`);
    console.log(`baseline: compiled=${baseline.compiled} bbox=${baseline.bbox} shells=${baseline.shells} errors=${baseErrors.length}`);
    if (baseErrors.length > 0) {
      console.log('  !! fixture is not clean; every result below is suspect:');
      for (const v of baseErrors) console.log(`     [${v.kind}] ${v.message}`);
    }
    const rows = await runMutations(fixture, mutations, baseline.signature);
    console.log(table(rows));
    all.push(...rows);
  }

  const count = (tier: string, outcome: Outcome) =>
    all.filter((r) => r.tier === tier && r.outcome === outcome).length;
  const summary = (tier: string) => {
    const total = all.filter((r) => r.tier === tier).length;
    return `caught ${count(tier, 'caught')}/${total}` +
      `, neutralised ${count(tier, 'neutralised')}` +
      `, MISSED ${count(tier, 'missed')}`;
  };
  console.log('\n### coverage');
  console.log(`drafter fidelity  (script disagrees with spec):    ${summary('drafter')}`);
  console.log(`architect intent  (spec disagrees with request):   ${summary('architect')}`);

  const missed = all.filter((x) => x.outcome === 'missed');
  console.log(`\n### ${missed.length} blind spots - a different solid compiled and every check passed`);
  for (const r of missed) {
    console.log(`  [${r.tier}] ${r.mutation}`);
    console.log(`          user sees: ${r.breaks}`);
  }
})();
