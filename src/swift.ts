import type { AnalyzeInput } from './signals.js';
import type { Signals, UnitSignals } from './types.js';

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

export const SWIFT_TEST_FILE_RE = /Tests?\.swift$/;

/** A literal in second-argument position: string, number, array, enum case, bool, nil, raw string. */
const LITERAL = /(?:"|-?\d|\[|\.[a-z]\w*|true|false|nil|#")/.source;

/** `XCTAssertEqual(x, [` on one line: the walker in `measureSwiftLiteralBlocks` handles the split form. */
const INLINE_OPEN = /\bXCTAssert(?:Equal|NotEqual)\([^\n]*,\s*\[\s*$|#expect\([^\n]*==\s*\[\s*$/;
/** `XCTAssertEqual(` alone on a line, with the arguments on the lines that follow. */
const SPLIT_OPEN = /^\s*XCTAssert(?:Equal|NotEqual)\(\s*$/;

/**
 * Lines occupied by multi-line literal expectations, in both Swift shapes:
 * `XCTAssertEqual(x, [` ... `])` and the split call whose second argument
 * starts on its own line with `[`, `"""`, or a struct initialiser and runs
 * for two or more lines.
 */
export function measureSwiftLiteralBlocks(lines: string[]): { blocks: number; lines: number } {
  let blocks = 0;
  let total = 0;
  const indentOf = (line: string): number => line.length - line.trimStart().length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const indent = indentOf(line);
    if (INLINE_OPEN.test(line)) {
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (!next.trim()) continue;
        if (indentOf(next) <= indent && /^[\])}]/.test(next.trim())) break;
      }
      blocks += 1;
      total += Math.min(j, lines.length - 1) - i + 1;
      i = j;
      continue;
    }
    if (!SPLIT_OPEN.test(line)) continue;
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (next.trim() && indentOf(next) <= indent && /^\)/.test(next.trim())) break;
    }
    const second = (lines[i + 2] ?? '').trim();
    const literalLines = j - (i + 2);
    if (
      j < lines.length &&
      literalLines >= 2 &&
      /^(\[|"|#"|\.[a-z]|-?\d|true|false|[A-Z]\w*\()/.test(second)
    ) {
      blocks += 1;
      total += j - i + 1;
    }
    i = j;
  }
  return { blocks, lines: total };
}

