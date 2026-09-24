import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { rank } from './index.js';
import {
  type JoinSummary,
  type ScoredWithMutation,
  joinMutation,
  loadMutationReport,
  spearman,
} from './mutation.js';
import { FINDING_ORDER } from './score.js';
import type { Finding } from './types.js';

/**
 * The benchmark: for each repo with a stored mutation report, rescan with
 * the current rules and measure how well the score predicts which tests
 * kill mutants. A rule change is judged by these numbers, not by argument.
 */

export type BenchCase = {
  name: string;
  /** Repo checkout; relative paths resolve against `USELESS_CORPUS` or the manifest directory. */
  root: string;
  /** Mutation report, relative to the manifest directory. */
  mutation: string;
  commit?: string;
  note?: string;
  /** Output of `useless read` for this repo, to score the rubric against the same ground truth. */
  reads?: string;
};

export type BenchManifest = { cases: BenchCase[] };

export type BenchResult = {
  name: string;
  files: number;
  filesWithOwn: number;
  units: number;
  /** Units in files the report has tests for: the population that can match. */
  unitsInReport: number;
  unitsMatched: number;
  /** Spearman of file score against survival in its own source (files with ≥10 own mutants). */
  fileOwn: number | null;
  /** Spearman of file score against survival across everything it covers (≥10 mutants). */
  fileAll: number | null;
  /** Spearman of unit score against survival across what the unit covers (≥5 mutants). */
  unit: number | null;
  /** Mean kill rate of units the rules flag versus units they call clean. */
  flaggedUnits: number;
  flaggedUnitKill: number | null;
  cleanUnits: number;
  cleanUnitKill: number | null;
  /** Mean own-source kill rate by file finding. */
  byFinding: Partial<Record<Finding, { files: number; kill: number | null }>>;
  /** Mean kill rate by unit finding (units covering ≥5 mutants). */
  byUnitFinding: Partial<Record<Finding, { units: number; kill: number | null }>>;
  /** Spearman of a close-read rating against own-source survival, when reads were supplied. */
  readRho: number | null;
  readsUsed: number;
  join: JoinSummary;
};

export function loadManifest(path: string): { dir: string; manifest: BenchManifest } {
  return {
    dir: dirname(resolve(path)),
    manifest: JSON.parse(readFileSync(path, 'utf8')) as BenchManifest,
  };
}

export function resolveRoot(dir: string, root: string): string {
  if (isAbsolute(root)) return root;
  const corpus = process.env.USELESS_CORPUS;
  return corpus ? resolve(corpus, root) : resolve(dir, root);
}

const mean = (values: number[]): number | null =>
  values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000
    : null;

export function summariseJoined(
  name: string,
  rows: ScoredWithMutation[],
  join: JoinSummary,
  reads?: Map<string, number>,
): BenchResult {
  const withData = rows.filter((r) => r.mutation);
  const own = withData.filter((r) => (r.mutation?.ownCovered ?? 0) >= 10);
  const all = withData.filter((r) => (r.mutation?.covered ?? 0) >= 10);
  const units = rows.flatMap((r) => r.units).filter((u) => (u.mutation?.covered ?? 0) >= 5);
  const flagged = units.filter((u) => u.finding !== 'clean' && u.finding !== 'review');
  const clean = units.filter((u) => u.finding === 'clean');
  const byFinding: BenchResult['byFinding'] = {};
  const byUnitFinding: BenchResult['byUnitFinding'] = {};
  for (const f of FINDING_ORDER) {
    const group = own.filter((r) => r.finding === f);
    if (group.length)
      byFinding[f] = {
        files: group.length,
        kill: mean(group.map((r) => r.mutation?.ownRate ?? 0)),
      };
    const ug = units.filter((u) => u.finding === f);
    if (ug.length)
      byUnitFinding[f] = { units: ug.length, kill: mean(ug.map((u) => u.mutation?.killRate ?? 0)) };
  }
  const rated = own.filter((r) => reads?.has(r.file));
  return {
    name,
    files: rows.length,
    filesWithOwn: own.length,
    units: rows.reduce((n, r) => n + r.units.length, 0),
    unitsInReport: withData.reduce((n, r) => n + r.units.length, 0),
    unitsMatched: join.matchedUnits,
    fileOwn: spearman(own.map((r) => [r.score, 1 - (r.mutation?.ownRate ?? 0)])),
    fileAll: spearman(all.map((r) => [r.score, 1 - (r.mutation?.killRate ?? 0)])),
    unit: spearman(units.map((u) => [u.score, 1 - (u.mutation?.killRate ?? 0)])),
    flaggedUnits: flagged.length,
    flaggedUnitKill: mean(flagged.map((u) => u.mutation?.killRate ?? 0)),
    cleanUnits: clean.length,
    cleanUnitKill: mean(clean.map((u) => u.mutation?.killRate ?? 0)),
    byFinding,
    byUnitFinding,
    readRho: spearman(rated.map((r) => [reads?.get(r.file) ?? 0, 1 - (r.mutation?.ownRate ?? 0)])),
    readsUsed: rated.length,
    join,
  };
}

