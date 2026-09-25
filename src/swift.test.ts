import { describe, expect, it } from 'vitest';
import { analyzeTest } from './signals.js';
import { classifySwiftGates, countSwiftFunctions, measureSwiftLiteralBlocks } from './swift.js';
import type { Churn } from './types.js';

const churn: Churn = { testCommits: 1, sourceCommits: 1, coChangeCommits: 1 };

function analyze(
  text: string,
  file = 'Tests/CoreTests/ThingTests.swift',
  sourceText: string | null = null,
) {
  return analyzeTest({
    file,
    text,
    source: sourceText === null ? null : 'Sources/Core/Thing.swift',
    sourceText,
    churn,
    timing: null,
  });
}

describe('analyzeTest on Swift', () => {
  it('dispatches on the .swift extension and counts XCTest and Swift Testing tests', () => {
    const s = analyze(
      [
        'final class ThingTests: XCTestCase {',
        '    override func setUp() {}',
        '    func testOne() throws {}',
        '    @MainActor func testTwo() async throws {}',
        '    func helper() {}',
        '}',
        '@Suite("s") struct More {',
        '    @Test("named") func three() {}',
        '    @Test func four() {}',
        '}',
      ].join('\n'),
    );
    expect(s.tests).toBe(4);
    expect(s.focused).toBe(0);
    expect(s.moduleMocks).toBe(0);
  });

  it('counts assertions and separates presence checks from real ones', () => {
    const s = analyze(
      [
        'XCTAssertEqual(a, 3)',
        'XCTAssertNotNil(a)',
        'XCTAssertTrue(!items.isEmpty)',
        'XCTAssertTrue(items.contains("x"))',
        'XCTAssertFalse(items.isEmpty)',
        'XCTAssertGreaterThan(count, 0)',
        'XCTAssertGreaterThan(count, 5)',
        'XCTAssertNotEqual(name, "")',
        'XCTAssertTrue(value is Foo)',
        'XCTFail("unreachable")',
        'let x = try XCTUnwrap(maybe)',
        '#expect(x != nil)',
        '#expect(x == 2)',
        'let y = try #require(maybe)',
      ].join('\n'),
    );
    expect(s.expects).toBe(12);
    expect(s.weakExpects).toBe(7);
    expect(s.literalExpects).toBe(2);
  });

  it('classifies skips: unconditional, hardware/model dependency, hard-coded machine path', () => {
    const lines = [
      'func testA() throws {',
      '    throw XCTSkip("flaky")',
      '}',
      'func testB() throws {',
      '    guard Device.defaultDevice().deviceType == .gpu else {',
      '        throw XCTSkip("needs gpu")',
      '    }',
      '    let env = ProcessInfo.processInfo.environment',
      '    guard let root = env["MODEL_ROOT"], !root.isEmpty else {',
      '        throw XCTSkip("set MODEL_ROOT")',
      '    }',
      '    try XCTSkipUnless(FileManager.default.fileExists(atPath: "/Users/me/weights"))',
      '    try XCTSkipIf(flagOff)',
      '}',
    ];
    expect(classifySwiftGates(lines)).toEqual({ gated: 4, skipped: 1, machine: 1, dependency: 3 });
    const s = analyze(lines.join('\n'));
    expect(s.skipped).toBe(1);
    expect(s.gatedSuites).toBe(4);
    expect(s.dependencyGates).toBe(3);
    expect(s.machineGates).toBe(1);
  });

  it('a home-relative model root is a dependency, not a machine gate', () => {
    const s = analyze(
      [
        'func testX() throws {',
        '    let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("models/x")',
        '    guard FileManager.default.fileExists(atPath: root.path) else {',
        '        throw XCTSkip("no model")',
        '    }',
        '}',
      ].join('\n'),
    );
    expect(s.machineGates).toBe(0);
    expect(s.dependencyGates).toBe(1);
    expect(s.machinePaths).toBe(1);
  });

  it('flags greps over repo files located from #filePath', () => {
    const s = analyze(
      [
        'let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()',
        'let script = try String(contentsOf: root.appendingPathComponent("scripts/build.sh"), encoding: .utf8)',
        'let pkg = try String(contentsOf: root.appendingPathComponent("Package.swift"), encoding: .utf8)',
        'func testScript() {',
        '    XCTAssertTrue(script.contains("set -euo pipefail"))',
        '    XCTAssertTrue(pkg.contains("func mlxDependency("))',
        '    XCTAssertEqual(pkg.count, 10)',
        '    XCTAssertNil(nothing)',
        '}',
      ].join('\n'),
    );
    expect(s.repoTextAsserts).toBe(3);
    // Two source-like reads plus two code-token contains, as in the JS rule.
    expect(s.sourceTextAsserts).toBe(4);
  });

  it('reading a fixture, a temp file, or written output is not a repo grep', () => {
    const fixture = analyze(
      'let data = try Data(contentsOf: fixtureRoot.appendingPathComponent("Fixtures/a.md"))\nXCTAssertTrue(text.contains("x"))',
    );
    expect(fixture.repoTextAsserts).toBe(0);
    const temp = analyze(
      [
        'let dir = FileManager.default.temporaryDirectory',
        'try "hello".write(to: dir.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)',
        'let text = try String(contentsOf: dir.appendingPathComponent("notes.md"), encoding: .utf8)',
        'XCTAssertTrue(text.contains("hello"))',
      ].join('\n'),
    );
    expect(temp.repoTextAsserts).toBe(0);
    const noSource = analyze(
      'let data = try Data(contentsOf: url.appendingPathComponent("config.json"))\nXCTAssertEqual(decoded.count, 2)',
    );
    expect(noSource.repoTextAsserts).toBe(0);
  });

  it('measures multi-line literal expectations in both Swift call shapes', () => {
    const lines = [
      '    func testA() {',
      '        XCTAssertEqual(result, [',
      '            "a",',
      '            "b",',
      '        ])',
      '        XCTAssertEqual(',
      '            resolved.map(\\.name),',
      '            [',
      '                "x",',
      '                "y",',
      '            ]',
      '        )',
      '        XCTAssertEqual(',
      '            try Mode.resolve(nil),',
      '            .disabled',
      '        )',
      '        XCTAssertEqual(',
      '            computed(),',
      '            expected()',
      '        )',
      '    }',
    ];
    expect(measureSwiftLiteralBlocks(lines)).toEqual({ blocks: 2, lines: 11 });
    const s = analyze(lines.join('\n'));
    expect(s.largeLiteralExpects).toBe(2);
    expect(s.literalLines).toBe(11);
  });

  it('counts assertions over hand-rolled call recorders and fake types as mocks', () => {
    const s = analyze(
      [
        'final class RecordingRunner: ProcessRunning { var calls: [[String]] = [] }',
        'actor FakeSession {}',
        'let runner = RecordingRunner()',
        'let session = FakeSession()',
        'XCTAssertEqual(runner.calls.count, 1)',
        'XCTAssertEqual(runner.calls.first?.first, "git")',
        'XCTAssertEqual(session.callCount, 2)',
        'XCTAssertEqual(output.captured, "x")',
      ].join('\n'),
    );
    expect(s.mocks).toBe(4);
    expect(s.callExpects).toBe(3);
    expect(s.callExpectsCounted).toBe(2);
    expect(s.callExpectsWith).toBe(1);
    expect(s.moduleMocks).toBe(0);
    expect(analyze('URLProtocol.registerClass(MockURLProtocol.self)').moduleMocks).toBe(1);
  });

  it('detects transcription: digests, count pins, snapshots, deleted-file asserts', () => {
    const s = analyze(
      [
        'XCTAssertEqual(pin.sha256, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")',
        'XCTAssertEqual(items.count, 12)',
        'XCTAssertEqual(items.count, 2)',
        '#expect(rows.count == 7)',
        'assertSnapshot(of: view, as: .image)',
        'assertInlineSnapshot(of: value, as: .json) { "{}" }',
        'XCTAssertFalse(FileManager.default.fileExists(atPath: staleURL.path))',
      ].join('\n'),
    );
    expect(s.digestPins).toBe(1);
    expect(s.countPins).toBe(2);
    expect(s.snapshotAsserts).toBe(1);
    expect(s.inlineSnapshots).toBe(1);
    expect(s.deletedFileAsserts).toBe(1);
  });

  it('detects environment coupling: python and git processes, sleeps, the home directory', () => {
    const s = analyze(
      [
        'let p = Process()',
        'p.executableURL = URL(fileURLWithPath: "/usr/bin/env")',
        'p.arguments = ["python3", "script.py"]',
        'let g = Process()',
        'g.arguments = ["git", "rev-parse", "HEAD"]',
        'try await Task.sleep(nanoseconds: 100)',
        'Thread.sleep(forTimeInterval: 1)',
        'let home = NSHomeDirectory()',
      ].join('\n'),
    );
    expect(s.pythonShellouts).toBe(1);
    expect(s.gitShellouts).toBe(1);
    expect(s.realWaits).toBe(2);
    expect(s.machinePaths).toBe(1);
    expect(
      analyze('let home = NSHomeDirectory()\nlet t = NSTemporaryDirectory()').machinePaths,
    ).toBe(0);
    expect(analyze('let a = ["python-ish.txt"]').pythonShellouts).toBe(0);
  });

  it('counts disabled and named-out tests as skipped', () => {
    const s = analyze(
      'func xtestOld() {}\nfunc DISABLED_testGone() {}\n@Test(.disabled("wip")) func a() {}\nwithKnownIssue { }',
    );
    expect(s.skipped).toBe(4);
  });

  it('marks data subjects from the Swift source', () => {
    const table = `enum Table {\n${'    static let row = 1\n'.repeat(90)}}\n`;
    expect(countSwiftFunctions(table)).toBe(0);
    expect(analyze('', 'Tests/CoreTests/TableTests.swift', table).dataSubject).toBe(true);
    const code =
      'struct S {\n    init() {}\n    func a() {}\n    func b() {}\n    let f = { (x: Int) -> Int in x }\n}\n';
    expect(countSwiftFunctions(code)).toBe(4);
    expect(analyze('', 'Tests/CoreTests/STests.swift', code).dataSubject).toBe(false);
    expect(analyze('', 'Tests/CoreTests/Resources/XTests.swift').dataSubject).toBe(true);
  });
});

