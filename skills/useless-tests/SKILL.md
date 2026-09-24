---
name: useless-tests
description: >
  Review new tests and audit a repo's test suite for useless tests: tautologies
  that grep source or assert mocks were called, transcribed fixtures,
  presence-only assertions, and giant tests that reveal an untestable module.
  Use when writing or changing tests, or when asked which tests are low-value,
  redundant, bloated, or should be deleted;
  when asked what the tests reveal about the codebase's practices; or when asked
  for a metric of test quality or "uselessness". Runs the `useless` scorer, then
  close-reads the outliers and writes an audit with per-file verdicts.
---

# Useless-tests audit

The scorer ranks; you judge. Never delete a test on the score alone.

## 1. Before writing or changing a test

Name the observable behavior or independent contract, a credible regression
that the test would catch, and why existing tests would miss it. Put the test
at the boundary that owns that behavior. Another layer needs a distinct risk,
such as transport or lifecycle behavior, to justify the same scenario.

Check whether the test needs an export, flag, wrapper, or injection hook used
only by tests. If it does, look for a way to test through a production entry
point. Prefer extending an existing case or fixture over copying its setup.

For a bug fix, run the regression test against the pre-fix code when feasible.
Confirm that it fails for the intended reason, then passes with the fix. A
test that only proves its mock responds as configured does not prove the fix.

## 2. Run the scorer

The repo must be a git checkout. Get timings first if the suite runs in under
ten minutes; otherwise skip `--timings`.

```sh
npx vitest run --reporter=json --outputFile=.vitest.json   # or jest --json --outputFile
npx useless-tests --timings .vitest.json --top 40 --json useless.json
npx useless-tests --per-test --top 40                       # individual test blocks
```

If a Stryker report exists (or the suite is small enough to make one:
`coverageAnalysis: "perTest"`, `disableBail: true`, json reporter), pass it with
`--mutation reports/mutation/mutation.json`. Every file and test then carries
its kill rate, its unique kills, and, for a test that kills nothing another
test does not, another test that makes the same recorded kills. These results
show behavior within the report's mutated sources and sampled operators;
prefer them to the heuristic within that scope.

For a Swift package (XCTest or Swift Testing) the same command works; timings
come from `swift test --parallel --xunit-output .xunit.xml` and are passed
the same way. Skip the run when the suite needs a GPU or model weights. For
mutation evidence on a Swift package, `npx useless-tests mutate --root <pkg>
--mutate 'Sources/<Lib>/*' --max 300` writes a Stryker-shaped report in a few
minutes on a small package; pass it with `--mutation` like any other.

If it is not installed, `pnpm dlx useless-tests` works.

Read the three summary lines and the table. The third line ends with "tests
flagged on their own: N of T": the parse scores every `it`/`test` block
separately, and a clean file can hide a handful of tautological tests.
`--per-test` ranks those blocks; the JSON carries them under `units`.

The second line reports duplicated
setup ("N lines of setup duplicated across M files") when a block is pasted
into three or more files; that is a suite-level finding, not a per-file one,
and belongs in the practices section. Keep `useless.json`; it holds every raw
signal and normalised component for every file.

## 3. Understand what the score means

Score is 0–100, a weighted sum of seven signals (tautology 40, cost 18, weak
12, mock burden 10, mirror 8, environment 7, skipped 5). Across 41 calibration
repos the median was about 4 and p90 about 13. Anything over 25 deserves a
read.

The `finding` column names what the signals observed. It is not an
instruction: the tool cannot know whether a test should be deleted, and saying
so on regex evidence would overstate what it can see. Findings and what they
usually mean:

- `duplicate`: identical to another test file, or nearly. A `review` with
  "N% of its lines also appear in X" is a fork or a copy-pasted harness; read
  both files together.
- `restates-implementation`: the scorer found repo-source greps, bare
  "mock was called" assertions, or a gate tied to one machine. Check whether
  these are the test's only independent proof before deciding what to change.
- `external-dependency`: spawns python/uv, or (Swift) at least half its
  tests skip unless a GPU, a binary, model files, or an environment opt-in is
  present. Check the contract and whether this test belongs in the unit suite.
- `oversized-unit`: the test exercises a >1,500-line module. Inspect the
  module and test boundaries. A reason that says "tests a barrel over N files"
  points to several source modules behind one entry point.
- `transcribes-fixture`: the test pins current output. Check whether exact
  output is the contract or incidental fixture data. Mutation results show
  that these tests can still catch regressions.
- `review`: high score, ten-plus module mocks, a committed `.only`, or heavy
  line-sharing with another file.

`toHaveBeenCalledWith(...)`, `toHaveBeenCalledTimes(n)` and
`not.toHaveBeenCalled()` on an injected fake are discounted: they are often the
contract of an outbound boundary or a callback. Bare `toHaveBeenCalled()` is
not. Full-object `toEqual({...})` assertions are not a smell on their own.

