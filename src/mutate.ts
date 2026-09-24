import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { MutationReport, ReportMutant, ReportTest } from './mutation.js';
import { listTestFiles } from './repo.js';
import { splitSwiftUnits } from './swift.js';

/**
 * Mutation testing for Swift packages, with per-test attribution. Stryker
 * does not do Swift and Muter does not record which test killed a mutant, so
 * this runs the loop itself: instrument coverage once per suite, mutate one
 * covered line at a time, rebuild, run only the suites that cover the line
 * with an xunit report, and credit every failing test. The output is a
 * Stryker-shaped mutation.json that `--mutation` and `useless bench` read.
 */

export type Mutant = {
  file: string;
  line: number;
  column: number;
  index: number;
  original: string;
  replacement: string;
  mutator: string;
};

/** Positions that are code rather than comment or string contents. */
export function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length).fill(1);
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < text.length; k += 1) mask[k] = 0;
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      blank(i, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (ch === '#' && next === '"') {
      const end = text.indexOf('"#', i + 2);
      blank(i, end < 0 ? text.length : end + 2);
      i = end < 0 ? text.length : end + 2;
    } else if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      blank(i, end < 0 ? text.length : end + 3);
      i = end < 0 ? text.length : end + 3;
    } else if (ch === '"') {
      let k = i + 1;
      while (k < text.length && text[k] !== '"' && text[k] !== '\n') {
        if (text[k] === '\\') k += 1;
        k += 1;
      }
      // Keep the quotes themselves so StringLiteral can find them.
      blank(i + 1, k);
      i = k + 1;
    } else i += 1;
  }
  return mask;
}

type Operator = { name: string; re: RegExp; replace: (m: RegExpExecArray) => string | null };

const OPERATORS: Operator[] = [
  { name: 'EqualityOperator', re: /==|!=/g, replace: (m) => (m[0] === '==' ? '!=' : '==') },
  {
    name: 'RelationalOperator',
    re: / (<=|>=|<|>) /g,
    replace: (m) => ` ${{ '<': '<=', '<=': '<', '>': '>=', '>=': '>' }[m[1] ?? ''] ?? ''} `,
  },
  {
    name: 'LogicalOperator',
    re: / (&&|\|\|) /g,
    replace: (m) => (m[1] === '&&' ? ' || ' : ' && '),
  },
  {
    name: 'ArithmeticOperator',
    re: / (\+|-|\*|\/|\+=|-=) /g,
    replace: (m) =>
      ` ${{ '+': '-', '-': '+', '*': '/', '/': '*', '+=': '-=', '-=': '+=' }[m[1] ?? ''] ?? ''} `,
  },
  {
    name: 'BooleanLiteral',
    re: /\b(true|false)\b/g,
    replace: (m) => (m[1] === 'true' ? 'false' : 'true'),
  },
  { name: 'UnaryOperator', re: /(?<![!=<>])!(?=[A-Za-z_(])/g, replace: () => '' },
  {
    name: 'NumericLiteral',
    re: /(?<![\w.])(\d+)(?![\w.])/g,
    replace: (m) => String(Number(m[1]) + 1),
  },
  { name: 'StringLiteral', re: /"([^"\\\n]|\\.)+"/g, replace: () => '""' },
  {
    name: 'ConditionalExpression',
    re: /^([ \t]*(?:\} else )?(?:if|guard|while) )(.+?)( \{| else \{)$/gm,
    replace: (m) => `${m[1]}${/\blet\b|\bvar\b|\bcase\b/.test(m[2] ?? '') ? null : 'false'}${m[3]}`,
  },
];

/** Every mutant the operators can make on `text`, restricted to `lines` when given. */
export function generateMutants(
  file: string,
  text: string,
  lines: Set<number> | null = null,
): Mutant[] {
  const mask = codeMask(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: Mutant[] = [];
  for (const op of OPERATORS) {
    op.re.lastIndex = 0;
    for (const m of text.matchAll(op.re)) {
      const index = m.index ?? 0;
      const original = m[0];
      const probe =
        op.name === 'StringLiteral' ? index : index + Math.max(0, original.search(/\S/));
      if (!mask[probe]) continue;
      if (op.name === 'StringLiteral' && original.includes('\\(')) continue;
      const line = lineOf(index);
      if (lines && !lines.has(line)) continue;
      const replacement = op.replace(m);
      if (replacement === null || replacement.includes('null')) continue;
      out.push({
        file,
        line,
        column: index - (lineStarts[line - 1] ?? 0) + 1,
        index,
        original,
        replacement,
        mutator: op.name,
      });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Deterministic uniform sample of at most `max` items. */
export function sample<T>(items: T[], max: number, seed = 42): T[] {
  if (items.length <= max) return items;
  let s = seed;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, max);
}

export type XunitTest = { suite: string; name: string; passed: boolean };

/** Both files SwiftPM writes: `<path>` for XCTest and `<stem>-swift-testing.xml` for Swift Testing. */
export function readXunit(path: string): XunitTest[] {
  const stem = path.replace(/\.xml$/, '');
  const tests: XunitTest[] = [];
  for (const p of [path, `${stem}-swift-testing.xml`]) {
    if (!existsSync(p)) continue;
    const xml = readFileSync(p, 'utf8');
    for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
      const attrs = new Map<string, string>();
      for (const a of (m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) attrs.set(a[1] ?? '', a[2] ?? '');
      const suite = (attrs.get('classname') ?? '').split('.').pop() ?? '';
      const name = (attrs.get('name') ?? '').replace(/\(\)$/, '');
      if (!suite || !name) continue;
      tests.push({ suite, name, passed: !/<(failure|error)\b/.test(m[2] ?? '') });
    }
  }
  return tests;
}

/** Lines with a non-zero execution count per file, from SwiftPM's llvm-cov export. */
export function coveredLines(codecovJson: string): Map<string, Set<number>> {
  const parsed = JSON.parse(codecovJson) as {
    data: Array<{ files: Array<{ filename: string; segments: number[][] }> }>;
  };
  const out = new Map<string, Set<number>>();
  for (const f of parsed.data[0]?.files ?? []) {
    const lines = new Set<number>();
    const segments = [...f.segments].sort(
      (a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0),
    );
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i] ?? [];
      const [line = 0, , count = 0, hasCount = false] = seg;
      if (!hasCount || count <= 0) continue;
      const nextLine = segments[i + 1]?.[0] ?? line;
      for (let l = line; l <= nextLine; l += 1) lines.add(l);
    }
    if (lines.size) out.set(f.filename, lines);
  }
  return out;
}

type RunResult = { code: number | null; timedOut: boolean; output: string };

function run(command: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      output += d;
    });
    child.stderr.on('data', (d) => {
      output += d;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, timedOut, output: output.slice(-4000) });
    });
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type MutateOptions = {
  root: string;
  patterns: string[];
  max: number;
  coverage: 'suite' | 'none';
  timeoutMs: number;
  out: string;
  resume: boolean;
  /** `swift test --filter` regex for the baseline and coverage runs: the test target that can reach the mutated sources. */
  filter?: string;
  log: (line: string) => void;
};

