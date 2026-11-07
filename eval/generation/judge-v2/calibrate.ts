import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { buildEvidence, type EvidencePack } from './evidence';
import { getRequirements, type RequirementsChecklist } from './requirements';
import { judgeRubric, type RubricJudgeResult } from './rubric';
import { comparePair, type PairwiseComparisonResult } from './pairwise';

export interface DesignInput {
  label: string;
  name: string;
  scriptPath?: string;
  stlPath?: string;
  notesPath?: string;
}

export interface CalibrationSummaryRow {
  label: string;
  name: string;
  overallScore: number;
  coveragePercent: number;
  coverageFraction: string;
  criteria: {
    requirementsCoverage: number;
    layoutAndClearances: number;
    functionAndMotion: number;
    accessibility: number;
    manufacturabilityAndRobustness: number;
    parametricQuality: number;
    formAndAesthetics: number;
  };
  findingsCount: number;
  stabilityMarginMm: number;
  costUsd: number;
}

export function parseHumanRanking(rankingStr: string): Map<string, number> {
  const parts = rankingStr.split('>').map((s) => s.trim().toUpperCase());
  const rankMap = new Map<string, number>();
  parts.forEach((label, idx) => {
    rankMap.set(label, idx + 1);
  });
  return rankMap;
}

export function computeKendallTau(
  humanRanks: Map<string, number>,
  predictedScores: Map<string, number>
): { tau: number; concordant: number; discordant: number; ties: number; totalPairs: number } {
  const labels = Array.from(humanRanks.keys());
  let concordant = 0;
  let discordant = 0;
  let ties = 0;
  let totalPairs = 0;

  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i];
      const b = labels[j];
      const humanDiff = (humanRanks.get(a) ?? 0) - (humanRanks.get(b) ?? 0);
      const predDiff = (predictedScores.get(b) ?? 0) - (predictedScores.get(a) ?? 0); // higher score is better (rank 1)
      totalPairs++;

      if (predDiff === 0 || humanDiff === 0) {
        ties++;
      } else if ((humanDiff > 0 && predDiff > 0) || (humanDiff < 0 && predDiff < 0)) {
        concordant++;
      } else {
        discordant++;
      }
    }
  }

  const tau = totalPairs > 0 ? (concordant - discordant) / totalPairs : 0;
  return { tau: Math.round(tau * 1000) / 1000, concordant, discordant, ties, totalPairs };
}

async function saveRenderImages(label: string, evidence: EvidencePack, outBaseDir: string): Promise<void> {
  const labelDir = path.join(outBaseDir, label);
  await fs.mkdir(labelDir, { recursive: true });

  const savePng = async (filename: string, dataUrl: string) => {
    const prefix = 'data:image/png;base64,';
    if (!dataUrl.startsWith(prefix)) return;
    const base64 = dataUrl.slice(prefix.length);
    const buf = Buffer.from(base64, 'base64');
    await fs.writeFile(path.join(labelDir, filename), buf);
  };

  for (const v of evidence.closedViews) {
    await savePng(`closed_${v.name}.png`, v.dataUrl);
  }

  for (const v of evidence.lidHiddenViews) {
    await savePng(`lid_hidden_${v.name}.png`, v.dataUrl);
  }

  for (const pose of evidence.poseRenders) {
    const safePose = pose.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    for (const v of pose.views) {
      await savePng(`pose_${safePose}_${v.name}.png`, v.dataUrl);
    }
  }
}

