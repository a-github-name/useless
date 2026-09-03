# useless

Rank a repo's test files by how useless they are.

A test is useless in proportion to how much it costs to keep versus how many
plausible regressions it can catch. Cost is lines, runtime, mock surface, and
how often the test has to be edited when the source changes. Value is whether a
real bug in the unit could make it fail. `useless` turns that into a 0–100
score per file, explains every point, and suggests what kind of human read each
high scorer deserves.

It works on any git checkout with Vitest, Jest, node:test, or Playwright
tests. No config, no dependencies, no AST: a handful of regexes over test text
plus `git log`.

```sh
npx useless-tests                      # markdown table of the 40 worst files
npx useless-tests --top 0 --json all.json
npx useless-tests --root ../other-repo --min-score 25
```

The package is `useless-tests` on npm; the installed binary is `useless`.

Fold runtime into the score by handing it a JSON report first:

```sh
npx vitest run --reporter=json --outputFile=.vitest.json
npx useless --timings .vitest.json
```

## What comes out

```
533 test files · 122179 lines · 2705 tests · 12607 expects (10% weak) · 1447 mocks (163 module mocks)
score median 5.4 · p90 15.2
delete-or-rewrite: 17 · move-to-integration: 1 · refactor-source: 9 · rewrite-as-contract: 10 · review: 5 · keep: 491

| score | verdict | file | lines | tests | expects | weak% | mocks | reasons |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 59.1 | delete-or-rewrite | `app/src/components/DeckGlobe.test.ts` | 99 | 1 | 4 | 100 | 8 | 100% of expects are "mock was called"; 100% weak assertions; 8.0 mocks per test; 99 lines per test |
| 47.8 | delete-or-rewrite | `app/src/components/Globe.test.ts` | 141 | 1 | 5 | 60 | 31 | 80% of expects are "mock was called"; 60% weak assertions; 31.0 mocks per test; 141 lines per test |
| 47 | delete-or-rewrite | `app/src/components/FlatMap.test.ts` | 173 | 2 | 8 | 63 | 25 | 75% of expects are "mock was called"; 63% weak assertions; 12.5 mocks per test; 87 lines per test |
```

The score is a triage order, not a verdict. Read the reasons column; it is the
whole point. `--json` dumps every raw signal and every normalised component so
you can re-weight without re-scanning.

## The four ways a test is useless

1. **Tautology.** The test restates the implementation: it greps source text or
   CSS, asserts that a mock was called with the literal the implementation
   passes, or depends on git history. It fails on refactor and passes on
   regression, the inverse of what a test is for.
2. **Transcription.** The test restates a fixture: pinned sha256 digests, pinned
   `toHaveLength(N)`, or literal-only assertions on a data module that already
   validates itself at import. Every legitimate regeneration is a red build
   whose only fix is pasting new numbers.
3. **Presence-only assertions.** `getByText(...)` already throws on a miss, so a
   trailing `.toBeTruthy()` adds nothing. These inflate apparent coverage
   without pinning behaviour.
4. **Tests as the symptom of an untestable unit.** A 2,000-line test with a
   200-line `beforeEach` and ten module mocks is not a bad test. It is the bill
   for a 6,000-line component that imports ten services directly. The fix is in
   the source.

## The metric

Each signal is normalised to [0, 1] and weighted. Weights sum to 100.

| Signal | Weight | What it measures |
|---|---:|---|
| Tautology | 35 | source-text asserts, repo-file greps, SQL text pins, git shell-outs, "mock was called" share of expects. A bare `toHaveBeenCalled()` counts in full; `toHaveBeenCalledTimes`, `not.toHaveBeenCalled()` and `toHaveBeenCalledWith(...)` count half, and less again when the file has no module mocks, because then the fake was injected and the call is the boundary under test |
| Weak assertions | 12 | `toBeTruthy`, `toBeDefined`, `toBeInTheDocument`, bare `toHaveBeenCalled()`, `toBeGreaterThan(0)`, `not.toBeNull()`, `assert.ok` share of expects |
| Mock burden | 10 | module mocks (`vi.mock`/`jest.mock`, heavy) and fn stubs per test (light) |
| Cost | 15 | lines per test, runtime when a JSON report is supplied, share of lines copied from another test file; saturated for an exact duplicate |
| Mirror | 8 | pinned digests, pinned sizes, snapshots, deleted-file asserts, literal share on data subjects, and only the *excess* of multi-line literal expectation over 40% of the file |
| Lockstep | 8 | share of source commits that also edited the test (needs ≥5 source commits) |
| Environment | 7 | spawns python/uv, real-clock waits without fake timers, unmocked reads of the home directory |
| Skipped/gated | 5 | `skip`, `todo`, `fixme`, `runIf`/`skipIf`, and `.only` left in |

### Verdict hints

