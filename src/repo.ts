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
  '*.test.mjs',
  '*.spec.ts',
  '*.spec.tsx',
  '*.spec.js',
  '*test.ts',
  '*__tests__/*',
  'test/*',
  'tests/*',
  '*/test/*',
  '*/tests/*',
];

/** Paths under a test directory that are helpers, fixtures, or generated output rather than tests. */
const NOT_A_TEST_RE =
  /(^|\/)(fixtures?|helpers?|utils?|mocks?|__mocks__|__snapshots__|snapshots?|support|setup|stubs?|data|assets|__fixtures__)(\/|$)|\.(d\.ts|snap|json|md|html|css|map)$/;

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
}

const CODE_RE = /\.[cm]?[jt]sx?$/;

/**
 * Tracked test files, relative to `root`, via `git ls-files`. Files under a
 * test directory count when they are code and not obviously a helper or
 * fixture; `collectRepo` later drops anything with no test blocks.
 */
export function listTestFiles(root: string, patterns = DEFAULT_PATTERNS): string[] {
  const seen = new Set<string>();
  return git(root, ['ls-files', '--', ...patterns])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line || seen.has(line) || !CODE_RE.test(line) || /node_modules\//.test(line))
        return false;
      seen.add(line);
      return TEST_FILE_RE.test(line) || !NOT_A_TEST_RE.test(line);
    });
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
  let log = '';
  try {
    log = git(root, ['log', '--format=COMMIT %H', '--name-only']);
  } catch (error) {
    process.stderr.write(
      `useless: git log failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); lockstep signal disabled\n`,
    );
    return index;
  }
  for (const raw of log.split('\n')) {
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

const MIN_LINE = 12;

function distinctLines(text: string): Set<string> {
  const lines = new Set<string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length >= MIN_LINE && !/^(import |\/\/|\*|\/\*|}|\)|];?$)/.test(line)) lines.add(line);
  }
  return lines;
}

/**
 * For each file, the other file that contains the largest share of its
 * distinct lines, when that share is at least `threshold`. Catches copy-pasted
 * mock harnesses and forked test files that drifted only slightly.
 */
export function findSimilar(
  files: Array<{ file: string; text: string }>,
  threshold = 0.5,
): Map<string, { file: string; share: number }> {
  const sets = files.map(({ file, text }) => ({ file, lines: distinctLines(text) }));
  const result = new Map<string, { file: string; share: number }>();
  for (let i = 0; i < sets.length; i += 1) {
    const a = sets[i];
    if (!a || a.lines.size < 20) continue;
    let best: { file: string; share: number } | null = null;
    for (let j = 0; j < sets.length; j += 1) {
      const b = sets[j];
      if (!b || j === i || b.lines.size < a.lines.size * 0.4) continue;
      let common = 0;
      for (const line of a.lines) if (b.lines.has(line)) common += 1;
      const share = common / a.lines.size;
      if (share >= threshold && (!best || share > best.share)) best = { file: b.file, share };
    }
    if (best) result.set(a.file, { file: best.file, share: Math.round(best.share * 100) / 100 });
  }
  // When two files point at each other, report only the later one (listing
  // order) so a pair yields one actionable row, matching findDuplicates.
  const order = new Map(files.map(({ file }, i) => [file, i]));
  for (const [file, match] of [...result]) {
    const back = result.get(match.file);
    if (back?.file === file && (order.get(file) ?? 0) < (order.get(match.file) ?? 0))
      result.delete(file);
  }
  return result;
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
  const similar = findSimilar(files);
  const signals = files.map(({ file, text }) => {
    const source = siblingSource(root, file);
    return analyzeTest({
      file,
      text,
      source,
      sourceText: source ? readFileSync(join(root, source), 'utf8') : null,
      churn: churnFor(churn, file, source),
      timing: timings.get(file) ?? null,
      duplicateOf: duplicates.get(file) ?? null,
      similarTo: duplicates.has(file) ? null : (similar.get(file) ?? null),
    });
  });
  // A file under test/ with no test blocks is a helper or fixture, not a test.
  return signals.filter((row) => row.tests > 0 || TEST_FILE_RE.test(row.file));
}
