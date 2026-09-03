import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { TEST_FILE_RE, analyzeTest } from './signals.js';
import type { Churn, Signals, Timing } from './types.js';

export const DEFAULT_PATTERNS = [
  '*.test.ts',
  '*.test.tsx',
  '*.test.js',
  '*.test.jsx',
  '*.spec.ts',
  '*.spec.tsx',
  '*.spec.js',
];

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** Tracked test files, relative to `root`, via `git ls-files`. */
export function listTestFiles(root: string, patterns = DEFAULT_PATTERNS): string[] {
  return git(root, ['ls-files', '--', ...patterns])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && TEST_FILE_RE.test(line));
}

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** `foo.test.ts` -> `foo.ts` (or .tsx/.js/...) in the same directory, if present. */
export function siblingSource(root: string, testFile: string): string | null {
  const dir = dirname(testFile);
  const base = basename(testFile).replace(TEST_FILE_RE, '');
  for (const ext of SOURCE_EXTS) {
    const candidate = join(dir, `${base}${ext}`);
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/** path -> set of commit hashes that touched it. */
export type ChurnIndex = Map<string, Set<string>>;

export function buildChurnIndex(root: string): ChurnIndex {
  const index: ChurnIndex = new Map();
  let commit = '';
  for (const raw of git(root, ['log', '--format=COMMIT %H', '--name-only']).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('COMMIT ')) {
      commit = line.slice(7);
      continue;
    }
    if (!line) continue;
    let set = index.get(line);
    if (!set) {
      set = new Set();
      index.set(line, set);
    }
    set.add(commit);
  }
  return index;
}

export function churnFor(index: ChurnIndex, testFile: string, source: string | null): Churn {
  const testCommits = index.get(testFile) ?? new Set<string>();
  const sourceCommits = source ? (index.get(source) ?? new Set<string>()) : new Set<string>();
  let coChange = 0;
  for (const hash of testCommits) if (sourceCommits.has(hash)) coChange += 1;
  return {
    testCommits: testCommits.size,
    sourceCommits: sourceCommits.size,
    coChangeCommits: coChange,
  };
}

type ReportResult = { name: string; startTime: number; endTime: number; status: string };

function isReportResult(value: unknown): value is ReportResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === 'string' &&
    typeof v.startTime === 'number' &&
    typeof v.endTime === 'number' &&
    typeof v.status === 'string'
  );
}

/**
 * Parse a `vitest run --reporter=json --outputFile=<file>` (or Jest `--json`)
 * report into per-file timings, keyed by path relative to `root`.
 */
export function parseTimings(json: string, root: string): Map<string, Timing> {
  const timings = new Map<string, Timing>();
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) return timings;
  const results = (parsed as Record<string, unknown>).testResults;
  if (!Array.isArray(results)) return timings;
  const absRoot = resolve(root);
  for (const result of results) {
    if (!isReportResult(result)) continue;
    const key = result.name.startsWith(absRoot) ? relative(absRoot, result.name) : result.name;
    timings.set(key, {
      durationMs: Math.max(0, result.endTime - result.startTime),
      failed: result.status === 'failed',
    });
  }
  return timings;
}

export function loadTimings(path: string | undefined, root: string): Map<string, Timing> {
  if (!path) return new Map();
  return parseTimings(readFileSync(path, 'utf8'), root);
}

export type CollectOptions = {
  root: string;
  patterns?: string[];
  timings?: Map<string, Timing>;
};

/** Map each file to the first file (in listing order) with identical whitespace-stripped content. */
export function findDuplicates(files: Array<{ file: string; text: string }>): Map<string, string> {
  const firstByHash = new Map<string, string>();
  const duplicates = new Map<string, string>();
  for (const { file, text } of files) {
    const hash = createHash('sha1').update(text.replace(/\s+/g, '')).digest('hex');
    const first = firstByHash.get(hash);
    if (first) duplicates.set(file, first);
    else firstByHash.set(hash, file);
  }
  return duplicates;
}

/** Read every test file in the repo and extract its signals. */
export function collectRepo(options: CollectOptions): Signals[] {
  const root = resolve(options.root);
  const churn = buildChurnIndex(root);
  const timings = options.timings ?? new Map<string, Timing>();
  const files = listTestFiles(root, options.patterns).map((file) => ({
    file,
    text: readFileSync(join(root, file), 'utf8'),
  }));
  const duplicates = findDuplicates(files);
  return files.map(({ file, text }) => {
    const source = siblingSource(root, file);
    return analyzeTest({
      file,
      text,
      source,
      sourceText: source ? readFileSync(join(root, source), 'utf8') : null,
      churn: churnFor(churn, file, source),
      timing: timings.get(file) ?? null,
      duplicateOf: duplicates.get(file) ?? null,
    });
  });
}