describe('splitSwiftUnits', () => {
  it('finds XCTest methods and @Test functions with their enclosing type', async () => {
    const { splitSwiftUnits } = await import('./swift.js');
    const text = [
      'import XCTest',
      'final class AdderTests: XCTestCase {',
      '    override func setUp() {}',
      '    func testAdds() {',
      '        XCTAssertEqual(add(1, 2), 3) // } not a brace',
      '        let s = "}"',
      '    }',
      '    private func helper() -> Int { 1 }',
      '    @MainActor func testMain() async throws {',
      '        if x { y() }',
      '    }',
      '}',
      '@Suite struct More {',
      '    @Test("named")',
      '    func named() { #expect(1 == 1) }',
      '    @Test func inline() {',
      '    }',
      '}',
    ].join('\n');
    const units = splitSwiftUnits(text);
    expect(units.map((u) => [u.fullName, u.startLine, u.endLine])).toEqual([
      ['AdderTests.testAdds', 4, 7],
      ['AdderTests.testMain', 9, 11],
      ['More.named', 14, 15],
      ['More.inline', 16, 17],
    ]);
    expect(text.slice(units[0]?.startIndex, units[0]?.endIndex)).toMatch(
      /^\s*func testAdds[\s\S]*\n {4}\}$/,
    );
  });

  it('handles extensions, inline fixture types, and multi-line @Test attributes', async () => {
    const { splitSwiftUnits } = await import('./swift.js');
    const text = [
      '@Suite struct HelpTests {',
      '    struct Fixture: ParsableCommand {',
      '        @Flag var verbose = false',
      '    }',
      '    @Test func inSuite() { #expect(true) }',
      '}',
      'extension HelpTests {',
      '    @Test(',
      '        arguments: [1, 2]',
      '    )',
      '    func parameterised(_ n: Int) {',
      '        #expect(n > 0)',
      '    }',
      '    private struct Other {}',
      '    @Test func afterFixture() {}',
      '}',
      'final class LegacyTests: XCTestCase {',
      '    func testOld() {}',
      '}',
    ].join('\n');
    expect(splitSwiftUnits(text).map((u) => [u.fullName, u.startLine, u.endLine])).toEqual([
      ['HelpTests.inSuite', 5, 5],
      ['HelpTests.parameterised', 8, 13],
      ['HelpTests.afterFixture', 15, 15],
      ['LegacyTests.testOld', 18, 18],
    ]);
  });

  it('keeps Swift raw strings and nested comments inside their test methods', async () => {
    const { splitSwiftUnits } = await import('./swift.js');
    const text = [
      'final class RecoveryTests: XCTestCase {',
      '    func testRawEvent() {',
      '        let tail = Data(#"{"sequence":1,"type":"node_"#.utf8)',
      '        let more = ##"{"nested": "}"}"##',
      '        /* { outer /* } inner */ still commented } */',
      '        XCTAssertEqual(tail.count, 2)',
      '    }',
      '    func testAfterRawEvent() {',
      '        let document = #"""',
      '        { "value": "}" }',
      '        """#',
      '        XCTAssertNotNil(document)',
      '    }',
      '}',
    ].join('\n');
    expect(
      splitSwiftUnits(text).map((unit) => [unit.fullName, unit.startLine, unit.endLine]),
    ).toEqual([
      ['RecoveryTests.testRawEvent', 2, 7],
      ['RecoveryTests.testAfterRawEvent', 8, 13],
    ]);
  });

  it('scores each Swift test on its own, inheriting only helper gates', async () => {
    const { analyzeSwiftUnits } = await import('./swift.js');
    const text = [
      'final class T: XCTestCase {',
      '    private func requireModel() throws -> URL {',
      '        guard let root = ProcessInfo.processInfo.environment["MODEL_ROOT"] else {',
      '            throw XCTSkip("set MODEL_ROOT")',
      '        }',
      '        return URL(fileURLWithPath: root)',
      '    }',
      '    func testA() throws {',
      '        let root = try requireModel()',
      '        XCTAssertEqual(root.lastPathComponent, "m")',
      '    }',
      '    func testB() {',
      '        XCTAssertNotNil(x)',
      '    }',
      '}',
    ].join('\n');
    const input = {
      file: 'Tests/CoreTests/TTests.swift',
      text,
      source: null,
      sourceText: null,
      churn,
      timing: null,
    };
    const file = analyzeTest(input);
    expect(file.gatedSuites).toBe(1);
    const units = analyzeSwiftUnits(input, file);
    expect(
      units.map((u) => [
        u.fullName,
        u.tests,
        u.expects,
        u.weakExpects,
        u.gatedSuites,
        u.dependencyGates,
      ]),
    ).toEqual([
      ['T.testA', 1, 1, 0, 1, 1],
      ['T.testB', 1, 1, 1, 1, 1],
    ]);
    const local = [
      'final class T: XCTestCase {',
      '    func testA() throws {',
      '        try XCTSkipUnless(Device.defaultDevice().deviceType == .gpu)',
      '        XCTAssertEqual(a, 1)',
      '    }',
      '    func testB() { XCTAssertEqual(b, 2) }',
      '}',
    ].join('\n');
    const input2 = { ...input, text: local };
    const units2 = analyzeSwiftUnits(input2, analyzeTest(input2));
    expect(units2.map((u) => [u.gatedSuites, u.dependencyGates])).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });
});
