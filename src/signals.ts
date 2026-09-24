import { type Assertion, type Facts, derivedFrom } from './ast.js';
import { analyzeSwiftTest } from './swift.js';
import type { Churn, Signals, Timing, UnitSignals } from './types.js';

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$|Tests?\.swift$/;

const LITERAL_START = /(['"`\d[{-]|true|false|null)/.source;

/** ava / tap / node:test `t.*` assertions. */
const TAP_ASSERT_RE =
  /\bt\.(is|not|deepEqual|notDeepEqual|like|true|false|truthy|falsy|throws|notThrows|throwsAsync|notThrowsAsync|regex|notRegex|snapshot|pass|fail|assert|equal|notEqual|same|notSame|strictSame|ok|notOk|match|doesNotMatch|type|has|hasStrict|rejects|resolves|resolveMatch|error|emits|end|plan)\s*\(/g;

/** Opening line of a multi-line literal expectation, e.g. `expect(x).toEqual({`. */
const LARGE_LITERAL_OPEN =
  /(\.(toEqual|toStrictEqual|toMatchObject)\(|\.to(\.deep)?\.(equal|eql)\(|(assert\.(deepEqual|deepStrictEqual)|t\.(deepEqual|same|strictSame|like))\([^\n]*,)\s*[[{]\s*$/;

/**
 * Sum the lines occupied by multi-line literal expectations. Walks from each
 * opening line to the first line at or below its indentation that starts with
 * a closing bracket.
 */
export function measureLiteralBlocks(lines: string[]): { blocks: number; lines: number } {
  let blocks = 0;
  let total = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!LARGE_LITERAL_OPEN.test(line)) continue;
    blocks += 1;
    const indent = line.length - line.trimStart().length;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (!next.trim()) continue;
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= indent && /^[\]}]/.test(next.trim())) break;
    }
    total += Math.min(j, lines.length - 1) - i + 1;
    i = j;
  }
  return { blocks, lines: total };
}

/** Functions, arrows, and class/object method definitions. */
export function countFunctions(source: string): number {
  return (
    count(source, /\bfunction\b|=>/g) +
    count(
      source,
      /^\s+(?:(?:async|static|get|set|public|private|protected|override)\s+)*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{\s*$/gm,
    )
  );
}

export type AnalyzeInput = {
  file: string;
  text: string;
  source: string | null;
  sourceText: string | null;
  churn: Churn;
  timing: Timing | null;
  duplicateOf?: string | null;
  similarTo?: { file: string; share: number } | null;
  sourceFiles?: number | null;
  sharedHarness?: { lines: number; files: number } | null;
  /** Tree-sitter facts; when present they replace the string-sensitive regexes. */
  facts?: Facts | null;
  /** When analysing one test block: the whole file, for file-level flags (tmpdir, fake timers). */
  contextText?: string;
};

const SOURCE_LIKE_PATH = /\.(tsx?|mjs|cjs|css|html|md|toml|svelte|vue|astro)\b/;
const CODE_FILE_PATH = /\.(ts|tsx|css|md|toml|mjs|html)\b/;
const FIXTURE_PATH =
  /(^|[/'"`])(fixtures?|samples?|__fixtures__|cases|inputs?|snapshots?|dist|build|output|generated|out)([/'"`]|$)|\.(input|fixture|sample)\.|[Ff][Ii][Xx][Tt][Uu][Rr][Ee]|\b[Ii]nput\b|\b[Ss]ample\b/;
const READ_SUBJECT =
  /\b(readFileSync|readFile|readdirSync|readdir|readTextFile|readTextFileSync)\s*\(/;
const WEAK_MATCHERS = new Set([
  'toBeDefined',
  'toBeTruthy',
  'toBeFalsy',
  'toBeUndefined',
  'toBeInstanceOf',
  'toBeTypeOf',
  'toBeInTheDocument',
]);
const LITERAL_MATCHERS = new Set([
  'toBe',
  'toEqual',
  'toStrictEqual',
  'toHaveLength',
  'toMatchObject',
  'toBeCloseTo',
]);
const VALUE_MATCHERS = new Set([
  'toContain',
  'toMatch',
  'toMatchObject',
  'toEqual',
  'toBe',
  'toBeGreaterThan',
  'toStrictEqual',
  'toHaveLength',
]);
const SQL_RE =
  /\b(SELECT|UPDATE|INSERT|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|VALUES|json_set|json_extract)\b/;
const CODE_TOKEN_RE = /(import |export |function |const |=>|<\/|className|\.tsx?['"`])/;
const CODE_REGEX_RE = /^\/[^/]*(from \[|import|export|function|const)\b/;

type FactSignals = Pick<
  Signals,
  | 'tests'
  | 'callExpects'
  | 'callExpectsWith'
  | 'callExpectsCounted'
  | 'sqlTextAsserts'
  | 'mocks'
  | 'moduleMocks'
  | 'sourceTextAsserts'
  | 'repoTextAsserts'
  | 'snapshotAsserts'
  | 'inlineSnapshots'
  | 'skipped'
  | 'focused'
  | 'gatedSuites'
  | 'machineGates'
  | 'gitShellouts'
  | 'pythonShellouts'
  | 'deletedFileAsserts'
> & { readsRepoFiles: boolean; jestWeak: number; jestLiteral: number };

const EXEC_FNS = /^(execFileSync|execSync|spawnSync|spawn|execa|exec|execFile|\$)$/;
const MACHINE_GATE_RE = /existsSync|homedir|process\.env\.HOME|\/Users\/|\/home\/|LOCAL_|_LOCAL\b/;

/** Last segment of a matcher chain and whether it is negated. */
function matcherOf(a: Assertion): { name: string; negated: boolean } {
  const parts = a.matcher.split('.');
  return { name: parts[parts.length - 1] ?? '', negated: parts.includes('not') };
}

function isWeak(a: Assertion): boolean {
  const { name, negated } = matcherOf(a);
  if (negated) {
    return (
      (name === 'toBe' || name === 'toBeUndefined' || name === 'toBeNull') &&
      (a.literal === null || /^(undefined|null|''|""|0)$/.test(a.literal))
    );
  }
  if (WEAK_MATCHERS.has(name)) return true;
  if (name === 'toBe' && /^typeof\b/.test(a.subject) && a.literalKind === 'string') return true;
  if (name === 'toHaveBeenCalled') return true;
  if (/^toBeGreaterThan(OrEqual)?$/.test(name) && a.literal !== null && /^[01]$/.test(a.literal))
    return true;
  return false;
}

/** The string-sensitive signals, taken from the parse instead of the text. */
function factSignals(facts: Facts, text: string, tmpOrOutput: boolean): FactSignals {
  const calls = facts.assertions.filter((a) => /^toHaveBeenCalled/.test(matcherOf(a).name));
  const callExpectsWith = calls.filter((a) =>
    /^toHaveBeenCalled(With|ExactlyOnceWith)$/.test(matcherOf(a).name),
  ).length;
  const callExpectsCounted = calls.filter((a) => {
    const { name, negated } = matcherOf(a);
    return /^toHaveBeenCalled(Times|Once)$/.test(name) || (negated && name === 'toHaveBeenCalled');
  }).length;

  const repoReads = facts.reads.filter(
    (r) => SOURCE_LIKE_PATH.test(r.pathText) && !FIXTURE_PATH.test(r.pathText),
  );
  const readsRepoFiles = !tmpOrOutput && repoReads.length > 0;
  const readDerived = derivedFrom(facts, repoReads);
  const derived = (a: Assertion): boolean =>
    a.subjectIds.some((id) => readDerived.has(id)) ||
    READ_SUBJECT.test(a.subject) ||
    a.subjectIds.some((id) => facts.readerFns.has(id));
  const gates = facts.calls.filter((c) => /^(describe|it|test)\.(runIf|skipIf)$/.test(c.chain));
  const execs = facts.calls.filter((c) => EXEC_FNS.test(c.chain.split('.').pop() ?? ''));
  const gitShellouts = execs.filter(
    (c) =>
      c.firstLiteral === 'git' ||
      /^git (log|rev-parse|show|diff|ls-files|merge-base)\b/.test(c.firstLiteral ?? ''),
  ).length;
  const pythonShellouts = execs.filter((c) =>
    /^(uv|python3?|pip3?|poetry)$/.test(c.firstLiteral ?? ''),
  ).length;
  const repoAsserts = readsRepoFiles ? facts.assertions.filter(derived) : [];
  const codeTextAsserts = repoAsserts.filter((a) => {
    const { name } = matcherOf(a);
    if (name !== 'toContain' && name !== 'toMatch') return false;
    if (a.literalKind === 'string') return CODE_TOKEN_RE.test(a.literal ?? '');
    if (a.literalKind === 'regex') return CODE_REGEX_RE.test(a.literal ?? '');
    return false;
  }).length;

  const units = facts.units;
  return {
    tests: units.length,
    jestWeak: facts.assertions.filter(isWeak).length,
    jestLiteral: facts.assertions.filter(
      (a) => LITERAL_MATCHERS.has(matcherOf(a).name) && a.literalKind !== null,
    ).length,
    callExpects: calls.length,
    callExpectsWith,
    callExpectsCounted,
    sqlTextAsserts: facts.assertions.filter((a) => {
      const { name } = matcherOf(a);
      return (
        (name === 'toContain' || name === 'toMatch') &&
        a.literalKind === 'string' &&
        SQL_RE.test(a.literal ?? '')
      );
    }).length,
    mocks: facts.mockCalls.filter(({ name: m }) =>
      /^(mock|doMock|fn|spyOn|stubGlobal|stubEnv|hoisted)$/.test(m),
    ).length,
    moduleMocks: facts.mockCalls.filter(({ name: m }) => m === 'mock' || m === 'doMock').length,
    sourceTextAsserts: readsRepoFiles
      ? repoReads.filter((r) => CODE_FILE_PATH.test(r.pathText)).length + codeTextAsserts
      : 0,
    repoTextAsserts: repoAsserts.filter((a) => VALUE_MATCHERS.has(matcherOf(a).name)).length,
    snapshotAsserts: facts.assertions.filter((a) =>
      /^toMatch(File)?Snapshot$/.test(matcherOf(a).name),
    ).length,
    inlineSnapshots: facts.assertions.filter((a) => matcherOf(a).name === 'toMatchInlineSnapshot')
      .length,
    skipped:
      units.filter((u) => u.modifiers.some((m) => /^(skip|todo|fixme)$/.test(m))).length +
      count(text, /\bdescribe\.(skip|todo|fixme)\b/g),
    focused:
      units.filter((u) => u.modifiers.includes('only')).length + count(text, /\bdescribe\.only\(/g),
    gatedSuites: gates.length,
    machineGates: gates.filter((c) => MACHINE_GATE_RE.test(c.argsText)).length,
    gitShellouts,
    pythonShellouts,
    deletedFileAsserts: facts.assertions.filter(
      (a) => /existsSync\s*\(/.test(a.subject) && a.matcher === 'toBe' && a.literal === 'false',
    ).length,
    readsRepoFiles,
  };
}

/**
 * Pure signal extraction: no filesystem, no git. Everything the scorer needs
 * comes in as text so the analysis is trivially testable.
 */
export function analyzeTest(input: AnalyzeInput): Signals {
  if (/\.swift$/.test(input.file)) return analyzeSwiftTest(input);
  const { file, text, source, sourceText, churn, timing } = input;
  const lines = text.split('\n');
  const facts = input.facts ?? null;
  const ctx = input.contextText ?? text;

  // A test greps the repo when it really calls a read on a path-like
  // argument and names a source-like file somewhere (often via a helper), and
  // nothing suggests the files came from a tmpdir it wrote. `readFile: vi.fn()`
  // on a fake, or reading a JSON/YAML fixture, is not that.
  // The test builds something and reads the result back: a generator or
  // bundler test, not a grep over the repo. Needs write/remove calls or a
  // path string that ends in a build directory.
  const producesOutput =
    /\b(writeFile|writeFileSync|mkdir|mkdirSync|rmSync|rimraf|copyFile|copyFileSync|outDir|outputDir)\b/.test(
      ctx,
    ) ||
    /['"`][^'"`\n]*\/(dist|build|output|generated|\.svelte-kit|\.next|out)(\/|['"`])/.test(ctx) ||
    /\$\{(dist|build|output|outDir|outputDir)\}\//.test(ctx);
  // Reading from a fixtures/samples/cases directory, an Input.* file, or a
  // FIXTURE constant is test input, not source.
  const readsFixtures =
    /['"`][^'"`\n]*(^|\/)(fixtures?|samples?|__fixtures__|cases|inputs?|snapshots?)\//.test(text) ||
    /['"`]([^'"`\n]*\/)?([Ii]nput|[Ss]ample|[Ff]ixture)[^'"`\n]*\.\w+['"`]|\.(input|fixture|sample)\.\w+['"`]/.test(
      text,
    ) ||
    /\b(readFileSync|readFile)\s*\(\s*[\w$.]*[Ff][Ii][Xx][Tt][Uu][Rr][Ee]/.test(text);
  const tmpOrOutput = /\b(mkdtemp|tmpdir|mkdtempSync)\b/.test(ctx) || producesOutput;
  const fromFacts = facts ? factSignals(facts, text, tmpOrOutput) : null;
  const readsRepoFiles = fromFacts
    ? fromFacts.readsRepoFiles
    : !/\b(mkdtemp|tmpdir|mkdtempSync)\b/.test(text) &&
      !producesOutput &&
      !readsFixtures &&
      /(?<![\w$.])(?:(?:fs|fsp|fsPromises|promises)\.)?(readFileSync|readdirSync|readFile|readdir)\s*\(\s*(join|resolve|path\.|fileURLToPath|new URL|process\.cwd|__dirname|import\.meta|['"`]|[A-Za-z_$][\w$.]*\s*[,)])/.test(
        text,
      ) &&
      /['"`][^'"`\n]*\.(tsx?|mjs|cjs|css|html|md|svelte|vue|astro)['"`]/.test(
        text.replace(/^\s*(import\b[^\n]*|export\b[^\n]*\bfrom\b[^\n]*)$/gm, ''),
      );

  const functionCount = sourceText === null ? null : countFunctions(sourceText);
  const sourceLines = sourceText === null ? null : sourceText.split('\n').length;
  // A barrel of re-exports has no functions but is not data either.
  const barrel =
    sourceText !== null && count(sourceText, /^export\s+(\*|\{[^}]*\})\s+from\b/gm) >= 3;
  const dataSubject =
    /\/config\//.test(file) ||
    (!barrel &&
      functionCount !== null &&
      sourceLines !== null &&
      (functionCount === 0 || (functionCount <= 2 && sourceLines > 80)));

  const literal = measureLiteralBlocks(lines);
  const callExpects =
    fromFacts?.callExpects ??
    count(text, /\.toHaveBeenCalled(Times|With|Once|ExactlyOnceWith)?\s*\(/g);
  const callExpectsWith =
    fromFacts?.callExpectsWith ?? count(text, /\.toHaveBeenCalled(With|ExactlyOnceWith)\s*\(/g);
  const callExpectsCounted =
    fromFacts?.callExpectsCounted ??
    count(text, /\.toHaveBeenCalled(Times|Once)\s*\(/g) +
      count(text, /\.not\.toHaveBeenCalled\s*\(/g);
  const regexTests = count(
    text,
    /^\s*(Deno\.test|it|test)(\.(each|skip|only|todo|concurrent|serial|skipIf|runIf|fixme|fails))?(\([^)]*\))?\s*\(/gm,
  );
  const jestWeak =
    fromFacts?.jestWeak ??
    count(
      text,
      /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeInstanceOf|toBeTypeOf|toBeInTheDocument)\s*\(/g,
    ) +
      count(text, /typeof\s+[\w.]+\)\s*\.toBe\('/g) +
      count(text, /(?<!\.not)\.toHaveBeenCalled\s*\(/g) +
      count(text, /\.toBeGreaterThan(OrEqual)?\(\s*[01]\s*\)/g) +
      count(text, /\.not\.toBe(Undefined|Null)?\(\s*(undefined|null|''|""|0)?\s*\)/g);
  const jestLiteral =
    fromFacts?.jestLiteral ??
    count(
      text,
      new RegExp(
        `\\.(toBe|toEqual|toStrictEqual|toHaveLength|toMatchObject|toBeCloseTo)\\(\\s*${LITERAL_START}`,
        'g',
      ),
    );

  return {
    file,
    source,
    lines: lines.length,
    sourceLines,
    sourceFiles: sourceText === null ? null : (input.sourceFiles ?? 1),
    // A parse that finds no test blocks falls back to the regex: some table
    // forms build titles dynamically.
    tests: fromFacts?.tests || regexTests,
    expects:
      count(text, /\bexpect(\.soft)?\s*\(/g) +
      count(text, /\bassert(\.\w+)?\s*\(/g) +
      count(text, TAP_ASSERT_RE),
    weakExpects:
      jestWeak +
      count(text, /\bassert(\.ok)?\s*\(/g) +
      count(text, /\bt\.(ok|truthy|true|pass|notOk|falsy)\s*\(/g) +
      count(
        text,
        /\.to(\.not)?\.(exist|be\.ok|be\.true|be\.truthy|be\.undefined|be\.defined|be\.a\(|be\.an\(|be\.instanceOf|be\.instanceof)/g,
      ),
    callExpects,
    callExpectsWith,
    callExpectsCounted,
    sqlTextAsserts:
      fromFacts?.sqlTextAsserts ??
      count(
        text,
        /\.(toContain|toMatch)\(\s*['"`][^'"`\n]*\b(SELECT|UPDATE|INSERT|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|VALUES|json_set|json_extract)\b/g,
      ),
    mocks:
      fromFacts?.mocks ??
      count(text, /\b(vi|jest)\.(mock|doMock|fn|spyOn|stubGlobal|stubEnv|hoisted)\b/g),
    moduleMocks: fromFacts?.moduleMocks ?? count(text, /\b(vi|jest)\.(mock|doMock)\(/g),
    sourceTextAsserts: fromFacts
      ? fromFacts.sourceTextAsserts
      : (readsRepoFiles
          ? count(text, /readFileSync\([^)]*\.(ts|tsx|css|md|toml|mjs|html)\b/g)
          : 0) +
        (readsRepoFiles
          ? count(
              text,
              /\.toContain\(\s*['"`][^'"`]*(import |export |function |const |=>|<\/|className|\.tsx?['"`])/g,
            ) +
            count(
              text,
              /\.(toMatch|not\.toMatch)\(\s*\/[^/]*(from \[|import|export|function|const)\b/g,
            )
          : 0),
    repoTextAsserts: fromFacts
      ? fromFacts.repoTextAsserts
      : readsRepoFiles
        ? count(text, /\.(not\.)?(toContain|toMatch|toMatchObject|toEqual|toBe|toBeGreaterThan)\(/g)
        : 0,
    literalExpects:
      jestLiteral +
      count(
        text,
        new RegExp(
          `\\bassert\\.(equal|strictEqual|deepEqual|deepStrictEqual)\\([^\\n]*,\\s*${LITERAL_START}`,
          'g',
        ),
      ) +
      count(
        text,
        new RegExp(
          `\\bt\\.(is|equal|same|strictSame|deepEqual|like)\\([^\\n]*,\\s*${LITERAL_START}`,
          'g',
        ),
      ) +
      count(
        text,
        new RegExp(`\\.to(\\.deep)?\\.(equal|eql|have\\.length(Of)?)\\(\\s*${LITERAL_START}`, 'g'),
      ),
    dataSubject,
    fixtureImports: count(text, /from\s+['"][^'"]+\.json['"]/g),
    largeLiteralExpects: literal.blocks,
    literalLines: literal.lines,
    snapshotAsserts:
      (fromFacts?.snapshotAsserts ?? count(text, /\.toMatch(File)?Snapshot\s*\(/g)) +
      count(text, /\bt\.(snapshot|matchSnapshot)\s*\(/g),
    inlineSnapshots: fromFacts?.inlineSnapshots ?? count(text, /\.toMatchInlineSnapshot\s*\(/g),
    digestPins: count(text, /['"`](sha256:)?[0-9a-f]{64}['"`]/g),
    countPins: count(text, /\.toHaveLength\((\d{2,}|[4-9])\)/g),
    deletedFileAsserts:
      fromFacts?.deletedFileAsserts ?? count(text, /existsSync\([^)]*\)\)\s*\.toBe\(false\)/g),
    gatedSuites: fromFacts?.gatedSuites ?? count(text, /\b(describe|it|test)\.(runIf|skipIf)\(/g),
    dependencyGates: 0,
    machineGates:
      fromFacts?.machineGates ??
      count(
        text,
        /\b(describe|it|test)\.(runIf|skipIf)\([^)\n]*(existsSync|homedir|process\.env\.HOME|\/Users\/|\/home\/|LOCAL_|_LOCAL\b)/g,
      ),
    gitShellouts:
      fromFacts?.gitShellouts ??
      count(
        text,
        /(execFileSync|execSync|spawnSync|execa)\(\s*['"]git['"]|['"`]git (log|rev-parse|show|diff|ls-files|merge-base)\b/g,
      ),
    pythonShellouts:
      fromFacts?.pythonShellouts ??
      count(
        text,
        /(execFileSync|execSync|spawnSync|spawn|execa|exec)\(\s*['"](uv|python3?|pip3?|poetry)['"]|command:\s*['"](uv|python3?)['"]/g,
      ),
    realWaits: /useFakeTimers/.test(ctx)
      ? 0
      : count(text, /new Promise\([^)]*setTimeout|\bsleep\(\s*\d|setTimeout\(\s*(resolve|r)\b/g),
    machinePaths:
      /\b(mkdtemp|tmpdir|mkdtempSync)\b|HOME['"]?\s*[:=]|stubEnv\(\s*['"]HOME|mock\(\s*['"]node:os['"]/.test(
        ctx,
      )
        ? 0
        : count(text, /\bhomedir\(\)|process\.env\.HOME\b/g),
    skipped: fromFacts?.skipped ?? count(text, /\b(it|test|describe)\.(skip|todo|fixme)\b/g),
    focused: fromFacts?.focused ?? count(text, /\b(it|test|describe)\.only\(/g),
    duplicateOf: input.duplicateOf ?? null,
    similarTo: input.similarTo ?? null,
    sharedHarnessLines: input.sharedHarness?.lines ?? 0,
    sharedHarnessFiles: input.sharedHarness?.files ?? 0,
    testCommits: churn.testCommits,
    sourceCommits: churn.sourceCommits,
    coChangeCommits: churn.coChangeCommits,
    durationMs: timing?.durationMs ?? null,
    failed: timing?.failed ?? false,
  };
}

/**
 * Analyse each `it`/`test` block on its own. The block's text carries its
 * assertions and local mocks; the file supplies the context that cannot be
 * seen from inside a block: module mocks, tmpdir setup, fake timers, suite
 * gates, and the source module. Units get no duplicate or timing data.
 */
export function analyzeUnits(input: AnalyzeInput, fileSignals: Signals): UnitSignals[] {
  const facts = input.facts;
  if (!facts) return [];
  const within = (start: number, unit: { startIndex: number; endIndex: number }): boolean =>
    start >= unit.startIndex && start < unit.endIndex;
  return facts.units.map((unit) => {
    const text = input.text.slice(unit.startIndex, unit.endIndex);
    const shift = (n: number): number => n - unit.startIndex;
    const local: Facts = {
      ...facts,
      units: [{ ...unit, startIndex: 0, endIndex: text.length }],
      assertions: facts.assertions
        .filter((a) => within(a.startIndex, unit))
        .map((a) => ({ ...a, startIndex: shift(a.startIndex) })),
      mockCalls: facts.mockCalls
        .filter((m) => within(m.startIndex, unit))
        .map((m) => ({ ...m, startIndex: shift(m.startIndex) })),
      calls: facts.calls
        .filter((c) => within(c.startIndex, unit))
        .map((c) => ({ ...c, startIndex: shift(c.startIndex) })),
    };
    const { units: _units, ...own } = analyzeTest({
      ...input,
      text,
      facts: local,
      contextText: input.text,
      duplicateOf: null,
      similarTo: null,
      sharedHarness: null,
      timing: null,
    });
    return {
      ...own,
      name: unit.name,
      fullName: unit.fullName,
      line: unit.startLine,
      endLine: unit.endLine,
      tests: 1,
      moduleMocks: fileSignals.moduleMocks,
      mocks: own.mocks + fileSignals.moduleMocks,
      gatedSuites: Math.max(own.gatedSuites, fileSignals.gatedSuites > 0 ? 1 : 0),
      machineGates: Math.max(own.machineGates, fileSignals.machineGates > 0 ? 1 : 0),
    };
  });
}