export async function mutateSwift(options: MutateOptions): Promise<MutationReport> {
  const { root, log } = options;
  const swift = (args: string[], timeoutMs: number): Promise<RunResult> =>
    run('swift', args, root, timeoutMs);
  // XCTest only writes xunit output from the parallel runner.
  const cov = ['--enable-code-coverage'];
  const tmp = join(root, '.build', 'useless-mutate');
  mkdirSync(tmp, { recursive: true });
  // SwiftPM names the export after the package, not the directory: take the newest.
  const codecovDir = join(root, '.build', 'debug', 'codecov');
  const codecovPath = (): string | null => {
    if (!existsSync(codecovDir)) return null;
    const files = readdirSync(codecovDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(codecovDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  };
  const filter = options.filter ? ['--filter', options.filter] : [];

  log('building with coverage');
  const build = await swift(['build', '--build-tests', ...cov], 30 * 60_000);
  if (build.code !== 0) throw new Error(`baseline build failed:\n${build.output}`);

  // Test files and the blocks in them, so xunit results map to files.
  const testFiles = listTestFiles(root).filter((f) => f.endsWith('.swift'));
  const unitFile = new Map<string, string>();
  for (const f of testFiles) {
    for (const u of splitSwiftUnits(readFileSync(join(root, f), 'utf8')))
      unitFile.set(u.fullName, f);
  }

  log('baseline test run');
  const baseXml = join(tmp, 'base.xml');
  const base = await swift(
    ['test', '--skip-build', '--parallel', ...cov, ...filter, '--xunit-output', baseXml],
    options.timeoutMs * 4,
  );
  const baseTests = readXunit(baseXml);
  if (baseTests.length === 0) throw new Error(`no tests in baseline xunit output:\n${base.output}`);
  const failing = baseTests.filter((t) => !t.passed);
  if (failing.length) log(`${failing.length} test(s) fail before mutation and are excluded`);
  const tests = baseTests.filter((t) => t.passed);
  const testId = new Map<string, string>();
  const reportTests = new Map<string, ReportTest[]>();
  tests.forEach((t, i) => {
    const full = `${t.suite}.${t.name}`;
    const id = `t${i}`;
    testId.set(full, id);
    const file = unitFile.get(full) ?? 'unknown';
    let list = reportTests.get(file);
    if (!list) {
      list = [];
      reportTests.set(file, list);
    }
    list.push({ id, name: full });
  });
  const suiteTests = new Map<string, string[]>();
  for (const t of tests) {
    const id = testId.get(`${t.suite}.${t.name}`) ?? '';
    let list = suiteTests.get(t.suite);
    if (!list) {
      list = [];
      suiteTests.set(t.suite, list);
    }
    list.push(id);
  }
  log(
    `${tests.length} tests in ${suiteTests.size} suites, ${unitFile.size} blocks in ${testFiles.length} test files`,
  );

  // Coverage per suite: which source lines each suite executes.
  const suiteCoverage = new Map<string, Map<string, Set<number>>>();
  const suiteModule = new Map<string, string>();
  if (options.coverage === 'suite') {
    const modules = readXunit(baseXml);
    for (const t of modules) suiteModule.set(t.suite, t.suite);
    const suites = [...suiteTests.keys()];
    for (const [i, suite] of suites.entries()) {
      const r = await swift(
        ['test', '--skip-build', '--parallel', ...cov, '--filter', `\\.${escapeRe(suite)}/`],
        options.timeoutMs * 2,
      );
      const exportPath = codecovPath();
      if (!exportPath) throw new Error(`no coverage export under ${codecovDir}:\n${r.output}`);
      const lines = coveredLines(readFileSync(exportPath, 'utf8'));
      const rel = new Map<string, Set<number>>();
      for (const [file, set] of lines) rel.set(relative(root, file), set);
      suiteCoverage.set(suite, rel);
      if ((i + 1) % 10 === 0 || i + 1 === suites.length)
        log(`coverage ${i + 1}/${suites.length} suites`);
    }
  }

  // Mutants on covered lines of the selected source files.
  const sourceFiles = listSourceFiles(root, options.patterns);
  const union = new Map<string, Set<number>>();
  for (const perFile of suiteCoverage.values())
    for (const [file, set] of perFile) {
      let u = union.get(file);
      if (!u) {
        u = new Set();
        union.set(file, u);
      }
      for (const l of set) u.add(l);
    }
  let all: Mutant[] = [];
  for (const file of sourceFiles) {
    const lines = options.coverage === 'suite' ? (union.get(file) ?? new Set<number>()) : null;
    if (lines && lines.size === 0) continue;
    all = all.concat(generateMutants(file, readFileSync(join(root, file), 'utf8'), lines));
  }
  const chosen = sample(all, options.max);
  log(`${all.length} possible mutants in ${sourceFiles.length} files; running ${chosen.length}`);

  const report: MutationReport = {
    schemaVersion: '1.0',
    projectRoot: resolve(root),
    files: {},
    testFiles: Object.fromEntries([...reportTests].map(([f, list]) => [f, { tests: list }])),
  };
  const done = new Map<string, ReportMutant>();
  if (options.resume && existsSync(options.out)) {
    const prev = JSON.parse(readFileSync(options.out, 'utf8')) as MutationReport;
    for (const [file, info] of Object.entries(prev.files))
      for (const m of info.mutants) done.set(`${file}:${m.id}`, m);
    log(`resuming: ${done.size} mutants already recorded`);
  }
  const record = (m: Mutant, entry: ReportMutant): void => {
    let info = report.files[m.file];
    if (!info) {
      info = { mutants: [] };
      report.files[m.file] = info;
    }
    info.mutants.push(entry);
  };
  const save = (): void => {
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, JSON.stringify(report));
  };
  const tally = { Killed: 0, Survived: 0, Timeout: 0, CompileError: 0, NoCoverage: 0 };

  const originals = new Map<string, string>();
  const restore = (): void => {
    for (const [file, text] of originals) writeFileSync(join(root, file), text);
    originals.clear();
  };
  process.on('SIGINT', () => {
    restore();
    save();
    process.exit(130);
  });

  for (const [i, m] of chosen.entries()) {
    const id = `${m.line}:${m.column}:${m.mutator}`;
    const prev = done.get(`${m.file}:${id}`);
    const base: Omit<ReportMutant, 'status'> & { mutatorName: string; replacement: string } = {
      id,
      mutatorName: m.mutator,
      replacement: m.replacement,
      location: { start: { line: m.line } },
    };
    if (prev) {
      record(m, prev);
      continue;
    }
    const covering = [...suiteCoverage]
      .filter(([, files]) => files.get(m.file)?.has(m.line))
      .map(([s]) => s);
    const coveredBy =
      options.coverage === 'suite'
        ? covering.flatMap((s) => suiteTests.get(s) ?? [])
        : [...testId.values()];
    if (coveredBy.length === 0) {
      record(m, { ...base, status: 'NoCoverage', coveredBy: [] });
      tally.NoCoverage += 1;
      continue;
    }
    const text = readFileSync(join(root, m.file), 'utf8');
    if (text.slice(m.index, m.index + m.original.length) !== m.original) {
      log(`skip ${m.file}:${m.line} (source changed)`);
      continue;
    }
    originals.set(m.file, text);
    writeFileSync(
      join(root, m.file),
      text.slice(0, m.index) + m.replacement + text.slice(m.index + m.original.length),
    );
    let entry: ReportMutant;
    try {
      const b = await swift(['build', '--build-tests', ...cov], 20 * 60_000);
      if (b.code !== 0) {
        entry = { ...base, status: 'CompileError', coveredBy };
        tally.CompileError += 1;
      } else {
        const xml = join(tmp, `m${i}.xml`);
        const filter =
          options.coverage === 'suite'
            ? ['--filter', `\\.(${covering.map(escapeRe).join('|')})/`]
            : [];
        const r = await swift(
          ['test', '--skip-build', '--parallel', ...cov, ...filter, '--xunit-output', xml],
          options.timeoutMs,
        );
        if (r.timedOut) {
          entry = { ...base, status: 'Timeout', coveredBy };
          tally.Timeout += 1;
        } else {
          const results = readXunit(xml);
          const killedBy = results
            .filter((t) => !t.passed)
            .map((t) => testId.get(`${t.suite}.${t.name}`) ?? '')
            .filter(Boolean);
          // A crash with no xunit output still counts as a kill by every covering test.
          const crashed = results.length === 0 && r.code !== 0;
          entry = crashed
            ? { ...base, status: 'Killed', coveredBy, killedBy: coveredBy }
            : { ...base, status: killedBy.length ? 'Killed' : 'Survived', coveredBy, killedBy };
          tally[killedBy.length || crashed ? 'Killed' : 'Survived'] += 1;
        }
      }
    } finally {
      restore();
    }
    record(m, entry);
    if ((i + 1) % 10 === 0) save();
    log(
      `${i + 1}/${chosen.length} ${entry.status.padEnd(12)} ${m.file}:${m.line} ${m.mutator} · killed ${tally.Killed} survived ${tally.Survived} timeout ${tally.Timeout} compile-error ${tally.CompileError} no-coverage ${tally.NoCoverage}`,
    );
  }
  save();
  return report;
}

function listSourceFiles(root: string, patterns: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) => l.endsWith('.swift') && !/(^|\/)[^/]*Tests?\//.test(l) && !/Tests?\.swift$/.test(l),
    );
}

