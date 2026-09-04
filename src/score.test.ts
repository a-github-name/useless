import { describe, expect, it } from 'vitest';
import { WEIGHTS, score } from './score.js';
import type { Signals } from './types.js';

const base: Signals = {
  file: 'src/thing.test.ts',
  source: 'src/thing.ts',
  lines: 120,
  sourceLines: 200,
  sourceFiles: 1,
  tests: 6,
  expects: 12,
  weakExpects: 1,
  callExpects: 0,
  callExpectsWith: 0,
  callExpectsCounted: 0,
  sqlTextAsserts: 0,
  mocks: 0,
  moduleMocks: 0,
  sourceTextAsserts: 0,
  repoTextAsserts: 0,
  literalExpects: 8,
  dataSubject: false,
  fixtureImports: 0,
  largeLiteralExpects: 0,
  literalLines: 0,
  snapshotAsserts: 0,
  inlineSnapshots: 0,
  digestPins: 0,
  countPins: 0,
  deletedFileAsserts: 0,
  gatedSuites: 0,
  machineGates: 0,
  gitShellouts: 0,
  pythonShellouts: 0,
  realWaits: 0,
  machinePaths: 0,
  skipped: 0,
  focused: 0,
  duplicateOf: null,
  similarTo: null,
  sharedHarnessLines: 0,
  sharedHarnessFiles: 0,
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
    expect(s.finding).toBe('clean');
    expect(s.score).toBeLessThan(15);
    expect(s.reasons).toEqual([]);
    for (const value of Object.values(s.components)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('churn is reported but never scored: co-editing tracks feature work', () => {
    const coupled = score(withSignals({ sourceCommits: 20, coChangeCommits: 20 }));
    expect(coupled.score).toBe(score(base).score);
    expect(coupled.reasons).toEqual([]);
    expect(Object.keys(coupled.components)).not.toContain('lockstep');
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
        literalLines: 5000,
        skipped: 5,
        gatedSuites: 2,
        durationMs: 60_000,
        sourceCommits: 20,
        coChangeCommits: 20,
      }),
    );
    expect(s.score).toBe(100);
  });

  it('git shell-outs raise tautology but do not decide the finding on their own', () => {
    // Installer and scaffolding tests legitimately drive a git shim; only the
    // share of the file given over to it should matter.
    const few = score(withSignals({ gitShellouts: 1, expects: 40 }));
    expect(few.finding).toBe('clean');
    expect(few.reasons).toContain('depends on git history ×1');
    expect(few.components.tautology).toBeGreaterThan(0);
    const dominated = score(withSignals({ gitShellouts: 6, expects: 12 }));
    expect(dominated.finding).toBe('restates-implementation');
  });

  it('repo-source greps are only damning when they dominate the file', () => {
    const dominated = score(withSignals({ repoTextAsserts: 20, expects: 22 }));
    expect(dominated.finding).toBe('restates-implementation');
    // A large behavioural test that happens to read one source file keeps its
    // finding: five greps among forty assertions is not a source grep.
    const incidental = score(withSignals({ repoTextAsserts: 5, expects: 40 }));
    expect(incidental.finding).toBe('clean');
    const one = score(withSignals({ repoTextAsserts: 1, expects: 40 }));
    expect(one.finding).toBe('clean');
  });

  it('"mock was called" assertions raise tautology in proportion', () => {
    const half = score(withSignals({ callExpects: 6 }));
    const all = score(withSignals({ callExpects: 12 }));
    expect(all.components.tautology).toBeGreaterThan(half.components.tautology);
    expect(all.finding).toBe('restates-implementation');
    expect(half.reasons).toContain('50% of expects are "mock was called"');
  });

  it('argument-checked and counted calls are discounted, bare calls are not', () => {
    const bareInjected = score(withSignals({ callExpects: 12, moduleMocks: 0 }));
    const withInjected = score(
      withSignals({ callExpects: 12, callExpectsWith: 12, moduleMocks: 0 }),
    );
    const withMocked = score(withSignals({ callExpects: 12, callExpectsWith: 12, moduleMocks: 2 }));
    const counted = score(withSignals({ callExpects: 12, callExpectsCounted: 12, moduleMocks: 0 }));
    expect(bareInjected.components.tautology).toBe(1);
    expect(withMocked.components.tautology).toBeCloseTo(0.5);
    expect(withInjected.components.tautology).toBeCloseTo(0.3);
    expect(counted.components.tautology).toBeCloseTo(0.35);
    expect(withInjected.finding).toBe('clean');
    expect(withInjected.reasons).toContain(
      '100% of expects are "mock was called" (with args, injected fakes)',
    );
    expect(counted.reasons).toContain(
      '100% of expects are "mock was called" (counted, injected fakes)',
    );
  });

  it('SQL text pins count as tautology', () => {
    const s = score(withSignals({ sqlTextAsserts: 8 }));
    expect(s.components.tautology).toBeCloseTo(8 / 12);
    expect(s.finding).toBe('restates-implementation');
    expect(s.reasons).toContain('pins SQL text ×8');
  });

  it('near-duplicates raise cost and become delete-duplicate at 90% shared lines', () => {
    const near = score(withSignals({ similarTo: { file: 'src/a.test.ts', share: 0.95 } }));
    expect(near.finding).toBe('duplicate');
    const partial = score(
      withSignals({ similarTo: { file: 'src/a.test.ts', share: 0.7 }, lines: 400, weakExpects: 6 }),
    );
    expect(partial.finding).toBe('review');
    expect(partial.reasons).toContain('70% of its lines also appear in src/a.test.ts');
    expect(partial.components.cost).toBeGreaterThan(score(base).components.cost);
    const small = score(
      withSignals({ similarTo: { file: 'src/a.test.ts', share: 0.7 }, lines: 60, weakExpects: 6 }),
    );
    expect(small.finding).toBe('clean');
    const cheap = score(
      withSignals({ similarTo: { file: 'src/a.test.ts', share: 0.8 }, lines: 200, tests: 20 }),
    );
    expect(cheap.score).toBeLessThan(12);
    expect(cheap.finding).toBe('clean');
  });

  it('a huge test on a huge source is refactor-source even without mocks', () => {
    expect(score(withSignals({ sourceLines: 9000, lines: 4600, tests: 70 })).finding).toBe(
      'oversized-unit',
    );
    const barrel = score(
      withSignals({ sourceLines: 4098, sourceFiles: 9, lines: 2266, tests: 21 }),
    );
    expect(barrel.finding).toBe('oversized-unit');
    expect(barrel.reasons).toContain('tests a barrel over 9 files (4098 lines) as one unit');
  });

  it('duplicated setup raises cost and is named', () => {
    const s = score(withSignals({ sharedHarnessLines: 96, sharedHarnessFiles: 19 }));
    expect(s.reasons).toContain('96 lines of setup duplicated across 19 files');
    expect(s.components.cost).toBeGreaterThan(score(base).components.cost);
    expect(score(withSignals({ sharedHarnessLines: 96, sharedHarnessFiles: 2 })).reasons).toEqual(
      [],
    );
  });

  it('duplicates are delete-duplicate with saturated cost', () => {
    const dup = score(withSignals({ duplicateOf: 'src/other.test.ts' }));
    expect(dup.finding).toBe('duplicate');
    expect(dup.components.cost).toBe(1);
    expect(dup.reasons).toContain('identical to src/other.test.ts');
  });

  it('home-directory reads and real waits raise environment; .only forces review', () => {
    const home = score(withSignals({ machinePaths: 1 }));
    expect(home.finding).toBe('clean');
    expect(home.reasons).toContain('reads the real home directory');
    const waits = score(withSignals({ realWaits: 2 }));
    expect(waits.finding).toBe('clean');
    expect(waits.components.environment).toBeCloseTo(2 / 3);
    const focused = score(withSignals({ focused: 1 }));
    expect(focused.finding).toBe('review');
    expect(focused.reasons).toContain('.only left in (1)');
  });

  it('a file with tests but no assertions says so', () => {
    expect(score(withSignals({ expects: 0, weakExpects: 0, literalExpects: 0 })).reasons).toContain(
      'no assertions found',
    );
  });

  it('python shell-outs route to move-to-integration', () => {
    expect(score(withSignals({ pythonShellouts: 2 })).finding).toBe('external-dependency');
  });

  it('a heavily mocked or weak test of a huge module blames the source', () => {
    const mocked = score(withSignals({ sourceLines: 3000, moduleMocks: 8 }));
    expect(mocked.finding).toBe('oversized-unit');
    const weak = score(withSignals({ sourceLines: 3000, weakExpects: 10 }));
    expect(weak.finding).toBe('oversized-unit');
    const small = score(withSignals({ sourceLines: 300, moduleMocks: 8 }));
    expect(small.finding).not.toBe('oversized-unit');
  });

  it('transcribed fixtures become rewrite-as-contract', () => {
    const literal = score(withSignals({ dataSubject: true, literalExpects: 11 }));
    expect(literal.finding).toBe('transcribes-fixture');
    expect(literal.reasons).toContain('92% literal assertions on a data module');
    const large = score(withSignals({ largeLiteralExpects: 6, literalLines: 72, lines: 120 }));
    expect(large.finding).toBe('transcribes-fixture');
    expect(large.reasons).toContain('60% of the file is literal expectation (6 blocks)');
    const fewButBig = score(withSignals({ largeLiteralExpects: 2, literalLines: 72, lines: 120 }));
    expect(fewButBig.finding).toBe('clean');
    const fullObjects = score(
      withSignals({ largeLiteralExpects: 6, literalLines: 36, lines: 120 }),
    );
    expect(fullObjects.components.mirror).toBe(0);
    expect(fullObjects.finding).toBe('clean');
    const snapshots = score(withSignals({ snapshotAsserts: 3 }));
    expect(snapshots.finding).toBe('transcribes-fixture');
    const fewSnapshots = score(withSignals({ snapshotAsserts: 3, tests: 20 }));
    expect(fewSnapshots.finding).toBe('clean');
  });

  it('machine-gated suites are delete-or-rewrite; platform gates and skips are not', () => {
    expect(score(withSignals({ gatedSuites: 1 })).finding).toBe('clean');
    expect(score(withSignals({ gatedSuites: 1, machineGates: 1 })).finding).toBe(
      'restates-implementation',
    );
    expect(score(withSignals({ digestPins: 3 })).finding).toBe('clean');
    expect(score(withSignals({ digestPins: 5 })).finding).toBe('transcribes-fixture');
    expect(score(withSignals({ skipped: 1 })).finding).toBe('clean');
  });

  it('many module mocks alone are worth a review', () => {
    expect(score(withSignals({ moduleMocks: 10 })).finding).toBe('review');
  });

  it('runtime and lines per test feed cost but do not change the verdict on their own', () => {
    const slow = score(withSignals({ durationMs: 30_000, lines: 1200, tests: 6 }));
    expect(slow.components.cost).toBeGreaterThan(0.9);
    expect(slow.reasons).toEqual(expect.arrayContaining(['200 lines per test', '30s runtime']));
    expect(slow.finding).toBe('clean');
  });
});