Test/source co-editing is reported but deliberately not scored. It tracks
feature work landing with its tests; against mutation data it correlates
*negatively* with weakness. Do not treat it as evidence.

What the scorer cannot see, and the close-read must: a test that passes only
because a non-injected helper swallows an error; a hand-written dispatch table
in the source transcribed row by row; a scenario already covered in a sibling
file; a fake D1/SQL layer that checks bind arity and nothing else.

Known false positives: hand-rolled `vi.fn()` fakes. Strings that contain a
smell no longer count for JS/TS: the parse takes tests, assertions, reads and
mocks from real call expressions. Swift is still regex-based, so a Swift
string literal containing `XCTSkip` or `contentsOf:` will still fire.

## 4. Close-read the outliers

Run the built-in close-read first; it asks a model the same three questions
with the scorer's row and the sibling source in the prompt:

```sh
npx useless-tests read --top 20 --reads 3 --out useless-read.json --md useless-read.md
```

`--reads 3` gives three independent reads per file; the table shows the
median rating and majority verdict. A tie becomes `investigate`, and
disagreements are marked with ±. Use
`--runner codex --model gpt-5.5` for a second opinion from a different model
family, or `--command` for anything that reads a prompt on stdin. Then read
the disagreements and the top five yourself. Each read answers, per file:

1. Could a real regression in the unit make this test fail? Name the bug.
2. Could a harmless refactor make it fail? Name the refactor.
3. What is the test actually the symptom of (untestable module, missing DI,
   generated artifact with no regeneration path, coverage thresholds steering
   effort)?

Where a reader disagrees with the score, examine the stated contract and
evidence. Record a false positive when the test independently guards behavior
that the scorer missed.

Before recommending that a test be removed, inspect the complete test, its
production entry point and callers, overlapping tests, CI routing, and the
history that explains its existence. Record what failure it can catch, what
stronger proof remains, and whether removing it also removes a test-only
production seam. If that evidence is missing, report `investigate` rather
than treating a model verdict as a deletion decision.

Keep independent public API, protocol, config, storage, security, platform,
package, and release contracts. Source inspection can be a useful guard when
it checks a user-facing key, byte, or path and survives an internal rename.
A slow or static test can still protect a distinct contract. Treat a test that
is already red on the baseline as a possible product defect.

## 5. Read the suite as evidence about the codebase

The point is not the list. Look for practice-level patterns:

- Which modules are the largest tests for? They map onto the largest
  single-export modules, or onto barrels over modules that were split while
  their tests were not. Table them side by side with the real module size.
- Is dependency injection consistent? A test that must `vi.mock` a sibling is a
  module that imports what it should receive.
- Growth shape: `git log --format=%ad --date=short -- '*.test.*'` bucketed by
  month, and the share of test files written once and never touched.
- What does coverage config exclude? Excluded trees get no unit tests and are
  tested indirectly from elsewhere, or not at all.
- Architecture-by-grep tests: are any currently red on the default branch?
- Environment coupling papered over by CI (node version, native modules,
  home-directory paths).
- The good tests. Name the exemplary fail-closed ones so the audit has a bar to
  point at, not just a bin.

## 6. Write the audit

Deliver a document with, in this order:

1. The suite in one table (files, lines, tests, expects, weak share, mocks,
   write-once share, runtime and its concentration, gated files).
2. Environment caveats that made tests fail for non-test reasons.
3. What "useless" means here: the four failure modes, with counts from this
   repo.
4. The metric table (weights) and how to re-run it.
5. What the tests reveal about the repo's practices, with the giants table.
6. Recommendations, grouped by what you decided after reading: delete or fold;
   move out of the unit suite; rewrite as a contract; refactor the source;
   keep; investigate when the evidence is incomplete. These are your calls,
   so state them in your own words and attribute them to the close-reads, not
   to the scorer. Each row: file, one-line reason, the concrete replacement.
   For removal candidates, include the retained proof and relevant history.
7. Suggested guardrails: a lint rule for each tautology class found, a scorer
   run in CI as a job summary with a ratchet on p90, and a coverage config that
   stops steering tests toward the wrong trees.
8. The top-40 table from the scorer, verbatim, with a line saying findings in
   it are the scorer's observations and the tables above are the decisions.
   Commit the scorer's `--json` output next to the document so the published
   table, including any timing-adjusted scores, can be regenerated.

Put it where the repo keeps reference docs (for example `docs/reference/`),
and wire it into the docs nav if there is one.

## 7. Do not

- Delete tests in the same change as the audit. Ship the audit, let the owner
  pick from the list.
- Present a finding as an instruction. "The scorer flagged this as
  restates-implementation" is reporting; "delete this file" is a claim you own
  and must have read the file to make.
- Treat a red test as useless. A tautology test that is red on main is a
  finding about the source, not the test; report it separately.
- Tune weights to make a specific file win or lose. If a signal is wrong,
  fix the signal.
