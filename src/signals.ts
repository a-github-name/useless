import type { Churn, Signals, Timing } from './types.js';

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

const LITERAL_START = /(['"`\d[{-]|true|false|null)/.source;

/** Opening line of a multi-line literal expectation, e.g. `expect(x).toEqual({`. */
const LARGE_LITERAL_OPEN =
  /(\.(toEqual|toStrictEqual|toMatchObject)\(|assert\.(deepEqual|deepStrictEqual)\([^\n]*,)\s*[[{]\s*$/;

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
    total += j - i + 1;
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
};

/**
 * Pure signal extraction: no filesystem, no git. Everything the scorer needs
 * comes in as text so the analysis is trivially testable.
 */
export function analyzeTest(input: AnalyzeInput): Signals {
  const { file, text, source, sourceText, churn, timing } = input;
  const lines = text.split('\n');

  // A test greps the repo when it really calls a read on a path-like
  // argument and names a source-like file somewhere (often via a helper), and
  // nothing suggests the files came from a tmpdir it wrote. `readFile: vi.fn()`
  // on a fake, or reading a JSON/YAML fixture, is not that.
  const readsRepoFiles =
    !/\b(mkdtemp|tmpdir|mkdtempSync)\b/.test(text) &&
    /\b(readFileSync|readdirSync|readFile|readdir)\s*\(\s*(join|resolve|path\.|fileURLToPath|new URL|process\.cwd|__dirname|import\.meta|['"`]|[A-Za-z_$][\w$.]*\s*[,)])/.test(
      text,
    ) &&
    /['"`][^'"`\n]*\.(tsx?|mjs|cjs|css|html|md|svelte|vue|astro)['"`]/.test(text);

  const functionCount = sourceText === null ? null : countFunctions(sourceText);
  const sourceLines = sourceText === null ? null : sourceText.split('\n').length;
  const dataSubject =
    /\/config\//.test(file) ||
    (functionCount !== null &&
      sourceLines !== null &&
      (functionCount === 0 || (functionCount <= 2 && sourceLines > 80)));

  const literal = measureLiteralBlocks(lines);
  const callExpects = count(text, /\.toHaveBeenCalled(Times|With|Once|ExactlyOnceWith)?\s*\(/g);
  const callExpectsWith = count(text, /\.toHaveBeenCalled(With|ExactlyOnceWith)\s*\(/g);
  const callExpectsCounted =
    count(text, /\.toHaveBeenCalled(Times|Once)\s*\(/g) +
    count(text, /\.not\.toHaveBeenCalled\s*\(/g);

  return {
    file,
    source,
    lines: lines.length,
    sourceLines,
    tests: count(
      text,
      /^\s*(it|test)(\.(each|skip|only|todo|concurrent|skipIf|runIf|fixme|fails))?(\([^)]*\))?\s*\(/gm,
    ),
    expects: count(text, /\bexpect(\.soft)?\s*\(/g) + count(text, /\bassert(\.\w+)?\s*\(/g),
    weakExpects:
      count(
        text,
        /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeInstanceOf|toBeTypeOf|toBeInTheDocument)\s*\(/g,
      ) +
      count(text, /typeof\s+[\w.]+\)\s*\.toBe\('/g) +
      count(text, /(?<!\.not)\.toHaveBeenCalled\s*\(/g) +
      count(text, /\.toBeGreaterThan(OrEqual)?\(\s*[01]\s*\)/g) +
      count(text, /\.not\.toBe(Undefined|Null)?\(\s*(undefined|null|''|""|0)?\s*\)/g) +
      count(text, /\bassert(\.ok)?\s*\(/g),
    callExpects,
    callExpectsWith,
    callExpectsCounted,
    sqlTextAsserts: count(
      text,
      /\.(toContain|toMatch)\(\s*['"`][^'"`\n]*\b(SELECT|UPDATE|INSERT|DELETE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|VALUES|json_set|json_extract)\b/g,
    ),
    mocks: count(text, /\b(vi|jest)\.(mock|doMock|fn|spyOn|stubGlobal|stubEnv|hoisted)\b/g),
    moduleMocks: count(text, /\b(vi|jest)\.(mock|doMock)\(/g),
    sourceTextAsserts:
      count(text, /readFileSync\([^)]*\.(ts|tsx|css|md|toml|mjs|html|yml|yaml)\b/g) +
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
    repoTextAsserts: readsRepoFiles
      ? count(text, /\.(not\.)?(toContain|toMatch|toEqual|toBe|toBeGreaterThan)\(/g)
      : 0,
    literalExpects:
      count(
        text,
        new RegExp(
          `\\.(toBe|toEqual|toStrictEqual|toHaveLength|toMatchObject|toBeCloseTo)\\(\\s*${LITERAL_START}`,
          'g',
        ),
      ) +
      count(
        text,
        new RegExp(
          `\\bassert\\.(equal|strictEqual|deepEqual|deepStrictEqual)\\([^\\n]*,\\s*${LITERAL_START}`,
          'g',
        ),
      ),
    dataSubject,
    fixtureImports: count(text, /from\s+['"][^'"]+\.json['"]/g),
    largeLiteralExpects: literal.blocks,
    literalLines: literal.lines,
    snapshotAsserts: count(text, /\.toMatch(File)?Snapshot\s*\(/g),
    inlineSnapshots: count(text, /\.toMatchInlineSnapshot\s*\(/g),
    digestPins: count(text, /['"`](sha256:)?[0-9a-f]{64}['"`]/g),
    countPins: count(text, /\.toHaveLength\((\d{2,}|[4-9])\)/g),
    deletedFileAsserts: count(text, /existsSync\([^)]*\)\)\s*\.toBe\(false\)/g),
    gatedSuites: count(text, /\b(describe|it|test)\.(runIf|skipIf)\(/g),
    gitShellouts: count(
      text,
      /(execFileSync|execSync|spawnSync|execa)\(\s*['"]git['"]|\bgit (log|rev-parse|show|diff|ls-files)\b|origin\/(main|master)/g,
    ),
    pythonShellouts: count(
      text,
      /(execFileSync|execSync|spawnSync|spawn|execa|exec)\(\s*['"](uv|python3?|pip3?|poetry)['"]|command:\s*['"](uv|python3?)['"]/g,
    ),
    realWaits: /useFakeTimers/.test(text)
      ? 0
      : count(text, /new Promise\([^)]*setTimeout|\bsleep\(\s*\d|setTimeout\(\s*(resolve|r)\b/g),
    machinePaths:
      /\b(mkdtemp|tmpdir|mkdtempSync)\b|HOME['"]?\s*[:=]|stubEnv\(\s*['"]HOME|mock\(\s*['"]node:os['"]/.test(
        text,
      )
        ? 0
        : count(text, /\bhomedir\(\)|process\.env\.HOME\b/g),
    skipped: count(text, /\b(it|test|describe)\.(skip|todo|fixme)\b/g),
    focused: count(text, /\b(it|test|describe)\.only\(/g),
    duplicateOf: input.duplicateOf ?? null,
    similarTo: input.similarTo ?? null,
    testCommits: churn.testCommits,
    sourceCommits: churn.sourceCommits,
    coChangeCommits: churn.coChangeCommits,
    durationMs: timing?.durationMs ?? null,
    failed: timing?.failed ?? false,
  };
}
