import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rank } from './index.js';
import {
  buildChurnIndex,
  buildSourceIndex,
  churnFor,
  findDuplicates,
  findSharedBlocks,
  findSimilar,
  listTestFiles,
  loadTimings,
  parseNodeJunitTimings,
  parseTimings,
  parseXunitTimings,
  resolveModuleText,
  siblingSource,
  unsupportedStandaloneFiles,
} from './repo.js';
import { markdownTable, summarize, summaryLines } from './report.js';

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'useless-'));
  git(root, 'init', '-q');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src/add.ts'),
    'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\nexport const neg = (a: number) => -a;\n',
  );
  writeFileSync(
    join(root, 'src/add.test.ts'),
    "import { add } from './add';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n",
  );
  writeFileSync(
    join(root, 'src/grep.spec.ts'),
    [
      "const src = readFileSync('src/add.ts', 'utf8');",
      "it('has export', () => { expect(src).toContain('export const'); });",
      "it('no any', () => { expect(src).not.toContain('any'); });",
      "it('arrow', () => { expect(src).toMatch(/=>/); });",
      "it('typed', () => { expect(src).toContain('number'); });",
      "it('short', () => { expect(src.length).toBeGreaterThan(10); });",
    ].join('\n'),
  );
  writeFileSync(join(root, 'src/notes.md'), 'x');
  mkdirSync(join(root, 'test/fixtures'), { recursive: true });
  mkdirSync(join(root, 'src/__tests__'), { recursive: true });
  writeFileSync(join(root, 'test/app.js'), "it('boots', () => { expect(1).toBe(1); });\n");
  writeFileSync(join(root, 'test/helpers.js'), 'export const h = 1;\n');
  writeFileSync(join(root, 'test/support.js'), 'export const s = 1;\n');
  writeFileSync(join(root, 'test/fixtures/data.js'), "it('not really', () => {});\n");
  writeFileSync(join(root, 'src/__tests__/util.js'), "test('u', () => { expect(2).toBe(2); });\n");
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  writeFileSync(
    join(root, 'src/add.ts'),
    'export function add(a: number, b: number) { return b + a; }\nexport function sub(a: number, b: number) { return a - b; }\nexport const neg = (a: number) => -a;\n',
  );
  writeFileSync(join(root, 'src/add.test.ts'), "it('adds', () => { expect(1).toBe(1); });\n");
  git(root, 'commit', '-q', '-am', 'two');
  return root;
}

