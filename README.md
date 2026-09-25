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
`*.spec.*`, `__tests__/`, `test/` and `tests/`. It also reads Swift: XCTest
and Swift Testing files under `*Tests/` or named `*Tests.swift`, with the
source found by name in `Sources/`. No config and one dependency: JS and TS
files are parsed with tree-sitter so that test blocks, assertions, file reads
and mocks come from real call expressions; everything else is a handful of
regexes over test text plus `git log`.

```sh
npx useless-tests                      # markdown table of the 40 worst files
npx useless-tests --per-test           # the 40 worst individual tests
npx useless-tests --top 0 --json all.json
npx useless-tests --root ../other-repo --min-score 25
npx useless-tests --mutation reports/mutation/mutation.json   # join Stryker mutation evidence
npx useless-tests read --top 20 --reads 3                    # close-read with a model
npx useless-tests mutate --root ../swift-package --max 300    # Swift mutation evidence
```

The package is `useless-tests` on npm; the installed binary is `useless`.

Fold runtime into the score by handing it a JSON report first:

```sh
npx vitest run --reporter=json --outputFile=.vitest.json
npx useless-tests --timings .vitest.json

node --test --test-reporter=junit --test-reporter-destination=.node-junit.xml tests/*.test.js
npx useless-tests --timings .node-junit.xml

swift test --parallel --xunit-output .xunit.xml     # Swift packages
npx useless-tests --timings .xunit.xml
```

For Node JUnit, the cost signal uses the sum of testcase durations for each
file. This is aggregate case time, which can differ from file wall time when
tests run concurrently. Without a report, duration remains unknown and adds
no runtime cost to the score.

To inspect standalone JavaScript or TypeScript verifier scripts, pass narrow
Git path patterns and `--standalone`:

```sh
npx useless-tests --standalone --pattern '*verify-*.ts' --pattern '*verify-*.mjs'
```

These scripts appear as file rows with `kind` set to `script` and zero test
call sites. Local `assert(...)` calls contribute to the assertion signals. A
script with no local assertion calls receives `review`: checks in imported
functions, thrown errors, and exit status need a manual read. Python scripts
are not parsed or scored; the CLI names unsupported files selected by your
patterns on stderr. `--per-test` lists registered test blocks, so it does not
show standalone scripts.

## What comes out

```
534 test files · 122423 lines · 2737 test call sites · 12643 expects (10% weak) · 1414 mocks (158 module mocks)
score median 6 · p90 14.6 · 105 lines of setup duplicated across 2 files
restates-implementation: 9 · external-dependency: 1 · oversized-unit: 9 · transcribes-fixture: 9 · review: 6 · clean: 500 · tests flagged on their own: 205 of 2736

| score | finding | file | lines | tests | expects | weak% | mocks | reasons |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 64.8 | restates-implementation | `app/src/components/DeckGlobe.test.ts` | 99 | 1 | 4 | 100 | 6 | 100% of expects are "mock was called"; 100% weak assertions; 6.0 mocks per test; 99 lines per test |
| 51.5 | restates-implementation | `app/src/components/Globe.test.ts` | 141 | 1 | 5 | 60 | 31 | 80% of expects are "mock was called"; 60% weak assertions; 31.0 mocks per test; 141 lines per test |
```

The score is a triage order and the finding is an observation; neither is a
decision. Read the reasons column, then read the file. `useless-tests` never
tells you to delete anything. `--json` dumps every raw signal and every normalised component so
you can re-weight without re-scanning.

The last number on the third line comes from scoring every `it`/`test`
block on its own. `--per-test` ranks those blocks:

```
| score | finding | test | lines | expects | weak% | reasons |
|---:|---|---|---:|---:|---:|---|
| 53.7 | restates-implementation | `src/adapter/cloudflare-workers/websocket.test.ts:45` upgradeWebSocket middleware Should call next() when header does not have upgrade | 14 | 1 | 100 | 100% of expects are "mock was called"; 100% weak assertions |
| 52.9 | restates-implementation | `src/helper/ssg/plugins.test.tsx:30` Built-in SSG plugins default plugin uses defaultPlugin when plugins option is omitted | 6 | 1 | 100 | 100% of expects are "mock was called"; 100% weak assertions |
```

