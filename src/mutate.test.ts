import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codeMask, coveredLines, generateMutants, readXunit, sample } from './mutate.js';

describe('generateMutants', () => {
  it('mutates operators, literals and conditions in code but not in comments or strings', () => {
    const text = [
      '// if a == b { true }',
      'let s = "a == b && true"',
      'let raw = #"x != y"#',
      'if count > 0 && !done {',
      '    total += 1',
      '    return value == "yes"',
      '}',
      'let t = """',
      '  a < b',
      '  """',
    ].join('\n');
    const mutants = generateMutants('S.swift', text);
    const byLine = (l: number) =>
      mutants
        .filter((m) => m.line === l)
        .map((m) => `${m.mutator}:${m.original}->${m.replacement}`);
    expect(byLine(1)).toEqual([]);
    expect(byLine(2)).toEqual(['StringLiteral:"a == b && true"->""']);
    expect(byLine(3)).toEqual([]);
    expect(byLine(4)).toEqual([
      'ConditionalExpression:if count > 0 && !done {->if false {',
      'RelationalOperator: > -> >= ',
      'NumericLiteral:0->1',
      'LogicalOperator: && -> || ',
      'UnaryOperator:!->',
    ]);
    expect(byLine(5)).toEqual(['ArithmeticOperator: += -> -= ', 'NumericLiteral:1->2']);
    expect(byLine(6)).toEqual(['EqualityOperator:==->!=', 'StringLiteral:"yes"->""']);
    expect(byLine(9)).toEqual([]);
    expect(mutants[0]).toMatchObject({ file: 'S.swift', line: 2, column: 9 });
  });

  it('restricts to covered lines and skips interpolated strings and binding conditions', () => {
    const text = ['if let x = y {', '    print("v: \\(x)")', '}', 'let n = 3 == 4'].join('\n');
    const all = generateMutants('S.swift', text);
    expect(all.map((m) => `${m.line}:${m.mutator}`)).toEqual([
      '4:NumericLiteral',
      '4:EqualityOperator',
      '4:NumericLiteral',
    ]);
    expect(generateMutants('S.swift', text, new Set([1, 2])).length).toBe(0);
  });

  it('masks comment and string contents', () => {
    const text = 'a /* b */ "c" d';
    const mask = codeMask(text);
    expect([...mask].join('')).toBe('110000000110111');
  });
});

describe('sample', () => {
  it('is deterministic and returns everything below the cap', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    expect(sample(items, 25)).toEqual(items);
    const a = sample(items, 5);
    expect(a).toEqual(sample(items, 5));
    expect(new Set(a).size).toBe(5);
  });
});

describe('readXunit', () => {
  it('reads XCTest and Swift Testing files together and strips parentheses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'useless-xunit-'));
    writeFileSync(
      join(dir, 'r.xml'),
      '<testsuites><testcase classname="M.ATests" name="testA" time="1"/><testcase classname="M.ATests" name="testB" time="1"><failure message="x"/></testcase></testsuites>',
    );
    writeFileSync(
      join(dir, 'r-swift-testing.xml'),
      '<testsuites><testcase classname="M.BSuite" name="works()" time="0.1"/></testsuites>',
    );
    expect(readXunit(join(dir, 'r.xml'))).toEqual([
      { suite: 'ATests', name: 'testA', passed: true },
      { suite: 'ATests', name: 'testB', passed: false },
      { suite: 'BSuite', name: 'works', passed: true },
    ]);
    expect(readXunit(join(dir, 'missing.xml'))).toEqual([]);
  });
});

describe('coveredLines', () => {
  it('marks lines between an executed segment and the next segment start', () => {
    const json = JSON.stringify({
      data: [
        {
          files: [
            {
              filename: '/r/Sources/A.swift',
              segments: [
                [3, 1, 5, true, true, false],
                [6, 1, 0, true, true, false],
                [8, 1, 2, true, true, false],
                [9, 1, 0, false, false, false],
              ],
            },
            { filename: '/r/Sources/B.swift', segments: [[1, 1, 0, true, true, false]] },
          ],
        },
      ],
    });
    const lines = coveredLines(json);
    expect([...(lines.get('/r/Sources/A.swift') ?? [])]).toEqual([3, 4, 5, 6, 8, 9]);
    expect(lines.has('/r/Sources/B.swift')).toBe(false);
  });
});