describe('repo plumbing', () => {
  const root = makeRepo();

  it('lists tracked test files, including conventional test directories', () => {
    expect(listTestFiles(root)).toEqual([
      'src/__tests__/util.js',
      'src/add.test.ts',
      'src/grep.spec.ts',
      'test/app.js',
      'test/helpers.js',
      'test/support.js',
    ]);
  });

  it('drops test-directory files that contain no tests', async () => {
    const files = (await rank({ root })).map((r) => r.file);
    expect(files).not.toContain('test/support.js');
    expect(files).toContain('test/app.js');
    expect(files).toContain('src/__tests__/util.js');
  });

  it('includes explicit standalone JS/TS verifiers and flags opaque checks for review', async () => {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/verify-local.mjs'),
      "import assert from 'node:assert/strict';\nassert.equal(2, 2);\n",
    );
    writeFileSync(
      join(root, 'scripts/verify-opaque.ts'),
      "import { verify } from './helper';\nawait verify();\n",
    );
    writeFileSync(join(root, 'scripts/verify-python.py'), 'assert True\n');
    git(root, 'add', 'scripts');
    const patterns = ['scripts/verify-*'];
    expect(unsupportedStandaloneFiles(root, patterns)).toEqual(['scripts/verify-python.py']);
    expect(listTestFiles(root, patterns)).toEqual([
      'scripts/verify-local.mjs',
      'scripts/verify-opaque.ts',
    ]);
    expect((await rank({ root, patterns })).map((row) => row.file)).toEqual([]);
    const rows = await rank({ root, patterns, standalone: true });
    expect(rows.map((row) => row.file).sort()).toEqual([
      'scripts/verify-local.mjs',
      'scripts/verify-opaque.ts',
    ]);
    expect(rows.find((row) => row.file.endsWith('local.mjs'))).toMatchObject({
      standalone: true,
      tests: 0,
      expects: 1,
    });
    expect(rows.find((row) => row.file.endsWith('opaque.ts'))).toMatchObject({
      standalone: true,
      finding: 'review',
      expects: 0,
    });
    expect(summarize(rows).standaloneFiles).toBe(2);
    expect(summaryLines(summarize(rows))[0]).toContain('2 standalone JS/TS scripts');
    expect(markdownTable(rows)).toContain('| kind |');
    await expect(rank({ root, standalone: true })).rejects.toThrow('explicit patterns');
  });

  it('uses Node JUnit case time as a file cost when supplied', async () => {
    const xml = `<testsuites><testcase name="adds" classname="test" file="${realpathSync(join(root, 'src/add.test.ts'))}" time="20"/></testsuites>`;
    const report = join(root, 'node-junit.xml');
    writeFileSync(report, xml);
    const rows = await rank({ root, timings: loadTimings(report, root) });
    const add = rows.find((row) => row.file === 'src/add.test.ts');
    expect(add?.durationMs).toBe(20_000);
    expect(add?.components.cost).toBeGreaterThan(0.3);
  });

  it('finds the co-located source by name, or one folder up from a tests directory', () => {
    expect(siblingSource(root, 'src/add.test.ts')).toBe('src/add.ts');
    expect(siblingSource(root, 'src/grep.spec.ts')).toBeNull();
    expect(siblingSource(root, 'src/__tests__/add.test.ts')).toBe('src/add.ts');
    expect(siblingSource(root, 'src/tests/add.test.ts')).toBe('src/add.ts');
    expect(siblingSource(root, 'src/other/add.test.ts')).toBeNull();
  });

  it('computes co-change churn from git history', () => {
    const index = buildChurnIndex(root);
    expect(churnFor(index, 'src/add.test.ts', 'src/add.ts')).toEqual({
      testCommits: 2,
      sourceCommits: 2,
      coChangeCommits: 2,
    });
    expect(churnFor(index, 'src/grep.spec.ts', null)).toEqual({
      testCommits: 1,
      sourceCommits: 0,
      coChangeCommits: 0,
    });
  });

  it('ranks the source-grepping test above the real one', async () => {
    const rows = await rank({ root });
    expect(rows[0]?.file).toBe('src/grep.spec.ts');
    expect(rows[0]?.finding).toBe('source-inspection');
    expect(rows.find((r) => r.file === 'src/add.test.ts')?.finding).toBe('clean');
  });
});

describe('findDuplicates', () => {
  it('maps later copies to the first file with the same whitespace-stripped content', () => {
    const dupes = findDuplicates([
      { file: 'a.test.ts', text: "it('x', () => {\n  expect(1).toBe(1);\n});" },
      { file: 'b.test.ts', text: "it('x',()=>{expect(1).toBe(1);});" },
      { file: 'c.test.ts', text: "it('y', () => {});" },
    ]);
    expect([...dupes.entries()]).toEqual([['b.test.ts', 'a.test.ts']]);
  });
});

describe('findSimilar', () => {
  const harness = Array.from(
    { length: 30 },
    (_, i) => `const mockThing${i} = vi.fn(() => ({ id: ${i} }));`,
  );
  it('reports the later file of a mutual pair, pointing at the earlier one', () => {
    const a = [...harness, "it('a', () => { expect(run()).toBe(1); });"].join('\n');
    const b = [...harness, "it('b', () => { expect(run()).toBe(2); });", 'const extra = 1;'].join(
      '\n',
    );
    const c = Array.from(
      { length: 30 },
      (_, i) => `expect(values[${i}]).toEqual({ id: ${i} });`,
    ).join('\n');
    const similar = findSimilar([
      { file: 'a.test.ts', text: a },
      { file: 'b.test.ts', text: b },
      { file: 'c.test.ts', text: c },
    ]);
    expect(similar.has('a.test.ts')).toBe(false);
    expect(similar.get('b.test.ts')).toEqual({ file: 'a.test.ts', share: 0.94 });
    expect(similar.has('c.test.ts')).toBe(false);
  });
  it('ignores small files and much larger partners', () => {
    const tiny = "it('x', () => { expect(1).toBe(1); });";
    expect(
      findSimilar([
        { file: 't.test.ts', text: tiny },
        { file: 'u.test.ts', text: tiny },
      ]).size,
    ).toBe(0);
  });
});