A file is a bad unit of judgement: a hundred-test file with five tautologies
in it scores clean. Each block is analysed as its own text with the file as
context (module mocks, tmpdir setup, fake timers, suite gates and the sibling
source belong to the file), scored with the same rules, and reported under
`units` in the JSON. A file whose tests restate the implementation says so
in its reasons, and three or more of them move a clean file to `review`.

The `tests` field and `--per-test` rows count source registration sites. A
runner can execute more cases when one site sits inside a loop or uses
`test.each(...)`. For literal array tables and `for...of` loops, the JSON
`staticCases` field records the number of cases represented by a site, and
the summary reports the extra statically expanded cases. A `null` value means
runtime data or control flow determines the count. The scanner does not run
test modules or turn repeated registrations into separate scored rows. Compare
with a runner report to establish the executed count.

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
| Environment | 7 | spawns python/uv, real-clock waits without fake timers, unmocked reads of the home directory; in Swift, the share of tests that skip unless a GPU, a binary, model files, or an environment opt-in is present |
| Skipped/gated | 5 | `skip`, `todo`, `fixme`, `runIf`/`skipIf` on this machine, and `.only` left in; in Swift, `XCTSkip` and `.disabled` |

Test/source co-editing churn is collected and reported in `--json`, but not
scored. See the calibration notes below for why.

### Parsing instead of matching

For JS and TS the string-sensitive signals come from a tree-sitter parse
rather than regexes: test blocks and their suite path, every
`expect(...)` chain with its matcher and whether its argument is a literal,
file reads and the variables their results flow into, `vi.*`/`jest.*`
calls, suite gates, and process spawns. A read counts as a repo grep only
when its path names a source-like file outside a fixture directory, and an
assertion counts only when its subject traces back to such a read through
variable initialisers or a local helper that reads files. The documented
false positive, a fixture string that contains the smell, is gone: the
scorer's own `signals.test.ts`, whose inputs are the patterns it detects,
went from 18 and `restates-implementation` to 2 and clean. Across four
public repos (hono, SvelteKit, axios, express) the parse moved 66 of 486
file scores, most by under a point, and changed two findings, both in axios
and both promotions to `review` because three or more of the file's own
tests restate the implementation: a docs tokenizer test whose input is a
real docs page, and a browser interceptor test built on "mock was called".

Two grammars ship with the package (TypeScript and TSX, the latter parsing
JavaScript too). Their license is included in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). `--no-ast` keeps the
regex-only analysis. Swift stays on
regexes: its grammar crashes the Node wasm compiler during tier-up. Swift
test blocks are still split per test, by a brace-matching walk over
`func test...` methods and `@Test` functions that tracks the enclosing
type, extension or `@Suite`, so `--per-test`, `units`, and the mutation
join work the same way for Swift.


### Mutation evidence: `--mutation`

Everything above is a heuristic. Mutation testing shows which simulated bugs
a test detects within the mutated sources and operators. Stryker's report
(with `coverageAnalysis: "perTest"` and `disableBail: true`) records which
tests cover and kill each mutant. `--mutation mutation.json` joins that in:

```
mutation: 1086 tests matched · 690 kill nothing another test does not

| score | finding | test | lines | expects | weak% | kill% | unique | redundant with | reasons |
| 52.9 | restates-implementation | `src/helper/ssg/plugins.test.tsx:30` ... | 6 | 1 | 100 | 2 | 1 |  | 100% of expects are "mock was called" |
| 53 | restates-implementation | `src/middleware/cache/index.test.ts:524` ... | 11 | 1 | 100 | 38 | 0 | src/middleware/cache/index.test.ts: ... containing a fragment (100%) | ... |
```

Stryker does not do Swift, and Muter does not record which test killed a
mutant, so `useless mutate` runs that loop itself for a Swift package: one
coverage pass per test suite (`swift test --enable-code-coverage --filter`),
then for each mutant on a covered line a rebuild, a run of only the suites
that cover it with an xunit report, and a kill credited to every failing
test. It emits the same Stryker-shaped report, so `--mutation` and the
benchmark read it unchanged. Operators: equality, relational, logical and
arithmetic swaps, boolean and numeric literals, string literals to empty,
negation removal, and `if`/`guard`/`while` conditions to `false`. Mutants
are sampled uniformly under `--max`; `--resume` picks up an interrupted
run. On swift-argument-parser a mutant costs about three seconds after the
one-off coverage pass.