export async function runCalibration(opts: {
  human?: string;
  model?: string;
  baseDir?: string;
}): Promise<{
  rows: CalibrationSummaryRow[];
  pairwise: Record<string, PairwiseComparisonResult>;
  kendallTau: number;
  totalCostUsd: number;
  reportMarkdown: string;
}> {
  const baseDir = opts.baseDir ?? process.cwd();
  const humanRankingStr = opts.human ?? 'D>B>A>C';
  const humanRanks = parseHumanRanking(humanRankingStr);
  const model = opts.model ?? process.env.CADAI_JUDGE_MODEL ?? 'claude-sonnet-5.5';

  const dockPromptPath = path.resolve(baseDir, '.cadai/tasks/dock-prompt.txt');
  const request = await fs.readFile(dockPromptPath, 'utf-8');

  // Load requirements checklist
  const checklist: RequirementsChecklist = await getRequirements('dock', request, model);

  const designsDir = path.resolve(baseDir, '.cadai/tasks/designs');
  const evidenceOutDir = path.resolve(baseDir, '.cadai/tasks/evidence');
  await fs.mkdir(evidenceOutDir, { recursive: true });

  const designs: DesignInput[] = [
    {
      label: 'A',
      name: 'ab1_dock',
      scriptPath: path.join(designsDir, 'ab1_dock.py'),
    },
    {
      label: 'B',
      name: 'cc_dock',
      scriptPath: path.join(designsDir, 'cc_dock.py'),
    },
    {
      label: 'C',
      name: 'ours_dock',
      stlPath: path.join(designsDir, 'ours_dock.stl'),
    },
    {
      label: 'D',
      name: 'argon_dock',
      scriptPath: path.join(designsDir, 'argon_dock.py'),
      notesPath: path.join(designsDir, 'argon_notes.md'),
    },
  ];

  console.log(`=== Calibrating Product Engineering Judge v2 on ${designs.length} designs ===`);
  console.log(`Judge Model: ${model}`);
  console.log(`Human Target Ranking: ${humanRankingStr}\n`);

  let totalCostUsd = 0;
  const evidenceMap = new Map<string, EvidencePack>();

  // 1. Build evidence packs
  console.log('--- Step 1: Building Evidence Packs & Renders ---');
  for (const d of designs) {
    console.log(`Building evidence for Design ${d.label} (${d.name})...`);
    let script: string | undefined;
    let stl: string | undefined;
    let notes: string | undefined;

    if (d.scriptPath && existsSync(d.scriptPath)) {
      script = await fs.readFile(d.scriptPath, 'utf-8');
    }
    if (d.stlPath && existsSync(d.stlPath)) {
      stl = await fs.readFile(d.stlPath, 'utf-8');
    }
    if (d.notesPath && existsSync(d.notesPath)) {
      notes = await fs.readFile(d.notesPath, 'utf-8');
    }

    const ev = await buildEvidence({ script, stl, notes });
    evidenceMap.set(d.label, ev);
    await saveRenderImages(d.label, ev, evidenceOutDir);
    console.log(`  ✓ Design ${d.label}: bbox span = ${ev.facts.bbox.span.map((n) => n.toFixed(1)).join('x')} mm, solids = ${ev.facts.solids}, stability margin = ${ev.facts.stability.marginMm} mm`);
  }

  // 2. Run Rubric Judge on each design (4 calls)
  console.log('\n--- Step 2: Running Rubric Judge on Each Design ---');
  const rubricResults = new Map<string, RubricJudgeResult>();
  const rows: CalibrationSummaryRow[] = [];
  const predictedScores = new Map<string, number>();

  for (const d of designs) {
    const ev = evidenceMap.get(d.label)!;
    console.log(`Judging Design ${d.label} (${d.name})...`);
    const res = await judgeRubric({
      request,
      checklist,
      evidence: ev,
      notes: ev.notes,
      model,
    });
    rubricResults.set(d.label, res);
    predictedScores.set(d.label, res.overallScore);
    const cost = res.costUsd ?? 0;
    totalCostUsd += cost;

    const row: CalibrationSummaryRow = {
      label: d.label,
      name: d.name,
      overallScore: res.overallScore,
      coveragePercent: res.coverage.percent,
      coverageFraction: `${res.coverage.met}/${res.coverage.total}`,
      criteria: {
        requirementsCoverage: res.verdict.criteria.requirementsCoverage.score,
        layoutAndClearances: res.verdict.criteria.layoutAndClearances.score,
        functionAndMotion: res.verdict.criteria.functionAndMotion.score,
        accessibility: res.verdict.criteria.accessibility.score,
        manufacturabilityAndRobustness: res.verdict.criteria.manufacturabilityAndRobustness.score,
        parametricQuality: res.verdict.criteria.parametricQuality.score,
        formAndAesthetics: res.verdict.criteria.formAndAesthetics.score,
      },
      findingsCount: res.verdict.findings.length,
      stabilityMarginMm: ev.facts.stability.marginMm,
      costUsd: cost,
    };
    rows.push(row);
    console.log(`  ✓ Design ${d.label}: Score = ${res.overallScore}/100, Coverage = ${res.coverage.percent}%, Cost = $${cost.toFixed(4)}`);
  }

  // 3. Run Pairwise Comparisons on all 6 pairs (12 calls)
  console.log('\n--- Step 3: Running Pairwise Comparisons on All 6 Pairs (Both Orders) ---');
  const pairwiseResults: Record<string, PairwiseComparisonResult> = {};
  const copelandPoints: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };

  const pairs: Array<[DesignInput, DesignInput]> = [];
  for (let i = 0; i < designs.length; i++) {
    for (let j = i + 1; j < designs.length; j++) {
      pairs.push([designs[i], designs[j]]);
    }
  }

  for (const [dA, dB] of pairs) {
    const pairKey = `${dA.label}_vs_${dB.label}`;
    console.log(`Comparing Pair (${dA.label} vs ${dB.label})...`);
    const evA = evidenceMap.get(dA.label)!;
    const evB = evidenceMap.get(dB.label)!;

    const pw = await comparePair({
      request,
      checklist,
      evA,
      evB,
      labelA: `Design ${dA.label} (${dA.name})`,
      labelB: `Design ${dB.label} (${dB.name})`,
      model,
    });

    pairwiseResults[pairKey] = pw;
    const cost = pw.costUsd ?? 0;
    totalCostUsd += cost;

    if (pw.winner === 'A') {
      copelandPoints[dA.label] += 1;
    } else if (pw.winner === 'B') {
      copelandPoints[dB.label] += 1;
    } else {
      copelandPoints[dA.label] += 0.5;
      copelandPoints[dB.label] += 0.5;
    }
    console.log(`  ✓ ${pairKey}: Winner = ${pw.winner} (Order agreement: ${pw.agreed ? 'YES' : 'NO'}), Cost = $${cost.toFixed(4)}`);
  }

  // 4. Compute Kendall Tau
  const tauInfo = computeKendallTau(humanRanks, predictedScores);
  console.log(`\nKendall Tau vs Human [${humanRankingStr}]: ${tauInfo.tau} (Concordant: ${tauInfo.concordant}, Discordant: ${tauInfo.discordant}, Ties: ${tauInfo.ties})`);
  console.log(`Total Calibration Cost: $${totalCostUsd.toFixed(4)} USD\n`);

  // 5. Generate Markdown Report
  const reportLines: string[] = [
    '# Product-Engineering Judge v2 Calibration Report',
    '',
    `**Evaluated**: ${new Date().toISOString()}`,
    `**Model**: \`${model}\``,
    `**Total Judge Cost**: \`$${totalCostUsd.toFixed(4)}\` USD`,
    `**Human Benchmark Ranking**: \`${humanRankingStr}\``,
    `**Kendall's Tau**: \`${tauInfo.tau}\` (${tauInfo.concordant} concordant, ${tauInfo.discordant} discordant, ${tauInfo.ties} ties)`,
    '',
    '## Rubric Score Summary',
    '',
    '| Design | Name | Overall (0-100) | Req Coverage (25) | Layout & Clearance (12) | Function & Motion (18) | Accessibility (8) | Manufacturing & Stability (12) | Parametric (10) | Form & Aesthetics (15) | Stability Margin | Findings | Cost |',
    '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
  ];

  // Sort rows by overall score descending
  const sortedRows = [...rows].sort((a, b) => b.overallScore - a.overallScore);
  for (const r of sortedRows) {
    const c = r.criteria;
    reportLines.push(
      `| **${r.label}** | ${r.name} | **${r.overallScore}** | ${r.coveragePercent}% (${r.coverageFraction}) | ${c.layoutAndClearances}/5 | ${c.functionAndMotion}/5 | ${c.accessibility}/5 | ${c.manufacturabilityAndRobustness}/5 | ${c.parametricQuality}/5 | ${c.formAndAesthetics}/5 | ${r.stabilityMarginMm > 0 ? '+' : ''}${r.stabilityMarginMm} mm | ${r.findingsCount} | $${r.costUsd.toFixed(4)} |`
    );
  }

  reportLines.push('');
  reportLines.push('## Pairwise Tournament Standings');
  reportLines.push('');
  reportLines.push('| Design | Copeland Score | Win / Tie / Loss |');
  reportLines.push('| :---: | :---: | :---: |');
  const sortedCopeland = Object.entries(copelandPoints).sort((a, b) => b[1] - a[1]);
  for (const [lbl, pts] of sortedCopeland) {
    reportLines.push(`| **${lbl}** | **${pts}** | ${pts} pts |`);
  }

  reportLines.push('');
  reportLines.push('## Pairwise Match Details (Both Orders Swapped)');
  reportLines.push('');
  reportLines.push('| Pair | Order 1 (A->B) | Order 2 (B->A) | Consensus Winner | Order Agreement |');
  reportLines.push('| :---: | :---: | :---: | :---: | :---: |');

  for (const [pairKey, pw] of Object.entries(pairwiseResults)) {
    const [pA, pB] = pairKey.split('_vs_');
    const winnerName = pw.winner === 'A' ? pA : pw.winner === 'B' ? pB : 'tie';
    reportLines.push(`| **${pA} vs ${pB}** | ${pw.order1.winner === 'first' ? pA : pw.order1.winner === 'second' ? pB : 'tie'} | ${pw.order2.winner === 'first' ? pB : pw.order2.winner === 'second' ? pA : 'tie'} | **${winnerName}** | ${pw.agreed ? 'Agreed' : 'Disagreed (Tie)'} |`);
  }

  reportLines.push('');
  reportLines.push('## Detailed Findings and Justifications');
  for (const d of designs) {
    const r = rubricResults.get(d.label)!;
    reportLines.push('');
    reportLines.push(`### Design ${d.label}: ${d.name} (${r.overallScore}/100)`);
    reportLines.push(`**Verdict Summary**: ${r.verdict.summary}`);
    reportLines.push('');
    reportLines.push('**Criterion Justifications**:');
    reportLines.push(`- Requirements Coverage (${r.verdict.criteria.requirementsCoverage.score}/5): ${r.verdict.criteria.requirementsCoverage.justification}`);
    reportLines.push(`- Layout & Clearances (${r.verdict.criteria.layoutAndClearances.score}/5): ${r.verdict.criteria.layoutAndClearances.justification}`);
    reportLines.push(`- Function & Motion (${r.verdict.criteria.functionAndMotion.score}/5): ${r.verdict.criteria.functionAndMotion.justification}`);
    reportLines.push(`- Accessibility (${r.verdict.criteria.accessibility.score}/5): ${r.verdict.criteria.accessibility.justification}`);
    reportLines.push(`- Manufacturability & Robustness (${r.verdict.criteria.manufacturabilityAndRobustness.score}/5): ${r.verdict.criteria.manufacturabilityAndRobustness.justification}`);
    reportLines.push(`- Parametric Quality (${r.verdict.criteria.parametricQuality.score}/5): ${r.verdict.criteria.parametricQuality.justification}`);
    reportLines.push(`- Form & Aesthetics (${r.verdict.criteria.formAndAesthetics.score}/5): ${r.verdict.criteria.formAndAesthetics.justification}`);

    if (r.verdict.findings.length > 0) {
      reportLines.push('\n**Findings**:');
      for (const f of r.verdict.findings) {
        reportLines.push(`- [${f.severity.toUpperCase()}] ${f.issue}`);
      }
    }
  }

  const reportMarkdown = reportLines.join('\n');
  const reportPath = path.resolve(baseDir, '.cadai/tasks/calibration.md');
  await fs.writeFile(reportPath, reportMarkdown, 'utf-8');
  console.log(`Wrote calibration report to ${reportPath}`);

  return {
    rows,
    pairwise: pairwiseResults,
    kendallTau: tauInfo.tau,
    totalCostUsd,
    reportMarkdown,
  };
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('calibrate.ts')) {
  let human = 'D>B>A>C';
  let model: string | undefined;

  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--human') {
      human = process.argv[++i];
    } else if (process.argv[i] === '--model') {
      model = process.argv[++i];
    }
  }

  runCalibration({ human, model })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Calibration failed:', err);
      process.exit(1);
    });
}
