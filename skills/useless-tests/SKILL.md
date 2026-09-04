---
name: useless-tests
description: >
  Audit a repo's test suite for useless tests: tautologies that grep source or
  assert mocks were called, transcribed fixtures, presence-only assertions, and
  giant tests that are really a symptom of an untestable module. Use when asked
  which tests are useless, low-value, redundant, bloated, or should be deleted;
  when asked what the tests reveal about the codebase's practices; or when asked
  for a metric of test quality or "uselessness". Runs the `useless` scorer, then
  close-reads the outliers and writes an audit with per-file verdicts.
---

# Useless-tests audit

The scorer ranks; you judge. Never delete a test on the score alone.

## 1. Run the scorer

The repo must be a git checkout. Get timings first if the suite runs in under
ten minutes; otherwise skip `--timings`.

```sh
npx vitest run --reporter=json --outputFile=.vitest.json   # or jest --json --outputFile
npx useless-tests --timings .vitest.json --top 40 --json useless.json
```

If it is not installed, `pnpm dlx useless-tests` works, or clone
`~/projects/useless` and run `pnpm dev --root <repo>`.

Read the three summary lines and the table. The second line reports duplicated
setup ("N lines of setup duplicated across M files") when a block is pasted
into three or more files; that is a suite-level finding, not a per-file one,
and belongs in the practices section. Keep `useless.json`; it holds every raw
signal and normalised component for every file.

## 2. Understand what the score means

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
- `restates-implementation`: as written it cannot fail on a real bug. It
  greps repo source (and those greps are most of the file), asserts a bare
  "mock was called", or is gated on a developer's machine.
- `external-dependency`: spawns python/uv. Usually keep it, out of the unit
  suite.
- `oversized-unit`: the test is the bill for a >1,500-line module. Fix the
  module, not the test. When the reason says "tests a barrel over N files",
  the module has already been split and the test has not; split the test along
  the same seams.
- `transcribes-fixture`: restates current output rather than an invariant.
  Treat this as maintenance cost, not weak coverage: in mutation testing these
  files killed bugs at about the same rate as clean ones.
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

Known false positives: hand-rolled `vi.fn()` fakes, and fixture strings that
contain the smell being detected.

## 3. Close-read the outliers

Fan out three independent reads (Explore agents, "very thorough") over the top
15–20 files. Each read answers, per file:

1. Could a real regression in the unit make this test fail? Name the bug.
2. Could a harmless refactor make it fail? Name the refactor.
3. What is the test actually the symptom of (untestable module, missing DI,
   generated artifact with no regeneration path, coverage thresholds steering
   effort)?

Where the readers disagree with the score, the score is wrong for that file;
note it as a false positive and move on.

## 4. Read the suite as evidence about the codebase

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

## 5. Write the audit

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
   keep. These are your calls, so state them in your own words and attribute
   them to the close-reads, not to the scorer. Each row: file, one-line
   reason, the concrete replacement.
7. Suggested guardrails: a lint rule for each tautology class found, a scorer
   run in CI as a job summary with a ratchet on p90, and a coverage config that
   stops steering tests toward the wrong trees.
8. The top-40 table from the scorer, verbatim, with a line saying findings in
   it are the scorer's observations and the tables above are the decisions.
   Commit the scorer's `--json` output next to the document so the published
   table, including any timing-adjusted scores, can be regenerated.

Put it where the repo keeps reference docs (for example `docs/reference/`),
and wire it into the docs nav if there is one.

## 6. Do not

- Delete tests in the same change as the audit. Ship the audit, let the owner
  pick from the list.
- Present a finding as an instruction. "The scorer flagged this as
  restates-implementation" is reporting; "delete this file" is a claim you own
  and must have read the file to make.
- Treat a red test as useless. A tautology test that is red on main is a
  finding about the source, not the test; report it separately.
- Tune weights to make a specific file win or lose. If a signal is wrong,
  fix the signal.