Per file: mutants covered and killed, the same restricted to the sibling
source, and unique kills. Per test: kill rate, unique kills, and, for a test
with no unique kills, the single other test that makes at least 90% of the
same kills. "Kills nothing another test does not" is a precise statement
about the mutated area and nothing more: such a test may still document a
behaviour, cover code outside the mutated globs, or be the readable one of a
pair. It is where the redundancy read starts, not where it ends. Tests are
matched to the report by full title, then by line.

### Findings

A finding names what the signals observed, not what to do about it. The tool
cannot know whether a test should be deleted; that is a call you make after
reading the file. The last column is a prompt for that reading.

| Finding | Trigger | Usually means |
|---|---|---|
| `duplicate` | identical to another test file, or ≥90% of its distinct lines appear in one | read both files; check whether each protects a distinct contract |
| `restates-implementation` | tautology > 0.6, a suite gated on this machine, or repo-source greps that are ≥5 assertions **and** at least half the file's assertions | check whether these assertions protect an independent contract or only the current implementation |
| `external-dependency` | spawns python/uv, or (Swift) at least half its tests skip unless a GPU, a binary, model files, or an environment opt-in is present | check the contract and whether the unit suite is the right place for it |
| `oversized-unit` | source > 1,500 lines and (mock burden > 0.5, weak > 0.5, or the test itself > 1,000 lines). A sibling that is a re-export barrel is followed to the modules behind it | inspect the module and test boundaries before splitting either |
| `transcribes-fixture` | ≥50% of the file is literal expectation across ≥5 blocks; ≥3 file snapshots covering half the tests; ≥5 digest pins; literal-only asserts on a data module | check whether exact output is the contract or incidental fixture data |
| `review` | score ≥ 35, ≥10 module mocks, a committed `.only`, or ≥70% of its lines shared with another test file | worth a human read; the reasons say why |
| `clean` | everything else | no signal worth acting on |


### Known false positives

- Hand-rolled fakes built from `vi.fn()` count as mocks. The weight on fn stubs
  is low for this reason, but a fixture-heavy test can still score in the 20s.
- A test whose input is a real repo document, such as a docs tokenizer test
  fed a page from `docs/`, reads as grepping the repo. The parse can tell
  where a value came from, not what it is for.
- Test titles built at runtime (`describe.each` tables, template strings)
  cannot be matched to a mutation report by name; those tests fall back to a
  line match or get no mutation data.
- With `--no-ast`, or in Swift, strings that *contain* a smell read as the
  smell: the regexes cannot tell `expect(src).toContain('export')` from a
  string literal holding that text. The parse removed this for JS and TS.
- `transcribes-fixture` files kill mutants at roughly the rate of clean ones
  (68% against 70% in the run below). Read that finding as maintenance cost,
  not as weak coverage.
- In Swift, a test that runs a repo script through `Process` and names it in
  a string reads as grepping the repo when it also reads files back. And a
  sha256 pin in a model manifest test is the contract for a weight file, which
  is a maintenance cost the `transcribes-fixture` finding reports as such.


### Calibration

The rules were tuned by running the scorer over 27 repos (1,548 test files,
about 300k lines: SvelteKit apps, Cloudflare Workers, CLIs, a Preact globe
renderer, node:test suites), then having five independent model readers close-read
49 files across five of those repos without seeing the scores. Each reader
named a real bug that would fail the test, a harmless refactor that would fail
it, and gave a 0–100 uselessness rating and a verdict.

| Measure | Value |
|---|---:|
| Spearman rank correlation, scorer vs model reader rating | 0.65 |
| Files where scorer and model reader agree on flagged vs clean | 41 of 49 |
| Files the scorer flags that a model reader would keep | 0 |
| Exact finding match | 35 of 49 |

The eight disagreements are all in the same direction: the scorer says keep, the
reviewer wants a refactor. They need reasoning a regex cannot do, such as
noticing that a route test only passes because a non-injected helper swallows
an error, or that a dispatch table in the source is being transcribed row by
row. Tautology alone correlates at 0.65 with the reviewers; it is the signal
that matters most, which is why it carries 40% of the weight.

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

