#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { rank } from './index.js';
import { DEFAULT_PATTERNS, loadTimings } from './repo.js';
import { markdownTable, summarize, summaryLines } from './report.js';

const HELP = `useless — rank test files by how useless they are

Usage:
  useless [options]

Options:
  --root <dir>        Repo to scan (default: cwd). Must be a git checkout.
  --top <n>           Rows to print (default: 40; 0 = all)
  --min-score <n>     Only print rows scoring at least n
  --timings <file>    vitest/jest JSON report (--reporter=json --outputFile=<file>)
                      so runtime is folded into the cost signal
  --pattern <glob>    git ls-files pattern for test files; repeatable
                      (default: ${DEFAULT_PATTERNS.join(' ')})
  --json <file>       Write every scored row (all signals) to a JSON file
  --format <md|json>  Print a markdown table (default) or JSON to stdout
  -h, --help          Show this help
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: process.cwd() },
      top: { type: 'string', default: '40' },
      'min-score': { type: 'string' },
      timings: { type: 'string' },
      pattern: { type: 'string', multiple: true },
      json: { type: 'string' },
      format: { type: 'string', default: 'md' },
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

  const rows = rank({
    root,
    ...(patterns ? { patterns } : {}),
    timings: loadTimings(values.timings, root),
  });
  if (values.json) writeFileSync(values.json, JSON.stringify(rows, null, 2));

  const shown = rows.filter((row) => row.score >= minScore).slice(0, top > 0 ? top : undefined);
  if (values.format === 'json') {
    process.stdout.write(`${JSON.stringify({ summary: summarize(rows), rows: shown }, null, 2)}\n`);
    return;
  }
  const out = [...summaryLines(summarize(rows)), '', markdownTable(shown), ''];
  process.stdout.write(out.join('\n'));
}

main();
