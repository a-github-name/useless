import type { Churn, Signals, Timing } from './types.js';

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

export const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/;

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
  // The test builds something and reads the result back: a generator or
  // bundler test, not a grep over the repo. Needs write/remove calls or a
  // path string that ends in a build directory.
  const producesOutput =
    /\b(writeFile|writeFileSync|mkdir|mkdirSync|rmSync|rimraf|copyFile|copyFileSync|outDir|outputDir)\b/.test(
      text,
    ) ||
    /['"`][^'"`\n]*\/(dist|build|output|generated|\.svelte-kit|\.next|out)(\/|['"`])/.test(text) ||
    /\$\{(dist|build|output|outDir|outputDir)\}\//.test(text);
  // Reading from a fixtures/samples/cases directory, an Input.* file, or a
  // FIXTURE constant is test input, not source.
  const readsFixtures =
    /['"`][^'"`\n]*(^|\/)(fixtures?|samples?|__fixtures__|cases|inputs?|snapshots?)\//.test(text) ||
    /['"`]([^'"`\n]*\/)?([Ii]nput|[Ss]ample|[Ff]ixture)[^'"`\n]*\.\w+['"`]|\.(input|fixture|sample)\.\w+['"`]/.test(
      text,
    ) ||
    /\b(readFileSync|readFile)\s*\(\s*[\w$.]*[Ff][Ii][Xx][Tt][Uu][Rr][Ee]/.test(text);
  const readsRepoFiles =
    !/\b(mkdtemp|tmpdir|mkdtempSync)\b/.test(text) &&
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
      /^\s*(Deno\.test|it|test)(\.(each|skip|only|todo|concurrent|serial|skipIf|runIf|fixme|fails))?(\([^)]*\))?\s*\(/gm,
    ),
    expects:
      count(text, /\bexpect(\.soft)?\s*\(/g) +
      count(text, /\bassert(\.\w+)?\s*\(/g) +
      count(text, TAP_ASSERT_RE),
    weakExpects:
      count(
        text,
        /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeUndefined|toBeInstanceOf|toBeTypeOf|toBeInTheDocument)\s*\(/g,
      ) +
      count(text, /typeof\s+[\w.]+\)\s*\.toBe\('/g) +
      count(text, /(?<!\.not)\.toHaveBeenCalled\s*\(/g) +
      count(text, /\.toBeGreaterThan(OrEqual)?\(\s*[01]\s*\)/g) +
      count(text, /\.not\.toBe(Undefined|Null)?\(\s*(undefined|null|''|""|0)?\s*\)/g) +
      count(text, /\bassert(\.ok)?\s*\(/g) +
      count(text, /\bt\.(ok|truthy|true|pass|notOk|falsy)\s*\(/g) +
      count(
        text,
        /\.to(\.not)?\.(exist|be\.ok|be\.true|be\.truthy|be\.undefined|be\.defined|be\.a\(|be\.an\(|be\.instanceOf|be\.instanceof)/g,
      ),
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
      (readsRepoFiles ? count(text, /readFileSync\([^)]*\.(ts|tsx|css|md|toml|mjs|html)\b/g) : 0) +
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
      ? count(text, /\.(not\.)?(toContain|toMatch|toMatchObject|toEqual|toBe|toBeGreaterThan)\(/g)
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
    snapshotAsserts: count(
      text,
      /\.toMatch(File)?Snapshot\s*\(|\bt\.(snapshot|matchSnapshot)\s*\(/g,
    ),
    inlineSnapshots: count(text, /\.toMatchInlineSnapshot\s*\(/g),
    digestPins: count(text, /['"`](sha256:)?[0-9a-f]{64}['"`]/g),
    countPins: count(text, /\.toHaveLength\((\d{2,}|[4-9])\)/g),
    deletedFileAsserts: count(text, /existsSync\([^)]*\)\)\s*\.toBe\(false\)/g),
    gatedSuites: count(text, /\b(describe|it|test)\.(runIf|skipIf)\(/g),
    machineGates: count(
      text,
      /\b(describe|it|test)\.(runIf|skipIf)\([^)\n]*(existsSync|homedir|process\.env\.HOME|\/Users\/|\/home\/|LOCAL_|_LOCAL\b)/g,
    ),
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
