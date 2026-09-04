# useless

Rank a repo's test files by how useless they are.

A test is useless in proportion to how much it costs to keep versus how many
plausible regressions it can catch. Cost is lines, runtime, mock surface, and
how often the test has to be edited when the source changes. Value is whether a
real bug in the unit could make it fail. `useless` turns that into a 0–100
score per file, explains every point, and suggests what kind of human read each
high scorer deserves.

It works on any git checkout with Vitest, Jest, node:test, mocha with chai or
assert, ava, tap, or Playwright tests, and finds them under `*.test.*`,
`*.spec.*`, `__tests__/`, `test/` and `tests/`. No config, no dependencies, no
AST: a handful of regexes over test text plus `git log`.

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
534 test files · 122313 lines · 2709 tests · 12632 expects (10% weak) · 1447 mocks (163 module mocks)
score median 6 · p90 14.8 · 105 lines of setup duplicated across 2 files
restates-implementation: 10 · external-dependency: 1 · oversized-unit: 9 · transcribes-fixture: 9 · review: 6 · clean: 499

| score | finding | file | lines | tests | expects | weak% | mocks | reasons |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 65.6 | restates-implementation | `app/src/components/DeckGlobe.test.ts` | 99 | 1 | 4 | 100 | 8 | 100% of expects are "mock was called"; 100% weak assertions; 8.0 mocks per test; 99 lines per test |
| 51.5 | restates-implementation | `app/src/components/Globe.test.ts` | 141 | 1 | 5 | 60 | 31 | 80% of expects are "mock was called"; 60% weak assertions; 31.0 mocks per test; 141 lines per test |
| 49 | review | `app/src/lib/analyst-current-context-map-layer.test.ts` | 134 | 1 | 10 | 50 | 19 | 70% of expects are "mock was called"; 5 module mocks; 134 lines per test |
```

The score is a triage order and the finding is an observation; neither is a
decision. Read the reasons column, then read the file. `useless-tests` never
tells you to delete anything. `--json` dumps every raw signal and every normalised component so
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
| Tautology | 40 | source-text asserts, repo greps, SQL pins, git shell-outs, "mock was called" share of expects. A bare `toHaveBeenCalled()` counts in full; `toHaveBeenCalledTimes`, `not.toHaveBeenCalled()` and `toHaveBeenCalledWith(...)` count half, and less again when the file has no module mocks, because then the fake was injected and the call is the boundary under test |
| Weak assertions | 12 | `toBeTruthy`, `toBeDefined`, `toBeInTheDocument`, bare `toHaveBeenCalled()`, `toBeGreaterThan(0)`, `not.toBeNull()`, `assert.ok` share of expects |
| Mock burden | 10 | module mocks (`vi.mock`/`jest.mock`, heavy) and fn stubs per test (light) |
| Cost | 18 | lines per test, runtime when a JSON report is supplied, share of lines copied from another test file, lines of setup that a block repeated in three or more files accounts for; saturated for an exact duplicate |
| Mirror | 8 | pinned digests, pinned sizes, snapshots, deleted-file asserts, literal share on data subjects, and only the *excess* of multi-line literal expectation over 40% of the file |
| Environment | 7 | spawns python/uv, real-clock waits without fake timers, unmocked reads of the home directory |
| Skipped/gated | 5 | `skip`, `todo`, `fixme`, `runIf`/`skipIf` on this machine, and `.only` left in |

Test/source co-editing churn is collected and reported in `--json`, but not
scored. See the calibration notes below for why.


### Findings

A finding names what the signals observed, not what to do about it. The tool
cannot know whether a test should be deleted; that is a call you make after
reading the file. The last column is a prompt for that reading.

| Finding | Trigger | Usually means |
|---|---|---|
| `duplicate` | identical to another test file, or ≥90% of its distinct lines appear in one | read both together; fold or share |
| `restates-implementation` | tautology > 0.6, a suite gated on this machine, or repo-source greps that are ≥5 assertions **and** at least half the file's assertions | cannot fail on a real bug as written; replace with a behavioural test or a lint rule |
| `external-dependency` | spawns python/uv | keep, but out of the unit suite |
| `oversized-unit` | source > 1,500 lines and (mock burden > 0.5, weak > 0.5, or the test itself > 1,000 lines). A sibling that is a re-export barrel is followed to the modules behind it | the cost is the module, not the test; split along its seams |
| `transcribes-fixture` | ≥50% of the file is literal expectation across ≥5 blocks; ≥3 file snapshots covering half the tests; ≥5 digest pins; literal-only asserts on a data module | a maintenance cost, not a detection failure: state the invariant instead of the current output |
| `review` | score ≥ 35, ≥10 module mocks, a committed `.only`, or ≥70% of its lines shared with another test file | worth a human read; the reasons say why |
| `clean` | everything else | no signal worth acting on |


### Known false positives

- Hand-rolled fakes built from `vi.fn()` count as mocks. The weight on fn stubs
  is low for this reason, but a fixture-heavy test can still score in the 20s.
- A test that reads a JSON fixture and also mentions a `.ts` filename in a
  string reads as grepping the repo.
- Fixture strings that *contain* a smell read as the smell. The scorer cannot
  tell `expect(src).toContain('export')` from a string literal holding that
  text. Its own `src/signals.test.ts` scores high for exactly this reason.
- `transcribes-fixture` files kill mutants at roughly the rate of clean ones
  (68% against 70% in the run below). Read that finding as maintenance cost,
  not as weak coverage.


### Calibration

The rules were tuned by running the scorer over 27 repos (1,548 test files,
about 300k lines: SvelteKit apps, Cloudflare Workers, CLIs, a Preact globe
renderer, node:test suites), then having five independent reviewers close-read
49 files across five of those repos without seeing the scores. Each reviewer
named a real bug that would fail the test, a harmless refactor that would fail
it, and gave a 0–100 uselessness rating and a verdict.

| Measure | Value |
|---|---:|
| Spearman rank correlation, scorer vs reviewer rating | 0.65 |
| Files where scorer and reviewer agree on flagged vs clean | 41 of 49 |
| Files the scorer flags that a reviewer would keep | 0 |
| Exact finding match | 35 of 49 |

The nine misses are all in the same direction: the scorer says keep, the
reviewer wants a refactor. They need reasoning a regex cannot do, such as
noticing that a route test only passes because a non-injected helper swallows
an error, or that a dispatch table in the source is being transcribed row by
row. Tautology alone correlates at 0.65 with the reviewers; it is the signal
that matters most, which is why it carries a third of the weight.

#### Public corpus

To check the rules against code nobody on this team wrote, the scorer was then
run over 14 public repos: zod, hono, trpc, axios, socket.io, react-hook-form,
date-fns, excalidraw, express, fastify, SvelteKit, immer, got, and mermaid.
That is 2,114 test files across Vitest, Jest, mocha, node:test, ava, tap and
Playwright, in five assertion dialects.

| Measure | Value |
|---|---:|
| Files | 2,114 |
| Median score / p90 | 4 / 12.5 |
| Flagged (anything but clean) | 50 (2.4%) |
| `restates-implementation` | 4, all docs-conformance tests that grep repo markdown |
| `duplicate` | 14: fastify's webpack/esbuild bundler tests, axios esm/cjs smoke pairs, zod v3/v4 pairs |

Nothing in a well-known suite scores as tautology except the tests that really
do assert on repo text. The corpus caught six blind spots the first 27 repos
could not, because those repos never did these things:

- Generator, bundler and prerender tests that build output and read it back
  (SvelteKit's `builder.spec.js`, `svelte-package`, tRPC's OpenAPI CLI).
- Transform tests that read an `Input.svelte` fixture beside the test.
- A `FIXTURE_PATH` constant, or an `import '../helpers/util.ts'` specifier,
  satisfying the "names a source file" check.
- Platform-conditional `describe.skipIf(process.platform ...)` suites, which
  are normal in libraries and are not the same as a suite gated on a
  developer's home directory.
- Re-export barrels read as data modules.
- `Deno.test` and `test.serial` not counted as tests.

The summary line also reports duplicated setup: lines that belong to a block
of six or more normalised lines repeated in three or more test files. On a
SvelteKit monorepo that was 1,337 lines across 25 files, with one reset harness
pasted into 44 of them; no single file looked expensive, which is why the
per-file similarity signal alone did not surface it.

Parallel copies by design, such as the same smoke test kept in both esm and cjs
form, still show up as duplicates. The reason names the partner file, so the
reader sees the esm/cjs pairing immediately; the scorer does not try to guess
intent.

#### Mutation testing

Reviewer opinion is still opinion. The ground truth for "can this test catch a
bug" is mutation testing: mutate the source, see which tests fail. Stryker was
run with per-test coverage and bail disabled, so every covering test runs
against every mutant and kills are attributed to every test that catches them.
Each test file is then judged on the mutants in its own sibling source module:
covered, killed, and the survival rate.

**mere-earth**, 37 test files: every flagged file whose source is under 1,500
lines, plus the 18 lowest-scoring keep files as a contrast group. 7,351
mutants.

| Measure | Value |
|---|---:|
| Spearman, uselessness score vs mutant survival in own source | 0.80 |
| Same, inside the 19 clean files only | 0.64 |
| Same, inside the 11 flagged files only | 0.77 |
| Same, with the cost component removed from the score | 0.71 |
| Mean kill rate, `restates-implementation` (4 files) | 15% |
| Mean kill rate, `review` (4 files) | 45% |
| Mean kill rate, `transcribes-fixture` (2 files) | 68% |
| Mean kill rate, `clean` (19 files) | 70% |

The top-scoring file, `DeckGlobe.test.ts`, kills 4 of the 65 mutants in
`DeckGlobe.ts`. The reviewers had rated it 85 and the scorer 59; both were
right.

**hono**, 61 test files across `src/utils`, `src/helper` and `src/middleware`,
6,650 mutants. Every file scores `keep` in a 1 to 24 band, and kill rates sit
between 60% and 90%.

| Measure | Value |
|---|---:|
| Spearman, uselessness score vs mutant survival in own source | 0.06 |
| Mean kill rate, top 20% by score | 65% |
| Mean kill rate, bottom 20% by score | 67% |

So the metric is a detector for the tail, not a fine-grained quality ranking.
When a suite has tautological tests, the score finds them and orders them
correctly against the healthy ones, even inside the keep group. When a suite
has none, the score has nothing to say and should not be read as one. That is
the intended contract: the verdict column is the product, the number is the
triage order within it.

Two smaller findings from the same data. The `mirror` signal correlates
negatively with survival in both repos (-0.65 and -0.16): tests full of literal
expectations kill mutants, so the remaining literal-share term is kept small.
And the `cost` signal correlates at 0.79 on mere-earth, which means the
expensive tests there really are the ones that catch nothing, but that is a
property of that codebase rather than of cost itself.

To reproduce on another repo: run Stryker with
`coverageAnalysis: "perTest"`, `disableBail: true`, `ignoreStatic: true` and
the JSON reporter, then
`node docs/mutation-join.mjs reports/mutation/mutation.json useless.json <repo root>`
where `useless.json` is the scorer's `--json` output.

#### What an independent code review changed

A reviewer read the first version as shipped and pushed back on five things.
Three were already fixed by the corpus work; two were real and are fixed here,
along with a naming change:

- **Churn was treated as evidence of transcription.** It is not. Against the
  mutation data, the lockstep component correlates **-0.30** with mutant
  survival: tests edited alongside their source kill *more* mutants, not
  fewer. Against the reviewer set it correlated 0.11, which is nothing. The
  signal is removed; churn is still reported in `--json` as data.
- **Any git shell-out forced the worst finding.** Installer and scaffolding
  tests legitimately drive a `git` shim, which is a false positive the docs
  admitted but the rules did not handle. Git usage now feeds tautology like
  any other signal and decides nothing on its own; the regex also no longer
  fires on a branch name in a string. Five mere-earth files moved to `clean`.
- **Repo-source greps were judged on an absolute count.** Five greps in a
  forty-assertion behavioural test is not a source grep. The trigger now needs
  those assertions to be at least half the file. The architecture tests it was
  meant to catch still trigger it, at 62 of 65 assertions and 42 of 43.
- **The labels named actions the tool cannot justify.** `delete-or-rewrite`
  told a reader to delete a file on regex evidence. Findings now name the
  observation, and the recommended action is a separate, clearly human column.
- Already fixed before the review landed: python detection needing a real
  spawn, `toHaveBeenCalledWith` no longer treated as a bare call, and the
  discovery gap that missed `docs-worker/index.test.mjs`.

Removing lockstep and softening the two hard rules left accuracy unchanged:
reviewer correlation 0.67 → 0.65, mutation correlation 0.82 → 0.80, and the
same 41 of 49 flagged-vs-clean agreement.

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
- A test next to a 3-line `export * from` barrel was measured against the
  barrel, so the oversized-unit rule never fired on a 2,266-line test of a
  4,123-line module. Barrels are now followed.
- A reset harness pasted into 44 files was invisible because each copy was a
  third of its file, below the similarity threshold. Repeated blocks are now
  counted across the whole suite.

## Library

```ts
import { rank, analyzeTest, score, WEIGHTS, FINDING_GUIDANCE } from 'useless-tests';

const rows = rank({ root: '/path/to/repo' });      // Scored[], most useless first
const signals = analyzeTest({ file, text, source, sourceText, churn, timing });
const scored = score(signals);                      // { score, components, reasons, finding }
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
signals test is flagged `restates-implementation` because its inputs are the patterns
it detects, and the repo test shells out to real `git` because git plumbing is
the unit under test. The score test, which feeds plain numbers in, scores under
one.

## Origin

Calibrated on a 533-file, 122k-line Vitest and Playwright suite, where three
independent close-reads of the top-scoring files agreed with the ranking. The
weights are opinions. Change them in `src/score.ts`.
