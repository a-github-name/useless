/** Raw, cheaply computed facts about one test file. */
export type Signals = {
  file: string;
  /** Co-located source file the test is named after, if one exists. */
  source: string | null;
  lines: number;
  sourceLines: number | null;
  tests: number;
  /** `expect(...)` and `assert.*(...)` calls. */
  expects: number;
  /** Presence checks that pass for almost any output. */
  weakExpects: number;
  /** Every `toHaveBeenCalled*` assertion. */
  callExpects: number;
  /** The subset that checks arguments (`toHaveBeenCalledWith`, `...ExactlyOnceWith`). */
  callExpectsWith: number;
  /** The subset that checks a count or absence (`Times`, `Once`, `not.toHaveBeenCalled`). */
  callExpectsCounted: number;
  /** `toContain` / `toMatch` over SQL text. */
  sqlTextAsserts: number;
  /** Every `vi.*` / `jest.*` mocking call. */
  mocks: number;
  /** `vi.mock` / `jest.mock` module replacements only. */
  moduleMocks: number;
  /** Assertions over repo source text (imports, exports, CSS, markup). */
  sourceTextAsserts: number;
  /** Assertions made after reading source-like repo files. */
  repoTextAsserts: number;
  /** Assertions against a literal value. */
  literalExpects: number;
  /** The subject looks like data (config path, or a source with no real functions). */
  dataSubject: boolean;
  fixtureImports: number;
  /** Multi-line `toEqual({` / `toEqual([` literal expectations. */
  largeLiteralExpects: number;
  /** Lines occupied by those multi-line literals. */
  literalLines: number;
  snapshotAsserts: number;
  inlineSnapshots: number;
  digestPins: number;
  countPins: number;
  deletedFileAsserts: number;
  gatedSuites: number;
  /** Gates that depend on this machine: a path existing, the home directory, a local env var. */
  machineGates: number;
  gitShellouts: number;
  pythonShellouts: number;
  /** Real-clock waits (`setTimeout` promises, `sleep(...)`) without fake timers. */
  realWaits: number;
  /** Home-directory or absolute machine paths. */
  machinePaths: number;
  skipped: number;
  /** `.only` left in the file. */
  focused: number;
  /** Another test file whose whitespace-stripped content is identical. */
  duplicateOf: string | null;
  /** Another test file sharing most of this file's distinct lines, and the share. */
  similarTo: { file: string; share: number } | null;
  testCommits: number;
  sourceCommits: number;
  coChangeCommits: number;
  durationMs: number | null;
  failed: boolean;
};

export type Verdict =
  | 'delete-duplicate'
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
