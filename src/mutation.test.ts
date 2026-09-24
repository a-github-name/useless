import { describe, expect, it } from 'vitest';
import { type MutationReport, joinMutation, reduceReport, spearman } from './mutation.js';
import { score } from './score.js';
import type { Signals, UnitSignals } from './types.js';

const base: Signals = {
  file: 'src/a.test.ts',
  source: 'src/a.ts',
  lines: 40,
  sourceLines: 50,
  sourceFiles: 1,
  tests: 2,
  expects: 4,
  weakExpects: 0,
  callExpects: 0,
  callExpectsWith: 0,
  callExpectsCounted: 0,
  sqlTextAsserts: 0,
  mocks: 0,
  moduleMocks: 0,
  sourceTextAsserts: 0,
  repoTextAsserts: 0,
  literalExpects: 2,
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
  dependencyGates: 0,
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
  testCommits: 1,
  sourceCommits: 1,
  coChangeCommits: 1,
  durationMs: null,
  failed: false,
};
const unit = (name: string, line: number): UnitSignals => ({
  ...base,
  tests: 1,
  expects: 2,
  name,
  fullName: `suite ${name}`,
  line,
  endLine: line + 3,
});

const report: MutationReport = {
  schemaVersion: '1.0',
  projectRoot: '/repo',
  testFiles: {
    'src/a.test.ts': {
      tests: [
        { id: 't1', name: 'suite adds' },
        { id: 't2', name: 'suite   subtracts' },
        { id: 't3', name: 'dynamic title', location: { start: { line: 20 } } },
      ],
    },
    '/repo/src/b.test.ts': { tests: [{ id: 't4', name: 'other' }] },
  },
  files: {
    'src/a.ts': {
      mutants: [
        { id: '1', status: 'Killed', coveredBy: ['t1', 't2', 't4'], killedBy: ['t1', 't4'] },
        { id: '2', status: 'Killed', coveredBy: ['t1', 't2'], killedBy: ['t1'] },
        { id: '3', status: 'Survived', coveredBy: ['t1', 't2'] },
        { id: '4', status: 'Killed', coveredBy: ['t2', 't4'], killedBy: ['t2', 't4'] },
        { id: '5', status: 'Killed', coveredBy: ['t2', 't4'], killedBy: ['t2', 't4'] },
        { id: '6', status: 'Killed', coveredBy: ['t2', 't4'], killedBy: ['t2', 't4'] },
        { id: '7', status: 'NoCoverage' },
      ],
    },
    '/repo/src/c.ts': {
      mutants: [{ id: '1', status: 'Killed', coveredBy: ['t1', 't3'], killedBy: ['t3'] }],
    },
  },
};

describe('joinMutation', () => {
  it('attributes kills per file, per own source, and per unit; finds redundant tests', () => {
    const rows = [
      score({
        ...base,
        units: [unit('adds', 1), unit('subtracts', 10), unit('something else', 20)],
      }),
      score({ ...base, file: 'src/z.test.ts', source: null }),
    ];
    const { rows: joined, summary } = joinMutation(rows, report, '/repo');
    expect(summary).toMatchObject({
      mutants: 8,
      killed: 6,
      survivedCovered: 1,
      noCoverage: 1,
      tests: 4,
      matchedUnits: 3,
    });
    const a = joined[0];
    expect(a?.mutation).toEqual({
      covered: 7,
      killed: 6,
      killRate: 0.857,
      unique: 2,
      ownCovered: 6,
      ownKilled: 5,
      ownRate: 0.833,
      matchedUnits: 3,
    });
    const [adds, subtracts, dynamic] = a?.units ?? [];
    expect(adds?.mutation).toEqual({
      covered: 4,
      killed: 2,
      killRate: 0.5,
      unique: 1,
      redundantWith: null,
    });
    expect(subtracts?.mutation).toEqual({
      covered: 6,
      killed: 3,
      killRate: 0.5,
      unique: 0,
      redundantWith: { test: 'src/b.test.ts: other', share: 1 },
    });
    expect(dynamic?.mutation).toEqual({
      covered: 1,
      killed: 1,
      killRate: 1,
      unique: 1,
      redundantWith: null,
    });
    expect(joined[1]?.mutation).toBeNull();
  });

  it('reduces a report to ids, statuses and attribution', () => {
    const reduced = reduceReport({
      ...report,
      files: {
        'src/a.ts': {
          mutants: [
            {
              id: '1',
              status: 'Killed',
              coveredBy: ['t1'],
              killedBy: ['t1'],
              location: { start: { line: 4 } },
              ...({ replacement: 'x', mutatorName: 'y' } as object),
            },
          ],
        },
      },
    });
    expect(reduced.projectRoot).toBeUndefined();
    expect(reduced.files['src/a.ts']?.mutants[0]).toEqual({
      id: '1',
      status: 'Killed',
      coveredBy: ['t1'],
      killedBy: ['t1'],
      location: { start: { line: 4 } },
    });
    expect(reduced.testFiles?.['src/a.test.ts']?.tests[2]).toEqual({
      id: 't3',
      name: 'dynamic title',
      location: { start: { line: 20 } },
    });
  });
});

describe('spearman', () => {
  it('handles perfect, inverse, tied and degenerate inputs', () => {
    expect(
      spearman([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toBe(1);
    expect(
      spearman([
        [1, 3],
        [2, 2],
        [3, 1],
      ]),
    ).toBe(-1);
    expect(
      spearman([
        [1, 1],
        [1, 2],
        [2, 3],
        [3, 3],
      ]),
    ).toBe(0.889);
    expect(
      spearman([
        [1, 1],
        [2, 1],
        [3, 1],
      ]),
    ).toBeNull();
    expect(
      spearman([
        [1, 1],
        [2, 2],
      ]),
    ).toBeNull();
  });
});
