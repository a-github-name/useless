import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Scored, ScoredUnit } from './types.js';

/**
 * Join a Stryker mutation report (coverageAnalysis "perTest", disableBail)
 * with scored rows. Every mutant records which tests covered it and which
 * killed it, so each test and each file gets a kill rate, a count of kills
 * no other test made, and, for a test with no unique kills, the single other
 * test that makes most of the same kills.
 */

export type ReportMutant = {
  id: string;
  status: string;
  coveredBy?: string[];
  killedBy?: string[];
  location?: { start: { line: number } };
};

export type ReportTest = { id: string; name: string; location?: { start: { line: number } } };

/** The subset of Stryker's mutation.json (schema 1.x) the join needs. */
export type MutationReport = {
  schemaVersion?: string;
  projectRoot?: string;
  files: Record<string, { mutants: ReportMutant[] }>;
  testFiles?: Record<string, { tests: ReportTest[] }>;
};

export type FileMutation = {
  covered: number;
  killed: number;
  killRate: number | null;
  /** Mutants no other test file kills. */
  unique: number;
  /** The same, restricted to the sibling source module. */
  ownCovered: number;
  ownKilled: number;
  ownRate: number | null;
  /** Units matched to a test in the report. */
  matchedUnits: number;
};

export type UnitMutation = {
  covered: number;
  killed: number;
  killRate: number | null;
  /** Mutants no other test kills. */
  unique: number;
  /** For a test with no unique kills: the other test that makes most of the same kills. */
  redundantWith: { test: string; share: number } | null;
};

export type ScoredUnitWithMutation = ScoredUnit & { mutation: UnitMutation | null };
export type ScoredWithMutation = Omit<Scored, 'units'> & {
  mutation: FileMutation | null;
  units: ScoredUnitWithMutation[];
};

export function loadMutationReport(path: string): MutationReport {
  const raw = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text) as MutationReport;
}

/** Drop source text and mutant details, keeping only what the join reads. */
export function reduceReport(report: MutationReport): MutationReport {
  const files: MutationReport['files'] = {};
  for (const [file, info] of Object.entries(report.files)) {
    files[file] = {
      mutants: info.mutants.map((m) => ({
        id: m.id,
        status: m.status,
        ...(m.coveredBy?.length ? { coveredBy: m.coveredBy } : {}),
        ...(m.killedBy?.length ? { killedBy: m.killedBy } : {}),
        ...(m.location ? { location: { start: { line: m.location.start.line } } } : {}),
      })),
    };
  }
  const testFiles: NonNullable<MutationReport['testFiles']> = {};
  for (const [file, info] of Object.entries(report.testFiles ?? {})) {
    testFiles[file] = {
      tests: info.tests.map((t) => ({
        id: t.id,
        name: t.name,
        ...(t.location ? { location: { start: { line: t.location.start.line } } } : {}),
      })),
    };
  }
  return {
    schemaVersion: report.schemaVersion ?? '1.0',
    ...(report.projectRoot ? { projectRoot: report.projectRoot } : {}),
    files,
    testFiles,
  };
}

type TestRecord = {
  id: string;
  file: string;
  name: string;
  line: number | null;
  covered: Set<string>;
  killed: Set<string>;
};

