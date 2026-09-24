#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { benchTable, runBench } from './bench.js';
import { rank } from './index.js';
import { joinMutation, loadMutationReport } from './mutation.js';
import { DEFAULT_PATTERNS, loadTimings } from './repo.js';
import { flattenUnits, markdownTable, summarize, summaryLines, unitTable } from './report.js';

const HELP = `useless — rank test files by how useless they are

Usage:
  useless [options]              Scan a repo (default command)
  useless bench [options]        Score the benchmark repos against their mutation reports
  useless read [options]         Close-read the top files with a model (see read --help)
  useless mutate [options]       Mutation-test a Swift package with per-test attribution (see mutate --help)

Scan options:
  --root <dir>        Repo to scan (default: cwd). Must be a git checkout.
  --top <n>           Rows to print (default: 40; 0 = all)
  --min-score <n>     Only print rows scoring at least n
  --timings <file>    vitest/jest JSON report (--reporter=json --outputFile=<file>)
                      or swift test xunit XML (--xunit-output <file>)
                      so runtime is folded into the cost signal
  --mutation <file>   Stryker mutation.json (coverageAnalysis perTest, disableBail):
                      per-file and per-test kill rates and redundancy are joined in
  --pattern <glob>    git ls-files pattern for test files; repeatable
                      (default: ${DEFAULT_PATTERNS.join(' ')})
  --json <file>       Write every scored row (all signals, all tests) to a JSON file
  --format <md|json>  Print a markdown table (default) or JSON to stdout
  --no-ast            Skip the tree-sitter parse; regex-only analysis
  --per-test          Rank individual test blocks instead of files
  -h, --help          Show this help

Bench options:
  --manifest <file>   Benchmark manifest (default: bench/bench.json)
  --only <name>       Run one case; repeatable
  --no-ast            Regex-only analysis, for comparison
  --json <file>       Write the results as JSON
`;

async function scan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string', default: process.cwd() },
      top: { type: 'string', default: '40' },
      'min-score': { type: 'string' },
      timings: { type: 'string' },
      mutation: { type: 'string' },
      pattern: { type: 'string', multiple: true },
      json: { type: 'string' },
      format: { type: 'string', default: 'md' },
      'no-ast': { type: 'boolean', default: false },
      'per-test': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = values.root;
  const top = Number(values.top);
  const minScore = values['min-score'] === undefined ? 0 : Number(values['min-score']);
  const patterns = values.pattern && values.pattern.length > 0 ? values.pattern : undefined;

  const scored = await rank({
    root,
    ...(patterns ? { patterns } : {}),
    timings: loadTimings(values.timings, root),
    ast: !values['no-ast'],
  });
  const rows = values.mutation
    ? joinMutation(scored, loadMutationReport(values.mutation), root).rows
    : scored;
  if (values.json) writeFileSync(values.json, JSON.stringify(rows, null, 2));

  const shown = rows.filter((row) => row.score >= minScore).slice(0, top > 0 ? top : undefined);
  if (values.format === 'json') {
    process.stdout.write(`${JSON.stringify({ summary: summarize(rows), rows: shown }, null, 2)}\n`);
    return;
  }
  const table = values['per-test']
    ? unitTable(
        flattenUnits(rows)
          .filter((u) => u.score >= minScore)
          .slice(0, top > 0 ? top : undefined),
      )
    : markdownTable(shown);
  const out = [...summaryLines(summarize(rows)), '', table, ''];
  process.stdout.write(out.join('\n'));
}

async function bench(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      manifest: { type: 'string', default: 'bench/bench.json' },
      only: { type: 'string', multiple: true },
      'no-ast': { type: 'boolean', default: false },
      json: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const results = await runBench(values.manifest, {
    ast: !values['no-ast'],
    only: values.only ?? [],
  });
  if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2));
  process.stdout.write(`${benchTable(results)}\n`);
}

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2);
  if (first === 'bench') return bench(rest);
  if (first === 'mutate') {
    const { mutateCommand } = await import('./mutate.js');
    return mutateCommand(rest);
  }
  if (first === 'read') {
    const { readCommand } = await import('./read.js');
    return readCommand(rest);
  }
  return scan(process.argv.slice(2));
}

await main();
