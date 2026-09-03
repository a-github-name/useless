import { describe, expect, it } from 'vitest';
import { analyzeTest } from './signals.js';
import type { Churn } from './types.js';

const churn: Churn = { testCommits: 1, sourceCommits: 1, coChangeCommits: 1 };

function analyze(text: string, file = 'src/thing.test.ts', sourceText: string | null = null) {
  return analyzeTest({
    file,
    text,
    source: sourceText === null ? null : 'src/thing.ts',
    sourceText,
    churn,
    timing: null,
  });
}

describe('analyzeTest', () => {
  it('counts tests including modifiers and table forms', () => {
    const text = [
      "it('a', () => {});",
      "test('b', () => {});",
      "it.skip('c', () => {});",
      "test.each([1, 2])('d %i', () => {});",
      "it.skipIf(process.platform === 'win32')('e', () => {});",
      "describe('not a test', () => {});",
    ].join('\n');
    const s = analyze(text);
    expect(s.tests).toBe(5);
    expect(s.skipped).toBe(1);
    expect(s.gatedSuites).toBe(1);
  });

  it('separates weak presence checks from real assertions', () => {
    const text = [
      'expect(x).toBeTruthy();',
      'expect(x).toBeDefined();',
      'expect(fn).toHaveBeenCalled();',
      "expect(x).toBe('literal');",
      'expect(list).toEqual([1, 2]);',
    ].join('\n');
    const s = analyze(text);
    expect(s.expects).toBe(5);
    expect(s.weakExpects).toBe(3);
    expect(s.callExpects).toBe(1);
    expect(s.literalExpects).toBe(2);
  });

  it('weighs module mocks separately from fn stubs, for vitest and jest', () => {
    const text = [
      "vi.mock('./a');",
      "jest.mock('./b');",
      'const f = vi.fn();',
      "const g = jest.spyOn(obj, 'm');",
      "vi.stubEnv('X', '1');",
    ].join('\n');
    const s = analyze(text);
    expect(s.mocks).toBe(5);
    expect(s.moduleMocks).toBe(2);
  });

  it('flags source-text assertions and greps over repo source files', () => {
    const text = [
      "const src = readFileSync('src/app.tsx', 'utf8');",
      "expect(src).toContain('export function');",
      'expect(src).toMatch(/import .* from/);',
      "expect(src).not.toContain('any');",
    ].join('\n');
    const s = analyze(text);
    expect(s.sourceTextAsserts).toBeGreaterThanOrEqual(2);
    expect(s.repoTextAsserts).toBe(3);
  });

  it('does not treat reading a JSON fixture or a tmpdir as grepping the repo', () => {
    const fixture = [
      "const data = readFileSync('fixtures/cases.json', 'utf8');",
      'expect(JSON.parse(data).length).toBe(3);',
    ].join('\n');
    expect(analyze(fixture).repoTextAsserts).toBe(0);
    const tmp = [
      "const dir = mkdtempSync('x');",
      "writeFileSync(join(dir, 'out.ts'), 'export {}');",
      "expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain('export');",
    ].join('\n');
    expect(analyze(tmp).repoTextAsserts).toBe(0);
  });

  it('detects git history and python dependencies', () => {
    const s = analyze(
      [
        "execFileSync('git', ['log', '--oneline']);",
        "expect(diff).not.toContain('origin/main');",
        "spawnSync('uv', ['run', 'script.py']);",
      ].join('\n'),
    );
    expect(s.gitShellouts).toBeGreaterThanOrEqual(2);
    expect(s.pythonShellouts).toBeGreaterThanOrEqual(1);
  });

  it('detects transcription: digests, count pins, large literals, deleted-file asserts', () => {
    const digest = 'a'.repeat(64);
    const s = analyze(
      [
        `expect(hash).toBe('sha256:${digest}');`,
        `expect(other).toBe('${digest}');`,
        'expect(items).toHaveLength(12);',
        'expect(items).toHaveLength(2);',
        'expect(result).toEqual({',
        '  a: 1,',
        '});',
        "expect(existsSync('old.ts')).toBe(false);",
      ].join('\n'),
    );
    expect(s.digestPins).toBe(2);
    expect(s.countPins).toBe(1);
    expect(s.largeLiteralExpects).toBe(1);
    expect(s.deletedFileAsserts).toBe(1);
  });

  it('marks data subjects by path, JSON import, or a source with few functions', () => {
    expect(analyze('', 'src/config/layers.test.ts').dataSubject).toBe(true);
    expect(analyze("import cases from './cases.json';").dataSubject).toBe(true);
    expect(
      analyze('', 'src/thing.test.ts', 'export const A = 1;\nexport const B = 2;').dataSubject,
    ).toBe(true);
    const fns = 'export function a() {}\nexport const b = () => 1;\nexport function c() {}';
    expect(analyze('', 'src/thing.test.ts', fns).dataSubject).toBe(false);
  });

  it('passes churn and timing through and counts lines', () => {
    const s = analyzeTest({
      file: 'x.test.ts',
      text: 'a\nb\nc',
      source: 'x.ts',
      sourceText: '1\n2',
      churn: { testCommits: 4, sourceCommits: 9, coChangeCommits: 3 },
      timing: { durationMs: 1500, failed: true },
    });
    expect(s.lines).toBe(3);
    expect(s.sourceLines).toBe(2);
    expect(s.coChangeCommits).toBe(3);
    expect(s.durationMs).toBe(1500);
    expect(s.failed).toBe(true);
  });
});