describe('resolveModuleText', () => {
  it('follows a re-export barrel to the real modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'useless-barrel-'));
    mkdirSync(join(root, 'src/ops'), { recursive: true });
    writeFileSync(
      join(root, 'src/ops.ts'),
      "// Barrel\nexport * from './ops/items';\nexport {\n  board,\n  type Board,\n} from './ops/board';\n",
    );
    writeFileSync(join(root, 'src/ops/items.ts'), 'export function items() {\n  return 1;\n}\n');
    writeFileSync(join(root, 'src/ops/board.ts'), 'export const board = () => 2;\n');
    const r = resolveModuleText(root, 'src/ops.ts');
    expect(r.files).toEqual(['src/ops/items.ts', 'src/ops/board.ts']);
    expect(r.text).toContain('function items');
    expect(r.text).toContain('board = ()');
    const plain = resolveModuleText(root, 'src/ops/items.ts');
    expect(plain.files).toEqual(['src/ops/items.ts']);
  });
});

describe('findSharedBlocks', () => {
  it('finds a setup block repeated across three files and ignores pairs', () => {
    const harness = Array.from(
      { length: 12 },
      (_, i) => `const RESET_STATEMENT_${i} = 'DROP TABLE IF EXISTS table_${i}';`,
    );
    const mk = (n: number) =>
      [...harness, `it('case ${n}', () => { expect(run(${n})).toBe(${n}); });`].join('\n');
    const shared = findSharedBlocks([
      { file: 'a.test.ts', text: mk(1) },
      { file: 'b.test.ts', text: mk(2) },
      { file: 'c.test.ts', text: mk(3) },
      { file: 'd.test.ts', text: "it('alone', () => { expect(1).toBe(1); });" },
    ]);
    expect(shared.get('a.test.ts')).toEqual({ lines: 12, files: 3 });
    expect(shared.has('d.test.ts')).toBe(false);
    const pair = findSharedBlocks([
      { file: 'a.test.ts', text: mk(1) },
      { file: 'b.test.ts', text: mk(2) },
    ]);
    expect(pair.size).toBe(0);
  });
});

function makeSwiftRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'useless-swift-'));
  git(root, 'init', '-q');
  const write = (file: string, text: string): void => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write('Package.swift', '// swift-tools-version: 6.0\n');
  write('Sources/Core/Adder.swift', 'public func add(_ a: Int, _ b: Int) -> Int { a + b }\n');
  write('Sources/Core/Commands/PullCommand.swift', 'struct PullCommand {\n    func run() {}\n}\n');
  write('Sources/Core/Shape.swift', 'struct Shape {}\n');
  write('Sources/Other/Shape.swift', 'struct Shape {}\n');
  write(
    'Tests/CoreTests/AdderTests.swift',
    'import XCTest\nfinal class AdderTests: XCTestCase {\n    func testAdds() {\n        XCTAssertEqual(add(1, 2), 3)\n    }\n}\n',
  );
  write(
    'Tests/CoreTests/PullCommandParsingTests.swift',
    'import XCTest\nfinal class PullCommandParsingTests: XCTestCase {\n    func testParses() {\n        XCTAssertEqual(PullCommand().name, "pull")\n    }\n}\n',
  );
  write(
    'Tests/OtherTests/ShapeTests.swift',
    'import Testing\n@Test func area() {\n    #expect(Shape().area == 0)\n}\n',
  );
  write('Tests/CoreTests/TestSupport.swift', 'func makeFixture() -> Int { 1 }\n');
  write('Tests/CoreTests/Fixtures/Sample.swift', 'func testLooking() {}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  return root;
}

