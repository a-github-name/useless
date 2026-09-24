# Benchmark

`useless bench` rescans each repo listed in `bench.json` with the current
rules and measures the score against a stored Stryker mutation report:
which tests kill mutants, which do not, and which kill nothing that another
test does not. A rule change is judged by these numbers.

```sh
USELESS_CORPUS=~/projects/useless-corpus useless bench            # all cases
useless bench --only hono --no-ast                                 # regex-only, for comparison
useless bench --json bench/results.json
```

Roots in the manifest are relative to `USELESS_CORPUS` when it is set,
otherwise to this directory. Check out each case, including the public
`mere-run` repo, at the commit recorded in `bench.json` before comparing
numbers. These stored reports use relative source and test paths, so they work
with your checkout location.

## Adding a repo

1. Install Stryker and the runner for the repo's test framework:
   `@stryker-mutator/core` plus `vitest-runner`, `jest-runner` or
   `mocha-runner`. Under pnpm, point `plugins` at the package path so Stryker
   can find it.
2. Write `stryker.config.json`. The settings that matter for attribution:

   ```json
   {
     "testRunner": "vitest",
     "mutate": ["src/**/*.ts", "!src/**/*.test.*"],
     "coverageAnalysis": "perTest",
     "disableBail": true,
     "ignoreStatic": true,
     "reporters": ["json", "progress"],
     "jsonReporter": { "fileName": "reports/mutation/mutation.json" },
     "concurrency": 6,
     "timeoutMS": 20000,
     "disableTypeChecks": true
   }
   ```

   `perTest` records which tests cover each mutant; `disableBail` keeps
   running after the first kill so every killing test is credited. Use
   `"inPlace": true` when the sandbox copy breaks fixtures or hits a socket
   file. Limit `mutate` to a few directories on a large repo: hono's
   `src/utils`, `src/helper` and `src/middleware` gave 6,650 mutants in
   twelve minutes at concurrency 6.
3. Reduce the report so only ids, statuses and attribution are stored:

   ```sh
   node -e "
   import('./dist/mutation.js').then(({ loadMutationReport, reduceReport }) => {
     const { writeFileSync } = require('node:fs');
     const { gzipSync } = require('node:zlib');
     const r = reduceReport(loadMutationReport(process.argv[1]));
     writeFileSync(process.argv[2], gzipSync(Buffer.from(JSON.stringify(r))));
   })" path/to/mutation.json bench/reports/<name>.json.gz
   ```
4. Add a case to `bench.json` with the repo's commit.
5. Optionally run `useless read` over the files with ten or more mutants in
   their own source and store the output under `reads/`; the manifest's
   `reads` field makes the benchmark score the rubric on the same data.

## Swift packages

Stryker is JavaScript-only. For a Swift package run the built-in runner:

```sh
useless mutate --root ../some-package --mutate 'Sources/Lib/*' --max 300
```

It builds once with coverage, records which source lines each test suite
executes, and for each sampled mutant rebuilds, runs only the covering
suites, and reads the xunit output to credit every failing test. Test runs
use `--parallel`, which is the only mode in which SwiftPM writes XCTest
xunit output. On a large package pass `--filter '<TestTarget>\.'` so the
baseline and coverage passes cover only the target that can reach the
mutated sources; mere-run's CLI target took five minutes that way. The report
it writes at `reports/mutation/mutation.json` is Stryker-shaped; reduce and
register it exactly as above. Keep `--mutate` to the library sources so test
helpers are not mutated, and expect a few per cent of compile errors from
operators that produce invalid Swift; those are recorded and excluded.

## What the columns mean

- **file ρ own**: Spearman of file score against the survival rate of mutants
  in the file's sibling source, over files with at least ten such mutants.
  The number the README quotes.
- **file ρ all**: the same over every mutant the file's tests cover.
- **unit ρ**: Spearman of per-test score against survival over the mutants
  that test covers, for tests covering at least five.
- **flagged units / clean units**: how many tests the rules flag on their own
  (any finding but clean or review) and the mean kill rate of each group.
- **read ρ**: Spearman of the close-read rating against own-source survival,
  when reads are stored.

Correlations near zero are expected on a healthy suite: the score is a tail
detector, and when there is no tail it has nothing to rank. The
flagged-versus-clean kill rates and the per-finding tables are the numbers
that should move when a rule improves.
