import type { Scored, SignalName, Signals, Verdict } from './types.js';

/** Weights sum to 100 so a score reads as "% of maximum plausible uselessness". */
export const WEIGHTS: Record<SignalName, number> = {
  tautology: 25,
  weak: 15,
  mockBurden: 15,
  cost: 12,
  mirror: 10,
  lockstep: 10,
  environment: 8,
  skipped: 5,
};

export const VERDICT_ORDER: Verdict[] = [
  'delete-duplicate',
  'delete-or-rewrite',
  'move-to-integration',
  'refactor-source',
  'rewrite-as-contract',
  'review',
  'keep',
];

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));
const pct = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Map raw signals to [0, 1] components, weight them, and attach a verdict
 * hint plus the human-readable reasons behind it.
 */
export function score(signals: Signals): Scored {
  const reasons: string[] = [];
  const tests = Math.max(1, signals.tests);
  const expects = Math.max(1, signals.expects);

  // 1. Tautology: assertions about source text, repo files, repo history, or
  //    mocks having been called. A bare `toHaveBeenCalled()` is worth a full
  //    point; checking the arguments is half, and less again when nothing is
  //    module-mocked, because then the fakes were injected and the call is
  //    the boundary being tested.
  const callBare = signals.callExpects - signals.callExpectsWith;
  const injected = signals.moduleMocks === 0;
  const callShare = (callBare + signals.callExpectsWith * (injected ? 0.3 : 0.5)) / expects;
  const tautology = clamp(
    (signals.sourceTextAsserts * 2 + signals.repoTextAsserts * 1.5 + signals.gitShellouts * 3) /
      expects +
      callShare,
  );
  if (signals.sourceTextAsserts > 0)
    reasons.push(`asserts on source text ×${signals.sourceTextAsserts}`);
  if (signals.repoTextAsserts > 0)
    reasons.push(`greps ${signals.repoTextAsserts} assertions over repo file contents`);
  if (signals.gitShellouts > 0) reasons.push(`depends on git history ×${signals.gitShellouts}`);
  if (signals.callExpects / expects > 0.4) {
    const withArgs = signals.callExpectsWith / Math.max(1, signals.callExpects) >= 0.5;
    const detail = withArgs ? ` (with args${injected ? ', injected fakes' : ''})` : '';
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
  const cost = signals.duplicateOf
    ? 1
    : clamp(linesPerTest / 120) * 0.6 + clamp(durationMs / 20_000) * 0.4;
  if (signals.duplicateOf) reasons.push(`identical to ${signals.duplicateOf}`);
  if (linesPerTest > 80) reasons.push(`${Math.round(linesPerTest)} lines per test`);
  if (durationMs > 10_000) reasons.push(`${Math.round(durationMs / 1000)}s runtime`);

  // 5. Mirror: the test transcribes a fixture rather than stating a contract.
  //    Measured by how much of the file is multi-line literal expectation,
  //    plus snapshots, pinned digests and pinned sizes; on data subjects, a
  //    high literal share counts too.
  const literalShare = signals.literalExpects / expects;
  const literalLineShare = signals.literalLines / Math.max(1, signals.lines);
  const mirror = clamp(
    literalLineShare * 1.5 +
      signals.snapshotAsserts / tests +
      signals.inlineSnapshots / tests / 2 +
      signals.digestPins / 4 +
      signals.countPins / tests / 2 +
      signals.deletedFileAsserts / 3 +
      (signals.dataSubject ? literalShare : 0),
  );
  if (literalLineShare >= 0.25 && signals.largeLiteralExpects >= 3)
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

  // 6. Lockstep: the test is edited in (nearly) every commit that touches the
  //    source, so it restates the implementation rather than a contract.
  //    Only meaningful once the source has some history.
  const lockstep =
    signals.sourceCommits >= 5 ? clamp(signals.coChangeCommits / signals.sourceCommits) : 0;
  if (lockstep >= 0.85)
    reasons.push(
      `edited in ${signals.coChangeCommits}/${signals.sourceCommits} source commits (lockstep)`,
    );

  // 7. Environment coupling: external interpreters, real clocks, this machine.
  const environment = clamp(
    signals.pythonShellouts / 2 + signals.realWaits / 3 + signals.machinePaths / 2,
  );
  if (signals.pythonShellouts > 0) reasons.push('shells out to python/uv');
  if (signals.realWaits > 0) reasons.push(`${signals.realWaits} real-clock wait(s)`);
  if (signals.machinePaths > 0) reasons.push('reads the real home directory');

  // 8. Skipped, gated, or focused tests are cost with no guaranteed signal.
  const skipped = clamp((signals.skipped + signals.gatedSuites + signals.focused * 2) / tests);
  if (signals.skipped > 0) reasons.push(`${signals.skipped} skipped`);
  if (signals.gatedSuites > 0) reasons.push('suite gated on local environment');
  if (signals.focused > 0) reasons.push(`.only left in (${signals.focused})`);

  const components: Record<SignalName, number> = {
    tautology,
    weak,
    mockBurden,
    cost,
    mirror,
    lockstep,
    environment,
    skipped,
  };
  let total = 0;
  for (const name of Object.keys(WEIGHTS) as SignalName[])
    total += components[name] * WEIGHTS[name];

  let verdict: Verdict = 'keep';
  if (signals.duplicateOf) verdict = 'delete-duplicate';
  else if (
    signals.gitShellouts > 0 ||
    tautology > 0.6 ||
    signals.digestPins >= 3 ||
    signals.gatedSuites > 0 ||
    signals.repoTextAsserts >= 5
  )
    verdict = 'delete-or-rewrite';
  else if (signals.pythonShellouts > 0) verdict = 'move-to-integration';
  else if (
    signals.sourceLines !== null &&
    signals.sourceLines > 1500 &&
    (mockBurden > 0.5 || weak > 0.5)
  )
    verdict = 'refactor-source';
  else if (
    (literalLineShare >= 0.3 && signals.largeLiteralExpects >= 3) ||
    signals.snapshotAsserts >= 3 ||
    (signals.dataSubject && literalShare > 0.7 && signals.mocks === 0) ||
    (lockstep >= 0.85 && signals.sourceCommits >= 10)
  )
    verdict = 'rewrite-as-contract';
  else if (total >= 35 || signals.moduleMocks >= 10 || signals.focused > 0) verdict = 'review';

  return { ...signals, score: Math.round(total * 10) / 10, components, reasons, verdict };
}
