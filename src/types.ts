/** Raw, cheaply computed facts about one test file. */
export type Signals = {
  file: string;
  /** Co-located source file the test is named after, if one exists. */
  source: string | null;
  lines: number;
  sourceLines: number | null;
  /** Files behind the sibling source when it is a re-export barrel (1 otherwise). */
  sourceFiles: number | null;
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
  /** Gates on a GPU, an external binary, model files, or an environment opt-in (Swift). */
  dependencyGates: number;
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
  /** Lines of this file that belong to a block repeated in three or more test files. */
  sharedHarnessLines: number;
  /** How many test files share this file's most-repeated block. */
  sharedHarnessFiles: number;
  /** Churn, reported but not scored: co-editing tracks feature work, not transcription. */
  testCommits: number;
  sourceCommits: number;
  coChangeCommits: number;
  durationMs: number | null;
  failed: boolean;
  /** Per-test rows, when the file was parsed. */
  units?: UnitSignals[];
};

/**
 * What the signals observed, not what to do about it. Naming an action the
 * scorer cannot justify ("delete") overstates what regexes can know; the
 * recommended action is a human call, made after reading the file.
 */
export type Finding =
  | 'duplicate'
  | 'restates-implementation'
  | 'external-dependency'
  | 'oversized-unit'
  | 'transcribes-fixture'
  | 'review'
  | 'clean';

export type SignalName =
  | 'tautology'
  | 'weak'
  | 'mockBurden'
  | 'cost'
  | 'mirror'
  | 'environment'
  | 'skipped';

/** One `it`/`test` block, analysed as its own text with the file as context. */
export type UnitSignals = Omit<Signals, 'units'> & {
  name: string;
  /** Suite titles and the test title joined with spaces, as test runners report it. */
  fullName: string;
  line: number;
  endLine: number;
};

export type Verdict = {
  /** 0–100; higher is more useless. */
  score: number;
  /** Each normalised signal in [0, 1], before weighting. */
  components: Record<SignalName, number>;
  reasons: string[];
  finding: Finding;
};

export type ScoredUnit = UnitSignals & Verdict;

export type Scored = Omit<Signals, 'units'> & Verdict & { units: ScoredUnit[] };

export type Timing = { durationMs: number; failed: boolean };

export type Churn = {
  /** Churn, reported but not scored: co-editing tracks feature work, not transcription. */
  testCommits: number;
  sourceCommits: number;
  coChangeCommits: number;
};