Model reader ratings are still judgments. Mutation testing measures which simulated
bugs a test catches in the selected source: mutate it, then see which tests
fail. Stryker was run with per-test coverage and bail disabled, so every
covering test runs
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
the JSON reporter, then `useless --mutation reports/mutation/mutation.json`.
The mere-earth report itself was not kept, so those numbers cannot be
regenerated; the benchmark below stores its reports for that reason.

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

#### Swift

The Swift rules were written against `mere-run`, a 380-file, 100k-line
XCTest and Swift Testing suite for an on-device inference CLI: 371 XCTest
files, 7 Swift Testing, and 3,500 tests. The dialect differs enough from
Vitest that each JS signal needed a Swift counterpart rather than a translation:
`XCTAssertTrue(x.contains(...))` is a normal assertion, not a presence check,
so only `XCTAssertNotNil`, `!x.isEmpty`, `!= nil`, `GreaterThan(_, 0)` and
`is Foo` count as weak; there is no module mocking, so hand-rolled `Fake*`,
`Stub*` and `Recording*` types count as fn stubs and assertions over their
`calls` count as injected-fake call checks; and `XCTAssertEqual(` split over
four lines is the dominant literal shape, so the literal walker handles it.

| Measure | Value |
|---|---:|
| Test files scored | 374 (6 helpers with no tests dropped) |
| Source resolved by name | 251 (67%) |
| Median score / p90 | 3.3 / 15 |
| `restates-implementation` | 3, all contract tests that read docs, `Package.swift`, or shell scripts through `#filePath` and assert `contains` |
| `external-dependency` | 38 |
| `oversized-unit` | 7, over sources of 1,800 to 6,300 lines |
| `transcribes-fixture` | 4 |

The three tautology hits are real: one asserts 154 `contains` checks over
four shell scripts and the package manifest. The rest of the suite is clean by
these rules, which matches a read of it: the median file is short, literal
assertions dominate, and 2% of assertions are presence-only.

What Swift added to the scorer rather than reused:

- **Dependency gates.** 349 conditional skips across 93 files, almost all
  `guard ... else { throw XCTSkip }` on a GPU, `ffmpeg`, a model root from the
  environment, or an opt-in flag. These are integration tests that never run
  by default, so they get the `external-dependency` finding when they are at
  least half of a file's tests, and feed the environment signal in proportion.
  A gate on a hard-coded `/Users/` path is still a machine gate; a model root
  under the home directory is a dependency, not a machine.
- **Sibling by name.** SwiftPM keeps tests in `Tests/FooTests/BarTests.swift`
  and sources anywhere under `Sources/Foo/`, so the source is found from an
  index of tracked `.swift` files, preferring the test target's module and
  falling back to the name with its last word removed
  (`ImageGenerateCommandParsingTests` → `ImageGenerateCommand.swift`). A third
  of test files are named for a behaviour rather than a type and resolve to
  nothing; those cannot trigger `oversized-unit`.
- **xunit timings.** `swift test --xunit-output` reports class names, not
  paths, so timings are summed per class and joined to files by basename.

Swift has the same per-test scoring and mutation evidence as JS:
`useless mutate` produces the report and swift-argument-parser is a
benchmark case (see the benchmark table). No reviewer set exists for Swift,
so the weights are still the JS ones. `wait(for: [expectation])` is not
counted as a real-clock wait, and swizzling is the only thing counted as a
module mock.

## The close-read stage

The misses in every calibration round were the same kind: a test that passes
only because a helper swallows an error, a dispatch table transcribed row by
row, a scenario already covered next door. A regex cannot see those; a
reader can. `useless read` is that reader as a command:

```sh
npx useless-tests read --top 20 --reads 3 --out useless-read.json --md useless-read.md
npx useless-tests read --file src/x.test.ts --runner codex --model gpt-5.5
npx useless-tests read --scan all.json --min-score 25 --command 'my-model --stdin'
```

Each file goes to the model with a fixed rubric, the scorer's row, the tests
the scorer flags on their own, and the sibling source. The model answers the
three questions a human reviewer answers: which real bug in the module would
fail this file, which harmless refactor would fail it, and what the file is a
symptom of; then a 0–100 rating on the scorer's scale, a verdict (keep, fold,
move-out, rewrite-as-contract, refactor-source, delete, investigate) and a
confidence. `--reads 3` takes three independent reads and reports the median
rating and the majority verdict. Tied verdicts become `investigate`; files are
marked when the reads disagree by 30 points or on the verdict. Runners:
`claude -p` (default) and `codex exec`, both fed on
stdin, or any command via `--command`.