const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Report paths are absolute or project-relative; make them repo-relative. */
function relativiser(report: MutationReport, root: string): (file: string) => string {
  const absRoot = resolve(root);
  const projectRoot = report.projectRoot ? resolve(report.projectRoot) : absRoot;
  return (file) => {
    const abs = file.startsWith('/') ? file : resolve(projectRoot, file);
    return relative(absRoot, abs).replace(/^\.\//, '');
  };
}

export type JoinSummary = {
  mutants: number;
  killed: number;
  survivedCovered: number;
  noCoverage: number;
  tests: number;
  matchedUnits: number;
};

export function joinMutation(
  rows: Scored[],
  report: MutationReport,
  root: string,
): { rows: ScoredWithMutation[]; summary: JoinSummary } {
  const rel = relativiser(report, root);
  const tests = new Map<string, TestRecord>();
  for (const [file, info] of Object.entries(report.testFiles ?? {})) {
    for (const t of info.tests) {
      tests.set(t.id, {
        id: t.id,
        file: rel(file),
        name: t.name,
        line: t.location?.start.line ?? null,
        covered: new Set(),
        killed: new Set(),
      });
    }
  }
  const killersOf = new Map<string, string[]>();
  const summary: JoinSummary = {
    mutants: 0,
    killed: 0,
    survivedCovered: 0,
    noCoverage: 0,
    tests: tests.size,
    matchedUnits: 0,
  };
  const sourceOfMutant = new Map<string, string>();
  for (const [file, info] of Object.entries(report.files)) {
    const source = rel(file);
    for (const m of info.mutants) {
      const id = `${source}#${m.id}`;
      summary.mutants += 1;
      if (m.status === 'Killed') summary.killed += 1;
      else if (m.status === 'Survived' && m.coveredBy?.length) summary.survivedCovered += 1;
      else if (m.status === 'NoCoverage') summary.noCoverage += 1;
      sourceOfMutant.set(id, source);
      for (const t of m.coveredBy ?? []) tests.get(t)?.covered.add(id);
      const killers = (m.killedBy ?? []).filter((t) => tests.has(t));
      for (const t of killers) tests.get(t)?.killed.add(id);
      if (killers.length) killersOf.set(id, killers);
    }
  }

  const byFile = new Map<string, TestRecord[]>();
  for (const t of tests.values()) {
    let list = byFile.get(t.file);
    if (!list) {
      list = [];
      byFile.set(t.file, list);
    }
    list.push(t);
  }

  const rate = (killed: number, covered: number): number | null =>
    covered ? Math.round((killed / covered) * 1000) / 1000 : null;

  const joined = rows.map((row): ScoredWithMutation => {
    const fileTests = byFile.get(row.file) ?? [];
    if (fileTests.length === 0)
      return { ...row, mutation: null, units: row.units.map((u) => ({ ...u, mutation: null })) };
    const covered = new Set<string>();
    const killed = new Set<string>();
    for (const t of fileTests) {
      for (const id of t.covered) covered.add(id);
      for (const id of t.killed) killed.add(id);
    }
    const fileIds = new Set(fileTests.map((t) => t.id));
    let unique = 0;
    for (const id of killed)
      if ((killersOf.get(id) ?? []).every((k) => fileIds.has(k))) unique += 1;
    const own = (ids: Iterable<string>): number => {
      let n = 0;
      for (const id of ids) if (row.source && sourceOfMutant.get(id) === row.source) n += 1;
      return n;
    };
    const ownCovered = own(covered);
    const ownKilled = own(killed);

    const byName = new Map(fileTests.map((t) => [normalise(t.name), t]));
    const unmatched = new Set(fileTests);
    let matchedUnits = 0;
    const units = row.units.map((u): ScoredUnitWithMutation => {
      let t = byName.get(normalise(u.fullName)) ?? byName.get(normalise(u.name));
      if (!t)
        t = fileTests.find(
          (c) => c.line !== null && c.line >= u.line && c.line <= u.endLine && unmatched.has(c),
        );
      if (!t) return { ...u, mutation: null };
      unmatched.delete(t);
      matchedUnits += 1;
      let uniqueKills = 0;
      const overlap = new Map<string, number>();
      for (const id of t.killed) {
        const others = (killersOf.get(id) ?? []).filter((k) => k !== t.id);
        if (others.length === 0) uniqueKills += 1;
        for (const o of others) overlap.set(o, (overlap.get(o) ?? 0) + 1);
      }
      let redundantWith: UnitMutation['redundantWith'] = null;
      if (uniqueKills === 0 && t.killed.size >= 3) {
        let best: [string, number] | null = null;
        for (const entry of overlap) if (!best || entry[1] > best[1]) best = entry;
        if (best) {
          const other = tests.get(best[0]);
          const share = Math.round((best[1] / t.killed.size) * 100) / 100;
          if (other && share >= 0.9)
            redundantWith = { test: `${other.file}: ${other.name}`, share };
        }
      }
      return {
        ...u,
        mutation: {
          covered: t.covered.size,
          killed: t.killed.size,
          killRate: rate(t.killed.size, t.covered.size),
          unique: uniqueKills,
          redundantWith,
        },
      };
    });
    summary.matchedUnits += matchedUnits;
    const redundant = units.filter((u) => u.mutation?.redundantWith).length;
    const reasons = redundant
      ? [...row.reasons, `${redundant} of ${units.length} tests kill nothing another test does not`]
      : row.reasons;
    return {
      ...row,
      reasons,
      mutation: {
        covered: covered.size,
        killed: killed.size,
        killRate: rate(killed.size, covered.size),
        unique,
        ownCovered,
        ownKilled,
        ownRate: rate(ownKilled, ownCovered),
        matchedUnits,
      },
      units,
    };
  });
  return { rows: joined, summary };
}

/** Spearman rank correlation with average ranks for ties; null under three pairs. */
export function spearman(pairs: Array<[number, number]>): number | null {
  if (pairs.length < 3) return null;
  const ranks = (values: number[]): number[] => {
    const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]?.[0] === order[i]?.[0]) j += 1;
      const r = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) out[order[k]?.[1] ?? 0] = r;
      i = j + 1;
    }
    return out;
  };
  const a = ranks(pairs.map((p) => p[0]));
  const b = ranks(pairs.map((p) => p[1]));
  const n = pairs.length;
  const mean = (n + 1) / 2;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let k = 0; k < n; k += 1) {
    const x = (a[k] ?? 0) - mean;
    const y = (b[k] ?? 0) - mean;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return null;
  return Math.round((num / Math.sqrt(da * db)) * 1000) / 1000;
}