| Verdict | Trigger | What to do |
|---|---|---|
| `delete-duplicate` | identical to another test file, or ≥90% of its distinct lines appear in one | Delete the copy, or make it a shared test |
| `delete-or-rewrite` | git shell-outs, tautology > 0.6, environment-gated suite, ≥5 asserts over repo source text | Delete, or replace with a lint rule / a behavioural test |
| `move-to-integration` | spawns python/uv | Keep it, but out of the unit suite |
| `refactor-source` | source > 1,500 lines and (mock burden > 0.5, weak > 0.5, or the test itself > 1,000 lines) | The test is the bill for the module. Split the module. |
| `rewrite-as-contract` | ≥50% of the file is literal expectation across ≥5 blocks; ≥3 file snapshots; ≥5 digest pins; literal-only asserts on a data module; lockstep on a source with ≥10 commits | State the invariant instead of transcribing the output |
| `review` | score ≥ 35, ≥10 module mocks, a committed `.only`, or ≥70% of its lines shared with another test file | Worth a human read; the reasons say why |
| `keep` | everything else | |

### Known false positives

- Hand-rolled fakes built from `vi.fn()` count as mocks. The weight on fn stubs
  is low for this reason, but a fixture-heavy test can still score in the 20s.
- Installer or scaffolding tests that shim `git` through a fake binary trip the
  git shell-out rule. Read them before deleting.
- A test that reads a JSON fixture and also mentions a `.ts` filename in a
  string reads as grepping the repo.
- The lockstep signal cannot tell "restates the implementation" from "the
  feature was built test-first in the same commits". It only fires once the
  source has enough history to make coincidence unlikely.
- Fixture strings that *contain* a smell read as the smell. The scorer cannot
  tell `expect(src).toContain('export')` from a string literal holding that
  text. Its own `src/signals.test.ts` scores high for exactly this reason.

### Calibration

The rules were tuned by running the scorer over 27 repos (1,548 test files,
about 300k lines: SvelteKit apps, Cloudflare Workers, CLIs, a Preact globe
renderer, node:test suites), then having five independent reviewers close-read
49 files across five of those repos without seeing the scores. Each reviewer
named a real bug that would fail the test, a harmless refactor that would fail
it, and gave a 0–100 uselessness rating and a verdict.

| Measure | Value |
|---|---:|
| Spearman rank correlation, scorer vs reviewer rating | 0.68 |
| Files where scorer and reviewer agree on keep vs not-keep | 40 of 49 |
| Files the scorer flags that a reviewer would keep | 0 |
| Exact verdict match | 34 of 49 |

The nine misses are all in the same direction: the scorer says keep, the
reviewer wants a refactor. They need reasoning a regex cannot do, such as
noticing that a route test only passes because a non-injected helper swallows
an error, or that a dispatch table in the source is being transcribed row by
row. Tautology alone correlates at 0.65 with the reviewers; it is the signal
that matters most, which is why it carries a third of the weight.

Things that were wrong in the first cut and are now handled:

- A 28-file node:test suite scored zero because only `expect(` was counted.
- `toHaveBeenCalledTimes(1)` and `not.toHaveBeenCalled()` on a callback prop
  were scored like a bare `toHaveBeenCalled()`; reviewers called them the
  contract of a timer component.
- Counting large literals instead of measuring them flagged every test that
  asserted a full result object. Reviewers rated those as the *strongest*
  tests, and the literal share turned out to be negatively correlated with
  uselessness. It now counts only for its excess over 40% of the file.
- A fixture filename ending in `.py` counted as spawning python.
- `expect(body).toContain('</loc>')` on rendered XML counted as asserting on
  source text.
- A fake object with a `readFile: vi.fn()` key counted as reading the repo,
  while a helper that reads through a path variable did not.
- A one-function utility module counted as a "data module".
- `/Users/alice/...` in a fixture counted as depending on the machine.
- Copy-pasted test files across packages went unnoticed; seven exact or
  near-exact copies turned up in three repos.

## Library

```ts
import { rank, analyzeTest, score, WEIGHTS } from 'useless-tests';

const rows = rank({ root: '/path/to/repo' });      // Scored[], most useless first
const signals = analyzeTest({ file, text, source, sourceText, churn, timing });
const scored = score(signals);                      // { score, components, reasons, verdict }
```

`analyzeTest` and `score` are pure; only `rank`/`collectRepo` touch git and the
filesystem.

## Claude Code skill

`skills/useless-tests/SKILL.md` teaches an agent the full audit loop: run the
scorer, close-read the outliers, write the audit, and turn the findings into
guardrails. Install it by symlinking the folder:

```sh
ln -s "$(pwd)/skills/useless-tests" ~/.claude/skills/useless-tests
```

## Development

```sh
pnpm install
pnpm check        # typecheck, lint, test, build
pnpm dev --root ../some-repo
```

The scorer's own tests are contract tests over synthetic inputs and a throwaway
git repo. Running `useless` on this repo is a live demo of its blind spot: the
signals test is flagged `delete-or-rewrite` because its inputs are the patterns
it detects, and the repo test shells out to real `git` because git plumbing is
the unit under test. The score test, which feeds plain numbers in, scores under
one.

## Origin

Calibrated on a 533-file, 122k-line Vitest and Playwright suite, where three
independent close-reads of the top-scoring files agreed with the ranking. The
weights are opinions. Change them in `src/score.ts`.