`investigate` means the read lacks enough context to recommend a change.
Before recommending that a test be folded or deleted, inspect overlapping
tests, the production entry point, and relevant history to identify the proof
that would remain. The built-in prompt includes the test and at most 400 lines
of its sibling source, so a model verdict alone is not removal evidence.

The rubric is measured the same way as the regexes: store the output next to
a benchmark case and `useless bench` reports its correlation with mutant
survival alongside the scorer's.

## The benchmark

`bench/bench.json` lists repos with a stored, reduced Stryker report;
`useless bench` rescans each with the current rules, joins the report, and
prints how well the score predicts survival at file and test level, plus
kill rates by finding. Every rule change is checked against it. See
`bench/README.md` for the Stryker settings and how to add a repo.

Current cases and results (`useless bench`, parse on):

| repo | files (own≥10) | units matched | file ρ own | file ρ all | unit ρ | flagged units: kill | clean units: kill | read ρ (n) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| hono | 138 (51) | 1086/1129 | 0.09 | 0.22 | 0.04 | 3: 0.15 | 1049: 0.45 | 0.27 (51) |
| immer | 23 (0) | 144/522 | – | 0.07 | 0.11 | 0: – | 130: 0.41 | – (0) |
| express | 88 (0) | 1116/1291 | – | -0.02 | -0.30 | 0: – | 1044: 0.24 | – (0) |
| zod | 198 (1) | 2072/2085 | – | -0.13 | -0.35 | 61: 0.43 | 1967: 0.35 | – (0) |
| react-hook-form | 152 (6) | 1246/1247 | 0.31 | -0.10 | -0.08 | 30: 0.22 | 1146: 0.13 | – (0) |
| swift-argument-parser | 58 (0) | 524/540 | – | 0.01 | 0.09 | 0: – | 506: 0.34 | – (0) |
| mere-run | 411 (0) | 1104/1104 | – | – | -0.12 | 0: – | 357: 0.02 | – (0) |

| repo | unit finding | units | mean kill rate |
|---|---|---:|---:|
| hono | restates-implementation | 3 | 0.15 |
| hono | clean | 1049 | 0.45 |
| zod | transcribes-fixture | 59 | 0.44 |
| zod | oversized-unit | 2 | 0.24 |
| zod | clean | 1967 | 0.35 |
| react-hook-form | restates-implementation | 26 | 0.14 |
| react-hook-form | transcribes-fixture | 4 | 0.73 |
| react-hook-form | clean | 1146 | 0.13 |

ρ is Spearman rank correlation between the score and mutant survival: file
score against survival in the file's own source (own) or in everything its
tests cover (all), and per-test score against survival in what that test
covers. "Flagged units" are tests the rules flag on their own; "read ρ" is
the close-read rating over the same files.

What these seven repos say, read honestly:

- **There is no clear file-level tail in these cases.** Hono's 51 files with
  own-source mutants are all `clean` and kill 79% of their mutants. Correlations
  near zero are the expected result. The
  mere-earth run in the previous section, on a suite with a tail, gave 0.80;
  that report was not kept, and re-running it is the next thing to add here.
- **The three hono tests the rules flag on their own kill 15% of what they
  cover; the 1,049 clean ones kill 45%.** Three is not a sample. On
  react-hook-form the same finding does not separate at all: its 26
  `restates-implementation` tests kill 14% against 13% for clean ones,
  because almost every test there is a jsdom render whose kills are spread
  thin. The per-test tautology signal is real on hono and invisible on
  react-hook-form; the benchmark exists to keep saying which.
- **The close-read beats the regexes on a healthy suite.** Over the same 51
  hono files the model's rating correlates at 0.27 with survival against the
  scorer's 0.09, with 50 of 51 verdicts `keep` and a median rating of 12.
  Its top-rated file names a module that reads globals instead of taking
  them as parameters; the scorer gave that file 1.3.