/** `func`, `init`, and closures with an explicit `in`. */
export function countSwiftFunctions(source: string): number {
  return (
    count(source, /\bfunc\b/g) +
    count(source, /\binit\s*\(/g) +
    count(source, /\{\s*(?:\([^)\n]*\)|[\w\s,]+?)\s*(?:->\s*[^\n{]+)?\s+in\b/g)
  );
}

/** A hard-coded developer path: the test can only pass on one machine. */
const MACHINE_GATE_RE = /\/Users\/|\/home\//;
/** Hardware, an external binary, model files (often under the home directory), or an environment opt-in. */
const DEPENDENCY_GATE_RE =
  /deviceType|defaultDevice|Executable|ffmpeg|ffprobe|fileExists|environment\[|\benv\[|ProcessInfo|NSHomeDirectory|homeDirectoryForCurrentUser|_ROOT|_PATH|_DIR\b|MODEL|CHECKPOINT|FIXTURE/;

/**
 * Classify every conditional skip. `XCTSkipIf`/`XCTSkipUnless` carry their
 * condition as an argument; `throw XCTSkip` sits inside a `guard ... else`,
 * so the condition is on the lines just above it. A `throw XCTSkip` as the
 * first statement of a test is an unconditional skip.
 */
export function classifySwiftGates(lines: string[]): {
  gated: number;
  skipped: number;
  machine: number;
  dependency: number;
} {
  const result = { gated: 0, skipped: 0, machine: 0, dependency: 0 };
  const classify = (context: string): void => {
    result.gated += 1;
    if (MACHINE_GATE_RE.test(context)) result.machine += 1;
    if (DEPENDENCY_GATE_RE.test(context)) result.dependency += 1;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/\bXCTSkip(?:If|Unless)\s*\(/.test(line)) {
      classify(lines.slice(i, i + 3).join('\n'));
      continue;
    }
    if (/\bthrow\s+XCTSkip\s*\(/.test(line)) {
      let k = i - 1;
      while (k >= 0 && !(lines[k] ?? '').trim()) k -= 1;
      if (/\bfunc\s+test\w*\s*\(|@Test\b/.test(lines[k] ?? '')) {
        result.skipped += 1;
        continue;
      }
      classify(lines.slice(Math.max(0, i - 4), i + 1).join('\n'));
      continue;
    }
    if (/\.enabled\(if:/.test(line)) classify(line);
  }
  return result;
}

/**
 * Signals for an XCTest or Swift Testing file. Same shape as the JS
 * analysis; the JS-only fields (module mocks, snapshots) are usually zero.
 */
export function analyzeSwiftTest(input: AnalyzeInput): Signals {
  const { file, text, source, sourceText, churn, timing } = input;
  const lines = text.split('\n');

  const readsFiles =
    /\b(?:contentsOfFile:|contentsOf:|contents\(atPath:|contentsOfDirectory\(at(?:Path)?:)/.test(
      text,
    );
  const namesSource =
    /"[^"\n]*\.(?:swift|md|sh|metal|plist|yml|yaml|toml|h|c|cpp|mm)"|"Package\.swift"|"Info\.plist"/.test(
      text,
    );
  // `URL(fileURLWithPath: #filePath)` walks up from the test to the repo.
  const locatesRepo = /fileURLWithPath:\s*#file(?:Path|ID)?\b/.test(text);
  const usesTmp = /temporaryDirectory|NSTemporaryDirectory|mkdtemp/.test(text);
  const producesOutput =
    /\.write\((?:to|toFile):|createFile\(atPath|createDirectory\(|removeItem\(|copyItem\(|moveItem\(|outputURL|outputDirectory/.test(
      text,
    );
  const readsFixtures =
    /"(?:[^"\n]*\/)?(?:[Ff]ixtures?|Resources|[Ss]amples?|__fixtures__)\//.test(text) ||
    /Bundle\.module/.test(text);
  const readsRepoFiles =
    readsFiles && namesSource && !readsFixtures && (locatesRepo || (!usesTmp && !producesOutput));

  const functionCount = sourceText === null ? null : countSwiftFunctions(sourceText);
  const sourceLines = sourceText === null ? null : sourceText.split('\n').length;
  const dataSubject =
    /\/(?:config|Resources)\//.test(file) ||
    (functionCount !== null &&
      sourceLines !== null &&
      (functionCount === 0 || (functionCount <= 2 && sourceLines > 80)));

  const literal = measureSwiftLiteralBlocks(lines);
  const gates = classifySwiftGates(lines);

  // Assertions over a hand-rolled recorder: `calls.count`, `recordedRequests`.
  const CALL_MEMBER =
    /\b(?:calls|callCount|invocations|invocationCount|recorded(?:Calls|Requests|Commands|Arguments|Invocations|Paths|Messages|Prompts)|wasCalled|didCall|receivedCalls|callArguments|captured(?:Requests|Commands|Arguments|Calls))\b/;
  const assertions = text.match(/(?:\bXCTAssert\w*|#expect)\s*\([^\n]*/g) ?? [];
  const callAsserts = assertions.filter((a) => CALL_MEMBER.test(a));
  const callExpectsCounted = callAsserts.filter((a) =>
    /\.count\b|callCount|invocationCount|wasCalled|didCall/.test(a),
  ).length;
  const callExpects = callAsserts.length;

  const skippedNamed = count(
    text,
    /\bfunc\s+(?:x_?test|skip_?test|disabled_?test|DISABLED_test)\w*/gi,
  );

  return {
    file,
    source,
    lines: lines.length,
    sourceLines,
    sourceFiles: sourceText === null ? null : (input.sourceFiles ?? 1),
    tests:
      count(text, /^\s*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:override\s+)?func\s+test\w*\s*\(/gm) +
      count(text, /@Test\b/g),
    expects:
      count(text, /\bXCTAssert\w*\s*\(/g) +
      count(text, /\bXCTFail\s*\(/g) +
      count(text, /#expect\s*\(/g),
    weakExpects:
      count(text, /\bXCTAssertNotNil\s*\(/g) +
      count(
        text,
        /\bXCTAssertTrue\s*\(\s*(?:true|!\s*[\w.?()]*\.isEmpty|[\w.?()]*\s*!=\s*nil|[\w.?()]*\s+is\s+\w+)\s*\)/g,
      ) +
      count(text, /\bXCTAssertFalse\s*\(\s*[\w.?()]*\.isEmpty\s*\)/g) +
      count(text, /\bXCTAssertGreaterThan(?:OrEqual)?\s*\([^,\n]*,\s*[01]\s*\)/g) +
      count(text, /\bXCTAssertNotEqual\s*\([^,\n]*,\s*(?:""|0|\[\]|\[:\]|nil)\s*\)/g) +
      count(
        text,
        /#expect\s*\(\s*(?:!\s*[\w.?()]*\.isEmpty|[\w.?()]*\s*!=\s*nil|[\w.?()]*\.count\s*>\s*0|[\w.?()]*\.isEmpty\s*==\s*false)\s*\)/g,
      ),
    callExpects,
    callExpectsWith: callExpects - callExpectsCounted,
    callExpectsCounted,
    sqlTextAsserts: count(
      text,
      /(?:\bXCTAssert\w*|#expect)\s*\([^\n]*"[^"\n]*\b(?:SELECT|UPDATE|INSERT|DELETE|CREATE TABLE|FROM|WHERE|JOIN|GROUP BY|ORDER BY|VALUES)\b/g,
    ),
    mocks:
      count(
        text,
        /\b(?:final\s+)?(?:class|struct|actor)\s+(?:Mock|Fake|Stub|Spy|Recording|Capturing)\w*/g,
      ) + count(text, /\b(?:Mock|Fake|Stub|Spy|Recording)[A-Z]\w*\s*\(/g),
    // Swizzling and URLProtocol registration replace behaviour process-wide,
    // the nearest thing Swift has to a module mock.
    moduleMocks: count(text, /\bmethod_exchangeImplementations\b|URLProtocol\.registerClass\(/g),
    sourceTextAsserts: readsRepoFiles
      ? count(text, /contentsOf[^\n]*\.(?:swift|metal|sh)"/g) +
        count(
          text,
          /(?:\bXCTAssert(?:True|False)|#expect)\s*\([^\n]*contains\("(?:import |func |struct |class |enum |let |var |static |public |#!\/|set -|\$\()/g,
        )
      : 0,
    repoTextAsserts: readsRepoFiles
      ? count(
          text,
          /\bXCTAssert(?:True|False)\s*\([^\n]*\.(?:contains|hasPrefix|hasSuffix|range\(of|starts\(with)/g,
        ) +
        count(text, /\bXCTAssert(?:Equal|NotEqual)\s*\(/g) +
        count(text, /#expect\s*\(/g)
      : 0,
    literalExpects:
      count(
        text,
        new RegExp(`\\bXCTAssertEqual\\(\\s*(?:${LITERAL}|[^,\\n]*,\\s*${LITERAL})`, 'g'),
      ) + count(text, new RegExp(`#expect\\([^\\n]*==\\s*${LITERAL}`, 'g')),
    dataSubject,
    fixtureImports: count(text, /Bundle\.module/g),
    largeLiteralExpects: literal.blocks,
    literalLines: literal.lines,
    snapshotAsserts: count(text, /\bassertSnapshot\s*\(/g),
    inlineSnapshots: count(text, /\bassertInlineSnapshot\s*\(/g),
    digestPins: count(text, /["'](sha256:)?[0-9a-f]{64}["']/g),
    countPins:
      count(text, /\bXCTAssertEqual\(\s*[^,\n]*\.count,\s*(?:\d{2,}|[4-9])\s*\)/g) +
      count(text, /#expect\([^\n]*\.count\s*==\s*(?:\d{2,}|[4-9])\s*\)/g),
    deletedFileAsserts:
      count(text, /\bXCTAssertFalse\s*\([^\n]*fileExists\(atPath/g) +
      count(text, /#expect\s*\(\s*![^\n]*fileExists\(atPath/g),
    gatedSuites: gates.gated,
    dependencyGates: gates.dependency,
    machineGates: gates.machine,
    gitShellouts: count(
      text,
      /arguments\s*[:=]\s*\[\s*"git"|"git (?:log|rev-parse|show|diff|ls-files|merge-base)\b|(?:launchPath|executableURL)[^\n]*\/git"/g,
    ),
    pythonShellouts: count(
      text,
      /(?:executableURL|launchPath|arguments)[^\n]*["/](?:uv|python3?|pip3?|poetry)["\s,\]]/g,
    ),
    realWaits: count(text, /\b(?:Task\.sleep|Thread\.sleep|usleep|sleep)\s*\(/g),
    machinePaths:
      usesTmp || /\["HOME"\]\s*=|setenv\("HOME"/.test(text)
        ? 0
        : count(text, /NSHomeDirectory\(\)|homeDirectoryForCurrentUser|environment\["HOME"\]/g),
    skipped:
      skippedNamed +
      gates.skipped +
      count(text, /\.disabled\(/g) +
      count(text, /\bwithKnownIssue\b/g),
    focused: 0,
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

export type SwiftUnit = {
  name: string;
  /** `ClassName.testName`, matching the xunit `classname` tail and test name. */
  fullName: string;
  startLine: number;
  endLine: number;
  startIndex: number;
  endIndex: number;
};

const TYPE_DECL_RE =
  /^\s*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:final|public|internal|private|fileprivate)\s+)*(?:class|struct|actor|enum|extension)\s+([A-Za-z_][\w.]*)/;
const TEST_FUNC_RE = /^\s*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:override\s+)?func\s+(test\w*)\s*\(/;
const SWIFT_TESTING_ATTR_RE = /^\s*@Test\b/;
const ANY_FUNC_RE =
  /^\s*(?:@\w+(?:\([^)\n]*\))?\s+)*(?:(?:private|fileprivate|internal|public|static|mutating)\s+)*func\s+([A-Za-z_]\w*)\s*\(/;

/** Index of the brace that closes the block opened by the first `{` at or after `from`. */
function closingBrace(text: string, from: number): number {
  let depth = 0;
  let i = text.indexOf('{', from);
  if (i < 0) return -1;
  let inString: '"' | '"""' | null = null;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (inString === '"""' && text.startsWith('"""', i)) {
        inString = null;
        i += 2;
      } else if (inString === '"' && ch === '"') inString = null;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '"') {
      inString = text.startsWith('"""', i) ? '"""' : '"';
      if (inString === '"""') i += 2;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const parenBalance = (line: string): number =>
  (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;

/**
 * Split a Swift test file into `func test...` methods and `@Test` functions,
 * each spanning from its declaration (attributes included) to its closing
 * brace. The suite name is the innermost enclosing type, extension or
 * `@Suite`, tracked by brace range so a fixture struct declared inside a
 * suite does not claim the tests after it.
 */
export function splitSwiftUnits(text: string): SwiftUnit[] {
  const lines = text.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const line of lines) {
    offsets.push(acc);
    acc += line.length + 1;
  }
  const units: SwiftUnit[] = [];
  const types: Array<{ name: string; endIndex: number }> = [];
  let pendingTest = -1;
  let pendingDepth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const offset = offsets[i] ?? 0;
    while (types.length && (types[types.length - 1]?.endIndex ?? 0) < offset) types.pop();
    const typeMatch = TYPE_DECL_RE.exec(line);
    if (typeMatch && !ANY_FUNC_RE.test(line)) {
      const endIndex = closingBrace(text, offset);
      if (endIndex > 0) types.push({ name: (typeMatch[1] ?? '').split('.').pop() ?? '', endIndex });
      continue;
    }
    if (pendingTest >= 0 && pendingDepth > 0) {
      pendingDepth += parenBalance(line);
      continue;
    }
    if (SWIFT_TESTING_ATTR_RE.test(line) && !ANY_FUNC_RE.test(line)) {
      pendingTest = i;
      pendingDepth = Math.max(0, parenBalance(line));
      continue;
    }
    const xctest = TEST_FUNC_RE.exec(line);
    const swiftTesting = pendingTest >= 0 ? ANY_FUNC_RE.exec(line) : null;
    const attrLine = SWIFT_TESTING_ATTR_RE.test(line) ? ANY_FUNC_RE.exec(line) : null;
    const name = xctest?.[1] ?? swiftTesting?.[1] ?? attrLine?.[1];
    if (!name) {
      if (pendingTest >= 0 && line.trim() && !/^\s*@/.test(line)) pendingTest = -1;
      continue;
    }
    const startLine = pendingTest >= 0 ? pendingTest : i;
    pendingTest = -1;
    const startIndex = offsets[startLine] ?? 0;
    const end = closingBrace(text, offset);
    if (end < 0) continue;
    const endIndex = end + 1;
    let endLine = i;
    while (endLine + 1 < lines.length && (offsets[endLine + 1] ?? 0) <= end) endLine += 1;
    const type = types[types.length - 1]?.name ?? '';
    units.push({
      name,
      fullName: type ? `${type}.${name}` : name,
      startLine: startLine + 1,
      endLine: endLine + 1,
      startIndex,
      endIndex,
    });
    i = endLine;
  }
  return units;
}

/**
 * Per-test analysis for Swift: each block is analysed as its own text, with
 * the file supplying the gates that live in shared helpers and the sibling
 * source. Units carry no duplicate or timing data.
 */
export function analyzeSwiftUnits(input: AnalyzeInput, fileSignals: Signals): UnitSignals[] {
  const owns = splitSwiftUnits(input.text).map((unit) => ({
    unit,
    own: analyzeSwiftTest({
      ...input,
      text: input.text.slice(unit.startIndex, unit.endIndex),
      duplicateOf: null,
      similarTo: null,
      sharedHarness: null,
      timing: null,
    }),
  }));
  // Gates outside every test body live in a helper the tests call; a test
  // with no gate of its own inherits one. Gates inside other tests do not.
  const inTests = owns.reduce((n, { own }) => n + own.gatedSuites, 0);
  const helperGated = fileSignals.gatedSuites > inTests;
  const helperDependency =
    fileSignals.dependencyGates > owns.reduce((n, { own }) => n + own.dependencyGates, 0);
  return owns.map(({ unit, own }) => {
    const helperGates = helperGated && own.gatedSuites === 0 ? 1 : 0;
    return {
      ...own,
      name: unit.name,
      fullName: unit.fullName,
      line: unit.startLine,
      endLine: unit.endLine,
      tests: 1,
      moduleMocks: fileSignals.moduleMocks,
      gatedSuites: own.gatedSuites + helperGates,
      dependencyGates: own.dependencyGates + (helperGates && helperDependency ? 1 : 0),
      machineGates: Math.max(own.machineGates, fileSignals.machineGates > 0 ? 1 : 0),
    };
  });
}
