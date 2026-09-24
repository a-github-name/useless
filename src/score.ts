import type { Finding, Scored, ScoredUnit, SignalName, Signals, Verdict } from './types.js';

/** Weights sum to 100 so a score reads as "% of maximum plausible uselessness". */
export const WEIGHTS: Record<SignalName, number> = {
  tautology: 40,
  weak: 12,
  mockBurden: 10,
  cost: 18,
  mirror: 8,
  environment: 7,
  skipped: 5,
};

export const FINDING_ORDER: Finding[] = [
  'duplicate',
  'restates-implementation',
  'external-dependency',
  'oversized-unit',
  'transcribes-fixture',
  'review',
  'clean',
];

/** What each finding usually means to do. The reader decides; this is a prompt, not a verdict. */
export const FINDING_GUIDANCE: Record<Finding, string> = {
  duplicate: 'read both files together; check whether each protects a distinct contract',
  'restates-implementation':
    'check whether these assertions protect an independent contract or only the current implementation',
  'external-dependency': 'check the contract and whether the unit suite is the right place for it',
  'oversized-unit': 'inspect the module and test boundaries before splitting either',
  'transcribes-fixture': 'check whether exact output is the contract or incidental fixture data',
  review: 'worth a human read; the reasons say why',
  clean: 'no signal worth acting on',
};

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Map raw signals to [0, 1] components, weight them, and attach a finding
 * plus the human-readable reasons behind it. Per-test units are scored with
 * the same rules; a file whose units restate the implementation says so.
 */
export function score(signals: Signals): Scored {
  const { units: rawUnits, ...file } = signals;
  const verdict = evaluate(file);
  const units: ScoredUnit[] = (rawUnits ?? []).map((u) => ({ ...u, ...evaluate(u) }));
  const restating = units.filter((u) => u.finding === 'restates-implementation').length;
  let finding = verdict.finding;
  if (restating > 0 && finding !== 'restates-implementation' && finding !== 'duplicate') {
    verdict.reasons.push(`${restating} of ${units.length} tests restate the implementation`);
    if (restating >= 3 && finding === 'clean') finding = 'review';
  }
  return { ...file, ...verdict, finding, units };
}

