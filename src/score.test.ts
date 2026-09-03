import { describe, expect, it } from 'vitest';
import { WEIGHTS, score } from './score.js';
import type { Signals } from './types.js';

const base: Signals = {
  file: 'src/thing.test.ts',
  source: 'src/thing.ts',
  lines: 120,
  sourceLines: 200,
  tests: 6,
  expects: 12,
  weakExpects: 1,
  callExpects: 0,
  mocks: 0,
  moduleMocks: 0,
  sourceTextAsserts: 0,
  repoTextAsserts: 0,
  literalExpects: 8,
  dataSubject: false,
  fixtureImports: 0,
  largeLiteralExpects: 0,
  digestPins: 0,
  countPins: 0,
  deletedFileAsserts: 0,
  gatedSuites: 0,
  gitShellouts: 0,
  pythonShellouts: 0,
  skipped: 0,
  testCommits: 3,
  sourceCommits: 8,
  coChangeCommits: 2,
  durationMs: 400,
  failed: false,
};

const withSignals = (overrides: Partial<Signals>): Signals => ({ ...base, ...overrides });

describe('score', () => {
  it('weights sum to 100 and a clean test scores low with no reasons', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    const s = score(base);
    expect(s.verdict).toBe('keep');
    expect(s.score).toBeLessThan(15);
    expect(s.reasons).toEqual([]);
    for (const value of Object.values(s.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('never exceeds 100 even when every signal saturates', () => {
    const s = score(
      withSignals({
        lines: 5000,
        tests: 1,
        expects: 1,
        weakExpects: 1,
        callExpects: 1,
        mocks: 50,
        moduleMocks: 20,
        sourceTextAsserts: 5,
        repoTextAsserts: 5,
        gitShellouts: 3,
        pythonShellouts: 3,
        digestPins: 10,
        skipped: 5,
        gatedSuites: 2,
        durationMs: 60_000,
        sourceCommits: 20,
        coChangeCommits: 20,
      }),
    );
    expect(s.score).toBe(100);
  });

  it('git shell-outs are always delete-or-rewrite', () => {
    const s = score(withSignals({ gitShellouts: 1 }));
    expect(s.verdict).toBe('delete-or-rewrite');
    expect(s.reasons).toContain('depends on git history ×1');
  });

  it('grepping repo source is delete-or-rewrite once it dominates the file', () => {
    expect(score(withSignals({ repoTextAsserts: 5, expects: 40 })).verdict).toBe(
      'delete-or-rewrite',
    );
    expect(score(withSignals({ repoTextAsserts: 1, expects: 40 })).verdict).toBe('keep');
  });

  it('"mock was called" assertions raise tautology in proportion', () => {
    const half = score(withSignals({ callExpects: 6 }));
    const all = score(withSignals({ callExpects: 12 }));
    expect(all.components.tautology).toBeGreaterThan(half.components.tautology);
    expect(all.verdict).toBe('delete-or-rewrite');
    expect(half.reasons).toContain('50% of expects are "mock was called"');
  });

  it('python shell-outs route to move-to-integration', () => {
    expect(score(withSignals({ pythonShellouts: 2 })).verdict).toBe('move-to-integration');
  });

  it('a heavily mocked or weak test of a huge module blames the source', () => {
    const mocked = score(withSignals({ sourceLines: 3000, moduleMocks: 8 }));
    expect(mocked.verdict).toBe('refactor-source');
    const weak = score(withSignals({ sourceLines: 3000, weakExpects: 10 }));
    expect(weak.verdict).toBe('refactor-source');
    const small = score(withSignals({ sourceLines: 300, moduleMocks: 8 }));
    expect(small.verdict).not.toBe('refactor-source');
  });

  it('transcribed fixtures become rewrite-as-contract', () => {
    const literal = score(withSignals({ dataSubject: true, literalExpects: 11 }));
    expect(literal.verdict).toBe('rewrite-as-contract');
    expect(literal.reasons).toContain('92% literal assertions on a data module');
    const large = score(withSignals({ largeLiteralExpects: 6, tests: 4, countPins: 4 }));
    expect(large.verdict).toBe('rewrite-as-contract');
  });

  it('lockstep needs history before it counts', () => {
    const young = score(withSignals({ sourceCommits: 3, coChangeCommits: 3 }));
    expect(young.components.lockstep).toBe(0);
    const coupled = score(withSignals({ sourceCommits: 12, coChangeCommits: 11 }));
    expect(coupled.components.lockstep).toBeGreaterThan(0.85);
    expect(coupled.verdict).toBe('rewrite-as-contract');
    const midHistory = score(withSignals({ sourceCommits: 6, coChangeCommits: 6 }));
    expect(midHistory.reasons).toContain('edited in 6/6 source commits (lockstep)');
    expect(midHistory.verdict).toBe('keep');
  });

  it('gated suites and digest pins are delete-or-rewrite; a couple of skips are not', () => {
    expect(score(withSignals({ gatedSuites: 1 })).verdict).toBe('delete-or-rewrite');
    expect(score(withSignals({ digestPins: 3 })).verdict).toBe('delete-or-rewrite');
    expect(score(withSignals({ skipped: 1 })).verdict).toBe('keep');
  });

  it('many module mocks alone are worth a review', () => {
    expect(score(withSignals({ moduleMocks: 10 })).verdict).toBe('review');
  });

  it('runtime and lines per test feed cost but do not change the verdict on their own', () => {
    const slow = score(withSignals({ durationMs: 30_000, lines: 1200, tests: 6 }));
    expect(slow.components.cost).toBeGreaterThan(0.9);
    expect(slow.reasons).toEqual(expect.arrayContaining(['200 lines per test', '30s runtime']));
    expect(slow.verdict).toBe('keep');
  });
});
