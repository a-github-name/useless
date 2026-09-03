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

Read the three summary lines and the table. Keep `useless.json`; it holds every
raw signal and normalised component for every file.

## 2. Understand what the score means

Score is 0–100, weighted sum of eight signals (tautology 25, weak 15, mock
burden 15, cost 12, mirror 10, lockstep 10, environment 8, skipped 5). Median is
usually under 12, p90 in the low 20s. Anything over 25 deserves a read, and the
verdict column says which kind:

- `delete-or-rewrite`: the test cannot fail on a real bug (greps source, asserts
  a mock was called, depends on git history, gated on a developer's machine).
- `move-to-integration`: shells out to python/uv; keep it, not in the unit suite.
- `refactor-source`: the test is the bill for a >1,500-line module. Fix the
  module, not the test.
- `rewrite-as-contract`: transcribes a fixture (large literals, digest pins,
  size pins, lockstep edits). State the invariant instead.
- `review`: high score or ten-plus module mocks; reasons say why.

Known false positives: hand-rolled `vi.fn()` fakes, installer tests that shim
`git`, tiny pure modules read as data subjects, and test-first features that look
like lockstep.

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
  single-export modules. Table them side by side.
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
6. Verdicts, grouped: delete or fold; move out of unit suite; rewrite as
   contract or table; refactor source; keep. Each row: file, one-line reason,
   the concrete replacement.
7. Suggested guardrails: a lint rule for each tautology class found, a scorer
   run in CI as a job summary with a ratchet on p90, and a coverage config that
   stops steering tests toward the wrong trees.
8. The top-40 table from the scorer, verbatim.

Put it where the repo keeps reference docs (for example `docs/reference/`),
and wire it into the docs nav if there is one.

## 6. Do not

- Delete tests in the same change as the audit. Ship the audit, let the owner
  pick from the delete list.
- Treat a red test as useless. A tautology test that is red on main is a
  finding about the source, not the test; report it separately.
- Tune weights to make a specific file win or lose. If a signal is wrong,
  fix the signal.
