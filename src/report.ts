import type { FileMutation, UnitMutation } from './mutation.js';
import { FINDING_ORDER } from './score.js';
import type { Finding, Scored, ScoredUnit } from './types.js';

type MaybeMutation = { mutation?: FileMutation | null };
type UnitMaybeMutation = { mutation?: UnitMutation | null };
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? '–' : String(Math.round(v * 100));

export type Summary = {
  files: number;
  lines: number;
  tests: number;
  expects: number;
  weakExpects: number;
  mocks: number;
  moduleMocks: number;
  findings: Record<Finding, number>;
  median: number;
  p90: number;
  sharedHarnessLines: number;
  sharedHarnessFiles: number;
  /** Parsed test blocks, and how many of them the rules flag on their own. */
  units: number;
  flaggedUnits: number;
  /** With a mutation report: tests matched to it, and tests whose every kill another test also makes. */
  mutationMatched: number;
  redundantUnits: number;
};

export function summarize(rows: Scored[]): Summary {
  const findings = Object.fromEntries(FINDING_ORDER.map((f) => [f, 0])) as Record<Finding, number>;
  const summary: Summary = {
    files: rows.length,
    lines: 0,
    tests: 0,
    expects: 0,
    weakExpects: 0,
    mocks: 0,
    moduleMocks: 0,
    findings,
    median: 0,
    p90: 0,
    sharedHarnessLines: 0,
    sharedHarnessFiles: 0,
    units: 0,
    flaggedUnits: 0,
    mutationMatched: 0,
    redundantUnits: 0,
  };
  for (const row of rows) {
    summary.units += row.units.length;
    for (const u of row.units as Array<ScoredUnit & UnitMaybeMutation>) {
      if (u.mutation) summary.mutationMatched += 1;
      if (u.mutation?.redundantWith) summary.redundantUnits += 1;
    }
    summary.flaggedUnits += row.units.filter(
      (u) => u.finding !== 'clean' && u.finding !== 'review',
    ).length;
    summary.lines += row.lines;
    summary.tests += row.tests;
    summary.expects += row.expects;
    summary.weakExpects += row.weakExpects;
    summary.mocks += row.mocks;
    summary.moduleMocks += row.moduleMocks;
    findings[row.finding] += 1;
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
    `score median ${summary.median} · p90 ${summary.p90}${
      summary.sharedHarnessFiles
        ? ` · ${summary.sharedHarnessLines} lines of setup duplicated across ${summary.sharedHarnessFiles} files`
        : ''
    }`,
    FINDING_ORDER.filter((f) => summary.findings[f] > 0)
      .map((f) => `${f}: ${summary.findings[f]}`)
      .join(' · ') +
      (summary.units
        ? ` · tests flagged on their own: ${summary.flaggedUnits} of ${summary.units}`
        : ''),
    ...(summary.mutationMatched
      ? [
          `mutation: ${summary.mutationMatched} tests matched · ${summary.redundantUnits} kill nothing another test does not`,
        ]
      : []),
  ];
}

export type UnitRow = ScoredUnit & { file: string };

/** Every parsed test block across the rows, most useless first. */
export function flattenUnits(rows: Scored[]): UnitRow[] {
  return rows
    .flatMap((row) => row.units.map((u) => ({ ...u, file: row.file })))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.line - b.line);
}

export function unitTable(units: UnitRow[]): string {
  const withMutation = units.some((u) => (u as UnitMaybeMutation).mutation);
  const header = withMutation
    ? '| score | finding | test | lines | expects | weak% | kill% | unique | redundant with | reasons |\n|---:|---|---|---:|---:|---:|---:|---:|---|---|'
    : '| score | finding | test | lines | expects | weak% | reasons |\n|---:|---|---|---:|---:|---:|---|';
  const body = units.map((u) => {
    const weakPct = u.expects ? Math.round((u.weakExpects / u.expects) * 100) : 0;
    const m = (u as UnitMaybeMutation).mutation;
    const head = `| ${u.score} | ${u.finding} | \`${u.file}:${u.line}\` ${u.fullName.replace(/\|/g, '\\|')} | ${u.lines} | ${u.expects} | ${weakPct} |`;
    const tail = withMutation
      ? ` ${pct(m?.killRate)} | ${m ? m.unique : '–'} | ${m?.redundantWith ? `${m.redundantWith.test.replace(/\|/g, '\\|')} (${Math.round(m.redundantWith.share * 100)}%)` : ''} |`
      : '';
    return `${head}${tail} ${u.reasons.join('; ')} |`;
  });
  return [header, ...body].join('\n');
}

export function markdownTable(rows: Scored[]): string {
  const withMutation = rows.some((r) => (r as MaybeMutation).mutation);
  const header = withMutation
    ? '| score | finding | file | lines | tests | expects | weak% | mocks | own kill% | kill% | reasons |\n|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|'
    : '| score | finding | file | lines | tests | expects | weak% | mocks | reasons |\n|---:|---|---|---:|---:|---:|---:|---:|---|';
  const body = rows.map((row) => {
    const weakPct = row.expects ? Math.round((row.weakExpects / row.expects) * 100) : 0;
    const m = (row as MaybeMutation).mutation;
    const head = `| ${row.score} | ${row.finding} | \`${row.file}\` | ${row.lines} | ${row.tests} | ${row.expects} | ${weakPct} | ${row.mocks} |`;
    const tail = withMutation ? ` ${pct(m?.ownRate)} | ${pct(m?.killRate)} |` : '';
    return `${head}${tail} ${row.reasons.join('; ')} |`;
  });
  return [header, ...body].join('\n');
}