describe('swift packages', () => {
  const root = makeSwiftRepo();

  it('lists swift test files under *Tests/ and drops helpers and fixtures', async () => {
    expect(listTestFiles(root)).toEqual([
      'Tests/CoreTests/AdderTests.swift',
      'Tests/CoreTests/PullCommandParsingTests.swift',
      'Tests/CoreTests/TestSupport.swift',
      'Tests/OtherTests/ShapeTests.swift',
    ]);
    const files = (await rank({ root })).map((r) => r.file);
    expect(files).not.toContain('Tests/CoreTests/TestSupport.swift');
    expect(files).toHaveLength(3);
  });

  it('resolves the source by name, preferring the test target module and stripping a trailing word', () => {
    const index = buildSourceIndex(root);
    expect(index.get('Shape.swift')).toEqual([
      'Sources/Core/Shape.swift',
      'Sources/Other/Shape.swift',
    ]);
    expect(siblingSource(root, 'Tests/CoreTests/AdderTests.swift', index)).toBe(
      'Sources/Core/Adder.swift',
    );
    expect(siblingSource(root, 'Tests/OtherTests/ShapeTests.swift', index)).toBe(
      'Sources/Other/Shape.swift',
    );
    expect(siblingSource(root, 'Tests/CoreTests/PullCommandParsingTests.swift', index)).toBe(
      'Sources/Core/Commands/PullCommand.swift',
    );
    expect(siblingSource(root, 'Tests/CoreTests/NopeTests.swift', index)).toBeNull();
    expect(siblingSource(root, 'Tests/CoreTests/AdderTests.swift')).toBeNull();
  });

  it('scores swift files and joins xunit timings by class name', async () => {
    const xml =
      '<testsuites><testsuite name="CoreTests"><testcase classname="CoreTests.AdderTests" name="testAdds" time="1.5"/><testcase classname="CoreTests.AdderTests" name="testMore" time="0.25"><failure message="boom"/></testcase></testsuite></testsuites>';
    const rows = await rank({ root, timings: parseXunitTimings(xml) });
    const adder = rows.find((r) => r.file === 'Tests/CoreTests/AdderTests.swift');
    expect(adder?.source).toBe('Sources/Core/Adder.swift');
    expect(adder?.tests).toBe(1);
    expect(adder?.expects).toBe(1);
    expect(adder?.durationMs).toBe(1750);
    expect(adder?.failed).toBe(true);
    expect(adder?.finding).toBe('clean');
    const shape = rows.find((r) => r.file === 'Tests/OtherTests/ShapeTests.swift');
    expect(shape?.tests).toBe(1);
    expect(shape?.durationMs).toBeNull();
  });
});

describe('parseXunitTimings', () => {
  it('sums testcase times per class and flags failures and errors', () => {
    const xml = [
      '<testcase classname="M.ATests" name="a" time="0.5"/>',
      '<testcase classname="M.ATests" name="b" time="0.5"></testcase>',
      '<testcase classname="M.BTests" name="c" time="2"><error message="x"/></testcase>',
      '<testcase name="orphan" time="9"/>',
    ].join('\n');
    const timings = parseXunitTimings(xml);
    expect(timings.get('ATests')).toEqual({ durationMs: 1000, failed: false });
    expect(timings.get('BTests')).toEqual({ durationMs: 2000, failed: true });
    expect(timings.size).toBe(2);
  });
});

describe('parseNodeJunitTimings', () => {
  it('sums case times by file and keeps failures', () => {
    const xml = [
      '<testsuites>',
      '  <testcase name="first" classname="test" file="/repo/tests/a.test.ts" time="0.125"/>',
      '  <testcase name="second" classname="test" file="/repo/tests/a.test.ts" time="0.375"><failure>bad</failure></testcase>',
      '  <testcase name="other" classname="test" file="/repo/tests/b.test.ts" time="1.5"/>',
      '</testsuites>',
    ].join('\n');
    const timings = parseNodeJunitTimings(xml, '/repo');
    expect(timings.get('tests/a.test.ts')).toEqual({ durationMs: 500, failed: true });
    expect(timings.get('tests/b.test.ts')).toEqual({ durationMs: 1500, failed: false });
    const report = join(tmpdir(), `useless-node-junit-${process.pid}.xml`);
    writeFileSync(report, xml);
    expect(loadTimings(report, '/repo').get('tests/a.test.ts')?.durationMs).toBe(500);
  });
});

describe('parseTimings', () => {
  it('keys vitest/jest results by repo-relative path and ignores malformed rows', () => {
    const json = JSON.stringify({
      testResults: [
        { name: '/repo/src/a.test.ts', startTime: 100, endTime: 350, status: 'passed' },
        { name: '/repo/src/b.test.ts', startTime: 10, endTime: 5, status: 'failed' },
        { name: 'nope' },
      ],
    });
    const timings = parseTimings(json, '/repo');
    expect(timings.get('src/a.test.ts')).toEqual({ durationMs: 250, failed: false });
    expect(timings.get('src/b.test.ts')).toEqual({ durationMs: 0, failed: true });
    expect(timings.size).toBe(2);
  });

  it('returns nothing for a report without testResults', () => {
    expect(parseTimings('{"numTotalTests": 3}', '/repo').size).toBe(0);
  });
});
