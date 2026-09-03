# useless

Rank a repo's test files by how useless they are.

A test is useless in proportion to how much it costs to keep versus how many
plausible regressions it can catch. Cost is lines, runtime, mock surface, and
how often the test has to be edited when the source changes. Value is whether a
real bug in the unit could make it fail. `useless` turns that into a 0–100
score per file, explains every point, and suggests what kind of human read each
high scorer deserves.

It works on any git checkout with Vitest, Jest, or Playwright tests. No config,
no dependencies, no AST: a handful of regexes over test text plus `git log`.

```sh
npx useless                      # markdown table of the 40 worst files
npx useless --top 0 --json all.json
npx useless --root ../other-repo --min-score 25
```

Fold runtime into the score by handing it a JSON report first:

```sh
npx vitest run --reporter=json --outputFile=.vitest.json
npx useless --timings .vitest.json
```

## What comes out

```
533 test files · 122179 lines · 2705 tests · 12607 expects (10% weak) · 1447 mocks (163 module mocks)
score median 9.9 · p90 22.6
delete-or-rewrite: 33 · move-to-integration: 1 · refactor-source: 7 · rewrite-as-contract: 92 · review: 3 · keep: 397

| score | verdict | file | lines | tests | expects | weak% | mocks | reasons |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 53 | delete-or-rewrite | `app/src/components/DeckGlobe.test.ts` | 99 | 1 | 4 | 100 | 8 | 100% of expects are "mock was called"; 100% weak assertions; 8.0 mocks per test; 99 lines per test |
| 40.7 | refactor-source | `app/src/components/MissionPage.test.tsx` | 2351 | 20 | 185 | 51 | 38 | 51% weak assertions; 11 module mocks; 118 lines per test; pins 1 sha256 digest(s) |
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
| Tautology | 25 | source-text asserts, repo-file greps, git shell-outs, "mock was called" share of expects |
| Weak assertions | 15 | `toBeTruthy`, `toBeDefined`, `toHaveBeenCalled()`, `toBeInTheDocument` share of expects |
| Mock burden | 15 | module mocks (`vi.mock`/`jest.mock`, heavy) and fn stubs per test (light) |
| Cost | 12 | lines per test, plus runtime when a JSON report is supplied |
| Mirror | 10 | multi-line literal expectations, pinned digests, pinned sizes, deleted-file asserts, literal share on data subjects |
| Lockstep | 10 | share of source commits that also edited the test (needs ≥5 source commits) |
| Environment | 8 | shells out to python/uv |
| Skipped/gated | 5 | `skip`, `todo`, `fixme`, `runIf`/`skipIf` per test |

### Verdict hints

| Verdict | Trigger | What to do |
|---|---|---|
| `delete-or-rewrite` | git shell-outs, tautology > 0.6, ≥3 digest pins, environment-gated suite, ≥5 asserts over repo source text | Delete, or replace with a lint rule / a behavioural test |
| `move-to-integration` | shells out to python/uv | Keep it, but out of the unit suite |
| `refactor-source` | source > 1,500 lines and (mock burden > 0.5 or weak > 0.5) | The test is the bill for the module. Split the module. |
| `rewrite-as-contract` | many large literals with a high mirror score; literal-only asserts on a data module; lockstep on a source with ≥10 commits | State the invariant instead of transcribing the output |
| `review` | score ≥ 35, or ≥10 module mocks | Worth a human read; the reasons say why |
| `keep` | everything else | |

### Known false positives

- Hand-rolled fakes built from `vi.fn()` count as mocks. The weight on fn stubs
  is low for this reason, but a fixture-heavy test can still score in the 20s.
- Installer or scaffolding tests that shim `git` through a fake binary trip the
  git shell-out rule. Read them before deleting.
- Small pure modules (under three functions) are treated as data subjects, so a
  one-liner utility with a literal assertion reads as "transcription".
- The lockstep signal cannot tell "restates the implementation" from "the
  feature was built test-first in the same commits". It only fires once the
  source has enough history to make coincidence unlikely.

## Library

```ts
import { rank, analyzeTest, score, WEIGHTS } from 'useless';

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
git repo. Running `useless` on this repo should say `keep` for all of them.

## Origin

Calibrated on a 533-file, 122k-line Vitest and Playwright suite, where three
independent close-reads of the top-scoring files agreed with the ranking. The
weights are opinions. Change them in `src/score.ts`.
