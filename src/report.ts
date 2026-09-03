import { VERDICT_ORDER } from './score.js';
import type { Scored, Verdict } from './types.js';

export type Summary = {
  files: number;
  lines: number;
  tests: number;
  expects: number;
  weakExpects: number;
  mocks: number;
  moduleMocks: number;
  verdicts: Record<Verdict, number>;
  median: number;
  p90: number;
  sharedHarnessLines: number;
  sharedHarnessFiles: number;
};

export function summarize(rows: Scored[]): Summary {
  const verdicts = Object.fromEntries(VERDICT_ORDER.map((v) => [v, 0])) as Record<Verdict, number>;
  const summary: Summary = {
    files: rows.length,
    lines: 0,
    tests: 0,
    expects: 0,
    weakExpects: 0,
    mocks: 0,
    moduleMocks: 0,
    verdicts,
    median: 0,
    p90: 0,
    sharedHarnessLines: 0,
    sharedHarnessFiles: 0,
  };
  for (const row of rows) {
    summary.lines += row.lines;
    summary.tests += row.tests;
    summary.expects += row.expects;
    summary.weakExpects += row.weakExpects;
    summary.mocks += row.mocks;
    summary.moduleMocks += row.moduleMocks;
    verdicts[row.verdict] += 1;
    if (row.sharedHarnessFiles >= 3 && row.sharedHarnessLines >= 40) {
      summary.sharedHarnessLines += row.sharedHarnessLines;
      summary.sharedHarnessFiles += 1;
    }
  }
  const scores = rows.map((r) => r.score).sort((a, b) => a - b);
  const at = (q: number): number =>
    scores[Math.min(scores.length - 1, Math.floor(q * scores.length))] ?? 0;
  summary.median = at(0.5);
  summary.p90 = at(0.9);
  return summary;
}

export function summaryLines(summary: Summary): string[] {
  const weakPct = Math.round((summary.weakExpects / Math.max(1, summary.expects)) * 100);
  return [
    `${summary.files} test files · ${summary.lines} lines · ${summary.tests} tests · ${summary.expects} expects (${weakPct}% weak) · ${summary.mocks} mocks (${summary.moduleMocks} module mocks)`,
    `score median ${summary.median} · p90 ${summary.p90}` +
      (summary.sharedHarnessFiles
        ? ` · ${summary.sharedHarnessLines} lines of setup duplicated across ${summary.sharedHarnessFiles} files`
        : ''),
    VERDICT_ORDER.filter((v) => summary.verdicts[v] > 0)
      .map((v) => `${v}: ${summary.verdicts[v]}`)
      .join(' · '),
  ];
}

export function markdownTable(rows: Scored[]): string {
  const header =
    '| score | verdict | file | lines | tests | expects | weak% | mocks | reasons |\n|---:|---|---|---:|---:|---:|---:|---:|---|';
  const body = rows.map((row) => {
    const weakPct = row.expects ? Math.round((row.weakExpects / row.expects) * 100) : 0;
    return `| ${row.score} | ${row.verdict} | \`${row.file}\` | ${row.lines} | ${row.tests} | ${row.expects} | ${weakPct} | ${row.mocks} | ${row.reasons.join('; ')} |`;
  });
  return [header, ...body].join('\n');
}
