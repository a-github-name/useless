import { beforeAll, describe, expect, it } from 'vitest';
import { type Facts, type ReadCall, derivedFrom, extractFacts, initAst } from './ast.js';
import { analyzeTest } from './signals.js';
import type { Churn } from './types.js';

const churn: Churn = { testCommits: 1, sourceCommits: 1, coChangeCommits: 1 };

function analyze(text: string, file = 'src/thing.test.ts') {
  return analyzeTest({
    file,
    text,
    facts: extractFacts(file, text),
    source: null,
    sourceText: null,
    churn,
    timing: null,
  });
}

beforeAll(async () => {
  await initAst();
});

describe('extractFacts', () => {
  it('finds test blocks with their suite path and modifiers', () => {
    const facts = extractFacts(
      'src/a.test.ts',
      [
        "describe('outer', () => {",
        "  describe('inner', () => {",
        "    it('does x', () => {});",
        "    it.skip('does y', () => {});",
        "    test.each([1, 2])('handles %s', (n) => {});",
        '  });',
        "  it.only('z', () => {});",
        '});',
        "Deno.test('deno style', () => {});",
        "test.todo('later');",
      ].join('\n'),
    );
    expect(facts?.units.map((u) => u.fullName)).toEqual([
      'outer inner does x',
      'outer inner does y',
      'outer inner handles %s',
      'outer z',
      'deno style',
      'later',
    ]);
    expect(facts?.units.map((u) => u.modifiers)).toEqual([
      [],
      ['skip'],
      ['each'],
      ['only'],
      ['deno'],
      ['todo'],
    ]);
    expect(facts?.units[0]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it('parses expect chains: negation, soft, resolves, literal kinds', () => {
    const facts = extractFacts(
      'src/a.test.ts',
      [
        'expect(a.b).toBe(3);',
        "expect(x).not.toContain('y');",
        'expect.soft(z).toEqual({ k: 1 });',
        'await expect(p).resolves.toEqual([1]);',
        "expect(typeof v).toBe('string');",
        'expect(fn).toHaveBeenCalledWith(-1);',
        'expect(list).toHaveLength(2);',
        'expect(q).toMatch(/foo/);',
      ].join('\n'),
    );
    expect(facts?.assertions.map((a) => [a.matcher, a.literalKind])).toEqual([
      ['toBe', 'number'],
      ['not.toContain', 'string'],
      ['toEqual', 'object'],
      ['resolves.toEqual', 'array'],
      ['toBe', 'string'],
      ['toHaveBeenCalledWith', 'number'],
      ['toHaveLength', 'number'],
      ['toMatch', 'regex'],
    ]);
    expect(facts?.assertions[0]?.subjectIds).toEqual(['a']);
  });

  it('tracks reads through variables and helper functions', () => {
    const facts = extractFacts(
      'src/a.test.ts',
      [
        "const raw = readFileSync(join(__dirname, 'thing.ts'), 'utf8');",
        "const lines = raw.split('\\n');",
        'const first = lines[0];',
        "function load(p) { return fs.readFileSync(p, 'utf8'); }",
        "const other = load('x.css');",
        "const fake = { readFile: vi.fn() }; fake.readFile('nope');",
      ].join('\n'),
    );
    expect(facts?.reads.map((r) => r.boundTo)).toEqual(['raw', null, 'other']);
    expect([...derivedFrom(facts as Facts, facts?.reads ?? [])].sort()).toEqual([
      'first',
      'lines',
      'other',
      'raw',
    ]);
    expect([...derivedFrom(facts as Facts, [facts?.reads[0] as ReadCall])].sort()).toEqual([
      'first',
      'lines',
      'raw',
    ]);
    expect(facts?.readerFns).toEqual(new Set(['load']));
    expect(facts?.reads[2]?.pathText).toContain('x.css');
  });

  it('returns null for languages without a grammar', () => {
    expect(extractFacts('Tests/ATests.swift', 'func testX() {}')).toBeNull();
    expect(extractFacts('a.py', 'def test_x(): pass')).toBeNull();
  });
});

describe('analyzeTest with facts', () => {
  it('ignores patterns that only appear inside strings', () => {
    const s = analyze(
      [
        "it('documents the smells', () => {",
        "  const sample = \"vi.mock('x'); expect(a).toHaveBeenCalled(); readFileSync('a.ts')\";",
        "  expect(sample).toContain('export ');",
        '  expect(sample.length).toBeGreaterThan(5);',
        '});',
      ].join('\n'),
    );
    expect(s.tests).toBe(1);
    expect(s.mocks).toBe(0);
    expect(s.moduleMocks).toBe(0);
    expect(s.callExpects).toBe(0);
    expect(s.repoTextAsserts).toBe(0);
    expect(s.sourceTextAsserts).toBe(0);
    expect(s.weakExpects).toBe(0);
  });

  it('counts a grep over repo source only when the subject came from a source read', () => {
    const s = analyze(
      [
        "const src = readFileSync(join(__dirname, 'thing.ts'), 'utf8');",
        "const cases = JSON.parse(readFileSync('fixtures/cases.json', 'utf8'));",
        "it('greps', () => {",
        "  expect(src).toContain('export const');",
        '  expect(src).toMatch(/import/);',
        '  expect(src.length).toBeGreaterThan(10);',
        "  expect(cases[0].out).toEqual('x');",
        "  expect(run(cases[0].in)).toBe('x');",
        '});',
      ].join('\n'),
    );
    // The three greps on `src` count; the fixture-derived assertion does not.
    expect(s.repoTextAsserts).toBe(3);
    expect(s.sourceTextAsserts).toBe(3);
    const fixtureOnly = analyze(
      "const cases = JSON.parse(readFileSync('fixtures/cases.json', 'utf8'));\nit('x', () => { expect(cases[0]).toEqual('x'); });",
    );
    expect(fixtureOnly.repoTextAsserts).toBe(0);
  });

  it('classifies call assertions and weak assertions from the chain', () => {
    const s = analyze(
      [
        "it('calls', () => {",
        '  expect(fn).toHaveBeenCalled();',
        '  expect(fn).not.toHaveBeenCalled();',
        '  expect(fn).toHaveBeenCalledTimes(2);',
        "  expect(fn).toHaveBeenCalledWith('a');",
        '  expect(el).toBeInTheDocument();',
        '  expect(n).toBeGreaterThan(0);',
        '  expect(n).toBeGreaterThan(5);',
        '  expect(x).not.toBeNull();',
        '  expect(x).not.toBe(undefined);',
        "  expect(x).not.toBe('real');",
        '});',
      ].join('\n'),
    );
    expect(s.callExpects).toBe(4);
    expect(s.callExpectsCounted).toBe(2);
    expect(s.callExpectsWith).toBe(1);
    expect(s.weakExpects).toBe(5);
  });

  it('counts mocks, snapshots, skipped and focused from real calls', () => {
    const s = analyze(
      [
        "vi.mock('./dep');",
        'const spy = vi.fn();',
        "describe.skip('old', () => {});",
        "it.only('focus', () => { expect(x).toMatchSnapshot(); expect(y).toMatchInlineSnapshot(); });",
        "it.todo('later');",
        "it('sql', () => { expect(q).toContain('SELECT * FROM t'); });",
      ].join('\n'),
    );
    expect(s.mocks).toBe(2);
    expect(s.moduleMocks).toBe(1);
    expect(s.snapshotAsserts).toBe(1);
    expect(s.inlineSnapshots).toBe(1);
    expect(s.skipped).toBe(2);
    expect(s.focused).toBe(1);
    expect(s.sqlTextAsserts).toBe(1);
    expect(s.tests).toBe(3);
  });

  it('takes gates and shell-outs from real calls, not strings', () => {
    const s = analyze(
      [
        "const doc = \"describe.runIf(existsSync(homedir()))('x') execFileSync('git', ['log'])\";",
        "describe.skipIf(process.platform === 'win32')('posix', () => {",
        "  it('runs git', () => { execFileSync('git', ['rev-parse']); });",
        "  it('runs python', () => { spawnSync('python3', ['x.py']); });",
        '});',
        "describe.runIf(existsSync(join(homedir(), 'data')))('local', () => {});",
      ].join('\n'),
    );
    expect(s.gatedSuites).toBe(2);
    expect(s.machineGates).toBe(1);
    expect(s.gitShellouts).toBe(1);
    expect(s.pythonShellouts).toBe(1);
  });

  it('falls back to the regex count when the parse finds no test blocks', () => {
    const s = analyze("const t = makeTest();\nt('dynamic', () => {});\ntest('static', () => {});");
    expect(s.tests).toBe(1);
  });
});

describe('analyzeUnits', () => {
  it('scores each test block with the file as context', async () => {
    const { analyzeUnits } = await import('./signals.js');
    const { score } = await import('./score.js');
    const text = [
      "vi.mock('./dep');",
      'vi.useFakeTimers();',
      "describe('suite', () => {",
      "  it('checks the call', () => {",
      '    expect(fn).toHaveBeenCalled();',
      '  });',
      "  it('checks the value', () => {",
      '    const spy = vi.fn();',
      '    expect(add(1, 2)).toBe(3);',
      '    await new Promise((r) => setTimeout(r, 10));',
      '  });',
      '});',
    ].join('\n');
    const input = {
      file: 'src/thing.test.ts',
      text,
      facts: extractFacts('src/thing.test.ts', text),
      source: null,
      sourceText: null,
      churn,
      timing: null,
    };
    const file = analyzeTest(input);
    const units = analyzeUnits(input, file);
    expect(units.map((u) => [u.fullName, u.line, u.endLine, u.tests, u.expects])).toEqual([
      ['suite checks the call', 4, 6, 1, 1],
      ['suite checks the value', 7, 11, 1, 1],
    ]);
    expect(units[0]).toMatchObject({ callExpects: 1, weakExpects: 1, moduleMocks: 1, mocks: 1 });
    expect(units[1]).toMatchObject({ callExpects: 0, mocks: 2, literalExpects: 1, realWaits: 0 });
    const scored = score({ ...file, units });
    expect(scored.units.map((u) => u.finding)).toEqual(['restates-implementation', 'clean']);
    expect(scored.reasons).toContain('1 of 2 tests restate the implementation');
    expect(scored.finding).not.toBe('restates-implementation');
  });
});