export async function runBench(
  manifestPath: string,
  options: { ast?: boolean; only?: string[] } = {},
): Promise<BenchResult[]> {
  const { dir, manifest } = loadManifest(manifestPath);
  const results: BenchResult[] = [];
  for (const c of manifest.cases) {
    if (options.only?.length && !options.only.includes(c.name)) continue;
    const root = resolveRoot(dir, c.root);
    const report = loadMutationReport(resolve(dir, c.mutation));
    const rows = await rank({ root, ast: options.ast !== false });
    const { rows: joined, summary } = joinMutation(rows, report, root);
    const reads = c.reads ? loadReadRatings(resolve(dir, c.reads)) : undefined;
    results.push(summariseJoined(c.name, joined, summary, reads));
  }
  return results;
}

/** file -> aggregated rating from a `useless read` JSON output. */
export function loadReadRatings(path: string): Map<string, number> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Array<{
    file: string;
    rating: number | null;
  }>;
  const map = new Map<string, number>();
  for (const r of parsed) if (typeof r.rating === 'number') map.set(r.file, r.rating);
  return map;
}

const fmt = (v: number | null): string => (v === null ? '–' : v.toFixed(2));

export function benchTable(results: BenchResult[]): string {
  const header =
    '| repo | files (own≥10) | units matched | file ρ own | file ρ all | unit ρ | flagged units: kill | clean units: kill | read ρ (n) |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const body = results.map(
    (r) =>
      `| ${r.name} | ${r.files} (${r.filesWithOwn}) | ${r.unitsMatched}/${r.unitsInReport} | ${fmt(r.fileOwn)} | ${fmt(r.fileAll)} | ${fmt(r.unit)} | ${r.flaggedUnits}: ${fmt(r.flaggedUnitKill)} | ${r.cleanUnits}: ${fmt(r.cleanUnitKill)} | ${fmt(r.readRho)} (${r.readsUsed}) |`,
  );
  const findings = results.flatMap((r) =>
    Object.entries(r.byFinding).map(
      ([f, v]) => `| ${r.name} | ${f} | ${v.files} | ${fmt(v.kill)} |`,
    ),
  );
  const unitFindings = results.flatMap((r) =>
    Object.entries(r.byUnitFinding).map(
      ([f, v]) => `| ${r.name} | ${f} | ${v.units} | ${fmt(v.kill)} |`,
    ),
  );
  return [
    header,
    ...body,
    '',
    '| repo | file finding | files | mean own kill rate |\n|---|---|---:|---:|',
    ...findings,
    '',
    '| repo | unit finding | units | mean kill rate |\n|---|---|---:|---:|',
    ...unitFindings,
  ].join('\n');
}
