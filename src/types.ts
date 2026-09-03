/** Raw, cheaply computed facts about one test file. */
export type Signals = {
  file: string;
  /** Co-located source file the test is named after, if one exists. */
  source: string | null;
  lines: number;
  sourceLines: number | null;
  tests: number;
  expects: number;
  /** Presence checks that pass for almost any output. */
  weakExpects: number;
  /** `toHaveBeenCalled*` family. */
  callExpects: number;
  /** Every `vi.*` / `jest.*` mocking call. */
  mocks: number;
  /** `vi.mock` / `jest.mock` module replacements only. */
  moduleMocks: number;
  /** Assertions over source text (imports, exports, CSS, markup). */
  sourceTextAsserts: number;
  /** Assertions made after reading source-like repo files. */
  repoTextAsserts: number;
  /** Assertions against a literal value. */
  literalExpects: number;
  /** The subject looks like data (config, JSON, fewer than three functions). */
  dataSubject: boolean;
  fixtureImports: number;
  /** Multi-line `toEqual({` / `toEqual([` literal expectations. */
  largeLiteralExpects: number;
  digestPins: number;
  countPins: number;
  deletedFileAsserts: number;
  gatedSuites: number;
  gitShellouts: number;
  pythonShellouts: number;
  skipped: number;
  testCommits: number;
  sourceCommits: number;
  coChangeCommits: number;
  durationMs: number | null;
  failed: boolean;
};

export type Verdict =
  | 'delete-or-rewrite'
  | 'move-to-integration'
  | 'refactor-source'
  | 'rewrite-as-contract'
  | 'review'
  | 'keep';

export type SignalName =
  | 'tautology'
  | 'weak'
  | 'mockBurden'
  | 'cost'
  | 'mirror'
  | 'lockstep'
  | 'environment'
  | 'skipped';

export type Scored = Signals & {
  /** 0–100; higher is more useless. */
  score: number;
  /** Each normalised signal in [0, 1], before weighting. */
  components: Record<SignalName, number>;
  reasons: string[];
  verdict: Verdict;
};

export type Timing = { durationMs: number; failed: boolean };

export type Churn = {
  testCommits: number;
  sourceCommits: number;
  coChangeCommits: number;
};
