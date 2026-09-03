import type { Churn, Signals, Timing } from './types.js';

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

export type AnalyzeInput = {
  file: string;
  text: string;
  source: string | null;
  sourceText: string | null;
  churn: Churn;
  timing: Timing | null;
};

/**
 * Pure signal extraction: no filesystem, no git. Everything the scorer needs
 * comes in as text so the analysis is trivially testable.
 */
export function analyzeTest(input: AnalyzeInput): Signals {
  const { file, text, source, sourceText, churn, timing } = input;

  // Reading repo files is only a smell when the file read is source-like
  // (code, styles, docs). Reading a JSON fixture as *input* is fine.
  const readsRepoFiles =
    /\b(readFileSync|readFile|readdirSync|readdir)\b/.test(text) &&
    !/\b(mkdtemp|tmpdir|mkdtempSync)\b/.test(text) &&
    /['"][^'"\n]+\.(tsx?|css|mjs|cjs|html|md)['"]/.test(text);

  const dataSubject =
    /\/config\//.test(file) ||
    /from\s+['"][^'"]+\.json['"]/.test(text) ||
    /readFile(Sync)?\([^)]*\.json['"]/.test(text) ||
    (sourceText !== null && count(sourceText, /\bfunction\b|=>/g) < 3);

  return {
    file,
    source,
    lines: text.split('\n').length,
    sourceLines: sourceText === null ? null : sourceText.split('\n').length,
    tests: count(
      text,
      /^\s*(it|test)(\.(each|skip|only|todo|concurrent|skipIf|runIf|fixme|fails))?(\([^)]*\))?\s*\(/gm,
    ),
    expects: count(text, /\bexpect(\.soft)?\s*\(/g),
    weakExpects:
      count(
        text,
        /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeInstanceOf|toBeTypeOf|toHaveBeenCalled|toBeInTheDocument|not\.toBeNull|not\.toBeUndefined)\s*\(/g,
      ) + count(text, /typeof\s+[\w.]+\)\s*\.toBe\('/g),
    callExpects: count(text, /\.toHaveBeenCalled(Times|With|Once|ExactlyOnceWith)?\s*\(/g),
    mocks: count(text, /\b(vi|jest)\.(mock|doMock|fn|spyOn|stubGlobal|stubEnv|hoisted)\b/g),
    moduleMocks: count(text, /\b(vi|jest)\.(mock|doMock)\(/g),
    sourceTextAsserts:
      count(text, /readFileSync\([^)]*\.(ts|tsx|css|md|toml|mjs|html|yml|yaml)\b/g) +
      count(
        text,
        /\.toContain\(\s*['"`][^'"`]*(import |export |function |const |=>|<\/|className|\.tsx?['"`])/g,
      ) +
      count(text, /\.(toMatch|not\.toMatch)\(\s*\/[^/]*(from \[|import|export|function|const)\b/g),
    repoTextAsserts: readsRepoFiles
      ? count(text, /\.(not\.)?(toContain|toMatch|toEqual|toBe|toBeGreaterThan)\(/g)
      : 0,
    literalExpects: count(
      text,
      /\.(toBe|toEqual|toStrictEqual|toHaveLength|toMatchObject|toBeCloseTo)\(\s*(['"`\d[{-]|true|false|null)/g,
    ),
    dataSubject,
    fixtureImports: count(text, /from\s+['"][^'"]+\.json['"]/g),
    largeLiteralExpects: count(text, /\.(toEqual|toStrictEqual|toMatchObject)\(\s*[[{]\s*$/gm),
    digestPins: count(text, /['"`](sha256:)?[0-9a-f]{64}['"`]/g),
    countPins: count(text, /\.toHaveLength\((\d{2,}|[4-9])\)/g),
    deletedFileAsserts: count(text, /existsSync\([^)]*\)\)\s*\.toBe\(false\)/g),
    gatedSuites: count(text, /\b(describe|it|test)\.(runIf|skipIf)\(/g),
    gitShellouts: count(
      text,
      /(execFileSync|execSync|spawnSync|execa)\(\s*['"]git['"]|\bgit (log|rev-parse|show|diff|ls-files)\b|origin\/(main|master)/g,
    ),
    pythonShellouts: count(text, /['"](uv|python3?)['"]|\.py['"]/g),
    skipped: count(text, /\b(it|test|describe)\.(skip|todo|fixme)\b/g),
    testCommits: churn.testCommits,
    sourceCommits: churn.sourceCommits,
    coChangeCommits: churn.coChangeCommits,
    durationMs: timing?.durationMs ?? null,
    failed: timing?.failed ?? false,
  };
}