- **Express and zod are inverted per test.** Their unit ρ is -0.30 and
  -0.35: the tests the score dislikes (long, many literal assertions on a
  real response or a parsed value) are the ones that kill mutants, and the
  short ones kill less. The cost signal is a property of the codebase, as
  the mere-earth notes already said, and on these two it points the wrong
  way. Neither names tests after modules (express keeps `test/app.all.js`
  for `lib/application.js`, zod's core tests are mostly locale and
  integration files), so the file-level own-source measure is nearly empty.
- **`transcribes-fixture` is maintenance cost, not weakness, at test
  level too.** zod's 59 units with that finding kill 44% of what they cover
  against 35% for its clean units. The finding stays, and the reader should
  keep treating it as a bill rather than a gap.
- **92% of test blocks match the report by title or line.** immer is the exception
  (144 of 522): its suites build titles from `describe.each` tables, which
  the parse cannot resolve without running the code.

react-hook-form runs through a root `jest.stryker.config.js` that exports
its jsdom project alone, because Stryker's jest runner does not honour
`projects`. Its six sibling-named files give the only positive file-level
own-source correlation in the corpus, 0.31, on too few files to lean on.

swift-argument-parser and mere-run are the Swift cases, produced by
`useless mutate`. swift-argument-parser: 300 mutants sampled from 873 on
covered lines of the library, 194 killed, 47 survived, 59 compile errors,
about three seconds a mutant. Its 562 Swift Testing functions live in
`extension` blocks and nested suites, which is why the Swift splitter tracks
type ranges rather than the nearest declaration. mere-run: 80 mutants sampled
from 12,357 on covered lines of the CLI's command and support sources, run
against the CLI test target only (`--filter 'MereRunCLITests\.'`), 25
killed, 50 survived, 5 compile errors, about 25 seconds a mutant behind a
five-minute coverage pass over 80 suites. Every one of its 1,104 tests
matched a test block.

The mere-run number is the one to read twice. The rules call all 411 files
clean and flag no test on its own, yet the 357 tests that cover five or more
sampled mutants kill 2% of them on average. The CLI tests parse arguments and
run preflight paths, so they execute a great deal of command code, and then
assert on the parse. Broad execution with narrow assertion is exactly what a
regex over the test text cannot see and mutation testing sees at once. That
is the case for keeping mutation evidence in the loop rather than trusting the
score on a suite the score calls healthy.

## Library

```ts
import { rank, analyzeTest, score, WEIGHTS, FINDING_GUIDANCE } from 'useless-tests';

const rows = await rank({ root: '/path/to/repo' });   // Scored[], most useless first; each has .units
const signals = analyzeTest({ file, text, facts, source, sourceText, churn, timing });
const scored = score(signals);                         // { score, components, reasons, finding, units }
```

`analyzeTest` and `score` are pure; only `rank`/`collectRepo` touch git and the
filesystem. `facts` comes from `extractFacts(file, text)` after
`await initAst()`; without it the regex path runs. `joinMutation`,
`spearman`, `readFiles` and `runBench` are exported too.

## Claude Code skill

`skills/useless-tests/SKILL.md` gives an agent a test authoring checklist and
the full audit loop: run the scorer, close-read the outliers, write the audit,
and turn the findings into guardrails. Install it by symlinking the folder:

```sh
ln -s "$(pwd)/skills/useless-tests" ~/.claude/skills/useless-tests
```

## Development

```sh
pnpm install
pnpm check        # typecheck, lint, test, build
pnpm dev --root ../some-repo
```

See [the release guide](docs/release.md) for package verification, the first
npm publish, and later GitHub Actions releases.

The scorer's own tests are contract tests over synthetic inputs and a throwaway
git repo. Running `useless` on this repo used to be a live demo of its blind
spot: the signals test was flagged `restates-implementation` because its
inputs are the patterns it detects. With the parse it scores 2 and clean; the
repo test still shells out to real `git` because git plumbing is the unit
under test, and says so.

`USELESS_CORPUS=~/projects/useless-corpus pnpm dev bench` runs the benchmark
against local checkouts of the corpus repos.

## Origin

Calibrated on a 533-file, 122k-line Vitest and Playwright suite, where three
independent model close-reads of the top-scoring files agreed with the ranking. The
weights are opinions. Change them in `src/score.ts`.