function evaluate(signals: Omit<Signals, 'units'>): Verdict {
  const reasons: string[] = [];
  const tests = Math.max(1, signals.tests);
  const expects = Math.max(1, signals.expects);

  // 1. Tautology: assertions about source text, repo files, SQL text, repo
  //    history, or mocks having been called. A bare `toHaveBeenCalled()` is a
  //    full point; checking the count, absence, or arguments is half, and less
  //    again when nothing is module-mocked, because then the fake was injected
  //    and the call is the boundary being tested.
  const callBare = signals.callExpects - signals.callExpectsWith - signals.callExpectsCounted;
  const injected = signals.moduleMocks === 0;
  const callShare =
    (callBare +
      signals.callExpectsCounted * (injected ? 0.35 : 0.5) +
      signals.callExpectsWith * (injected ? 0.3 : 0.5)) /
    expects;
  const tautology = clamp(
    (signals.sourceTextAsserts * 2 +
      signals.repoTextAsserts * 1.5 +
      signals.sqlTextAsserts +
      signals.gitShellouts * 3) /
      expects +
      callShare,
  );
  if (signals.sourceTextAsserts > 0)
    reasons.push(`asserts on source text ×${signals.sourceTextAsserts}`);
  if (signals.repoTextAsserts > 0)
    reasons.push(`greps ${signals.repoTextAsserts} assertions over repo file contents`);
  if (signals.sqlTextAsserts > 0) reasons.push(`pins SQL text ×${signals.sqlTextAsserts}`);
  if (signals.gitShellouts > 0) reasons.push(`depends on git history ×${signals.gitShellouts}`);
  if (signals.callExpects / expects > 0.4) {
    const checked =
      (signals.callExpectsWith + signals.callExpectsCounted) / Math.max(1, signals.callExpects);
    const detail =
      checked >= 0.5
        ? ` (${signals.callExpectsWith >= signals.callExpectsCounted ? 'with args' : 'counted'}${injected ? ', injected fakes' : ''})`
        : '';
    reasons.push(`${pct(signals.callExpects / expects)} of expects are "mock was called"${detail}`);
  }

  // 2. Weak assertions: presence checks that pass for almost any output.
  const weak = clamp(signals.weakExpects / expects);
  if (weak > 0.5) reasons.push(`${pct(weak)} weak assertions`);
  if (signals.expects === 0 && signals.tests > 0) reasons.push('no assertions found');

  // 3. Mock burden: module mocks pin sibling modules; fn stubs on a
  //    hand-rolled fake are cheaper, so they weigh less.
  const mockBurden = clamp(signals.mocks / tests / 10) * 0.4 + clamp(signals.moduleMocks / 8) * 0.6;
  if (signals.moduleMocks >= 5) reasons.push(`${signals.moduleMocks} module mocks`);
  else if (signals.mocks / tests > 4)
    reasons.push(`${(signals.mocks / tests).toFixed(1)} mocks per test`);

  // 4. Cost: lines per test, wall-clock time, and duplication.
  const linesPerTest = signals.lines / tests;
  const durationMs = signals.durationMs ?? 0;
  const shared = signals.similarTo?.share ?? 0;
  const harness = signals.sharedHarnessFiles >= 3 ? clamp(signals.sharedHarnessLines / 200) : 0;
  const cost = signals.duplicateOf
    ? 1
    : clamp(
        clamp(linesPerTest / 120) * 0.6 +
          clamp(durationMs / 20_000) * 0.4 +
          (shared >= 0.5 ? shared * 0.5 : 0) +
          harness * 0.3,
      );
  if (signals.sharedHarnessFiles >= 3 && signals.sharedHarnessLines >= 40)
    reasons.push(
      `${signals.sharedHarnessLines} lines of setup duplicated across ${signals.sharedHarnessFiles} files`,
    );

  if (signals.duplicateOf) reasons.push(`identical to ${signals.duplicateOf}`);
  else if (signals.similarTo && shared >= 0.5)
    reasons.push(`${pct(shared)} of its lines also appear in ${signals.similarTo.file}`);
  if (linesPerTest > 80) reasons.push(`${Math.round(linesPerTest)} lines per test`);
  if (durationMs > 10_000) reasons.push(`${Math.round(durationMs / 1000)}s runtime`);

  // 5. Mirror: the test transcribes a fixture rather than stating a contract.
  //    Pinned digests, pinned sizes, snapshots and deleted-file asserts are
  //    the tell; on data subjects, a high literal share is too. A file that is
  //    mostly multi-line literal expectation counts only for its excess over
  //    40%: full-object `toEqual` assertions are usually strong tests, and
  //    reviewers rated them that way.
  const literalShare = signals.literalExpects / expects;
  const literalLineShare = signals.literalLines / Math.max(1, signals.lines);
  const mirror = clamp(
    Math.max(0, literalLineShare - 0.4) * 2 +
      signals.snapshotAsserts / tests +
      signals.inlineSnapshots / tests / 2 +
      signals.digestPins / 4 +
      signals.countPins / tests / 2 +
      signals.deletedFileAsserts / 3 +
      (signals.dataSubject ? literalShare : 0),
  );
  if (literalLineShare >= 0.4 && signals.largeLiteralExpects >= 3)
    reasons.push(
      `${pct(literalLineShare)} of the file is literal expectation (${signals.largeLiteralExpects} blocks)`,
    );
  if (signals.snapshotAsserts > 0) reasons.push(`${signals.snapshotAsserts} file snapshot(s)`);
  if (signals.inlineSnapshots >= 3) reasons.push(`${signals.inlineSnapshots} inline snapshots`);
  if (signals.digestPins > 0) reasons.push(`pins ${signals.digestPins} sha256 digest(s)`);
  if (signals.countPins >= 3) reasons.push(`pins ${signals.countPins} collection sizes`);
  if (signals.deletedFileAsserts > 0) reasons.push('asserts files stay deleted');
  if (signals.dataSubject && literalShare > 0.7 && signals.mocks === 0)
    reasons.push(`${pct(literalShare)} literal assertions on a data module`);

  // 6. Environment coupling: external interpreters, real clocks, this machine.
  const environment = clamp(
    signals.pythonShellouts / 2 +
      signals.realWaits / 3 +
      signals.machinePaths / 2 +
      signals.dependencyGates / tests,
  );
  if (signals.pythonShellouts > 0) reasons.push('shells out to python/uv');
  if (signals.realWaits > 0) reasons.push(`${signals.realWaits} real-clock wait(s)`);
  if (signals.machinePaths > 0) reasons.push('reads the real home directory');
  if (signals.dependencyGates > 0)
    reasons.push(
      `${signals.dependencyGates} test(s) run only with a GPU, a binary, a model, or an env opt-in`,
    );

  // 7. Skipped, gated, or focused tests are cost with no guaranteed signal.
  const skipped = clamp((signals.skipped + signals.gatedSuites + signals.focused * 2) / tests);
  if (signals.skipped > 0) reasons.push(`${signals.skipped} skipped`);
  if (signals.machineGates > 0) reasons.push('suite gated on this machine');
  else if (signals.gatedSuites > signals.dependencyGates)
    reasons.push(`${signals.gatedSuites - signals.dependencyGates} conditional suite(s)`);
  if (signals.focused > 0) reasons.push(`.only left in (${signals.focused})`);

  const components: Record<SignalName, number> = {
    tautology,
    weak,
    mockBurden,
    cost,
    mirror,
    environment,
    skipped,
  };
  let total = 0;
  for (const name of Object.keys(WEIGHTS) as SignalName[])
    total += components[name] * WEIGHTS[name];

  let finding: Finding = 'clean';
  if (signals.duplicateOf || shared >= 0.9) finding = 'duplicate';
  else if (
    tautology > 0.6 ||
    signals.machineGates > 0 ||
    // Reading repo source is only damning when those assertions dominate the
    // file: a large test that reads one source file among forty behavioural
    // assertions is not a source grep.
    (signals.repoTextAsserts >= 5 && signals.repoTextAsserts / expects >= 0.5)
  )
    finding = 'restates-implementation';
  else if (signals.pythonShellouts > 0 || signals.dependencyGates >= Math.ceil(tests / 2))
    finding = 'external-dependency';
  else if (
    signals.sourceLines !== null &&
    signals.sourceLines > 1500 &&
    (mockBurden > 0.5 || weak > 0.5 || signals.lines > 1000)
  ) {
    finding = 'oversized-unit';
    if ((signals.sourceFiles ?? 1) > 1)
      reasons.push(
        `tests a barrel over ${signals.sourceFiles} files (${signals.sourceLines} lines) as one unit`,
      );
  } else if (
    (literalLineShare >= 0.5 && signals.largeLiteralExpects >= 5) ||
    (signals.snapshotAsserts >= 3 && signals.snapshotAsserts >= tests / 2) ||
    signals.digestPins >= 5 ||
    (signals.dataSubject && literalShare > 0.7 && signals.mocks === 0)
  )
    finding = 'transcribes-fixture';
  else if (
    total >= 35 ||
    signals.moduleMocks >= 10 ||
    signals.focused > 0 ||
    (shared >= 0.7 && signals.lines > 100 && total >= 12)
  )
    finding = 'review';

  return { score: Math.round(total * 10) / 10, components, reasons, finding };
}