const HELP = `useless mutate — mutation-test a Swift package with per-test attribution

Usage:
  useless mutate --root <package> [options]

Options:
  --root <dir>        Swift package root (default: cwd)
  --mutate <glob>     git ls-files pattern for source files; repeatable
                      (default: Sources/*)
  --max <n>           Mutants to run, sampled uniformly (default: 300)
  --coverage <mode>   suite (default): run one coverage pass per test suite and
                      execute only covering suites per mutant; none: run everything
  --filter <regex>    swift test --filter for the baseline and coverage runs, e.g.
                      'MyLibTests\.' to restrict to the target that covers the sources
  --timeout <s>       Per test run (default: 300)
  --out <file>        Report path (default: reports/mutation/mutation.json)
  --resume            Skip mutants already in the report
  -h, --help          Show this help

Writes a Stryker-shaped mutation.json: pass it to \`useless --mutation\` or add
it to bench/bench.json.
`;

export async function mutateCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string', default: process.cwd() },
      mutate: { type: 'string', multiple: true },
      max: { type: 'string', default: '300' },
      coverage: { type: 'string', default: 'suite' },
      timeout: { type: 'string', default: '300' },
      filter: { type: 'string' },
      out: { type: 'string', default: 'reports/mutation/mutation.json' },
      resume: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = resolve(values.root);
  const report = await mutateSwift({
    root,
    patterns: values.mutate?.length ? values.mutate : ['Sources/*'],
    max: Math.max(1, Number(values.max)),
    coverage: values.coverage === 'none' ? 'none' : 'suite',
    timeoutMs: Math.max(1, Number(values.timeout)) * 1000,
    out: resolve(root, values.out),
    resume: values.resume,
    ...(values.filter ? { filter: values.filter } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  let n = 0;
  for (const f of Object.values(report.files)) n += f.mutants.length;
  process.stdout.write(`${n} mutants recorded in ${resolve(root, values.out)}\n`);
}
