import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { rank } from './index.js';
import type { Scored } from './types.js';

/**
 * The close-read stage as a command. The scorer triages; a model reads the
 * top files against a fixed rubric and answers the three questions a human
 * reviewer answers: which real bug would fail this test, which harmless
 * refactor would fail it, and what the test is a symptom of. Ratings are
 * numbers on the scorer's scale so `useless bench` can hold them to the same
 * mutation data.
 */

export const VERDICTS = [
  'keep',
  'investigate',
  'fold',
  'move-out',
  'rewrite-as-contract',
  'refactor-source',
  'delete',
] as const;
export type ReadVerdict = (typeof VERDICTS)[number];

export type Read = {
  rating: number;
  verdict: ReadVerdict;
  bug: string;
  refactor: string;
  symptom: string;
  confidence: 'low' | 'medium' | 'high';
  notes: string;
};

export type FileRead = {
  file: string;
  score: number;
  finding: Finding;
  reasons: string[];
  reads: Read[];
  /** Median rating across reads; null when no read parsed. */
  rating: number | null;
  /** Most common verdict; ties require further investigation. */
  verdict: ReadVerdict | null;
  /** Reads disagree by 30 points or on the verdict. */
  disagree: boolean;
  errors: string[];
};

type Finding = Scored['finding'];

export const RUBRIC = `You are reviewing one automated test file for usefulness. A test is useless in
proportion to how much it costs to keep versus how many plausible regressions it
can catch. Read the test file and, if given, the module it tests. Then answer:

1. bug: Name one realistic bug in the module under test that would make this
   file fail. If you cannot name one, say "none" and explain why.
2. refactor: Name one behaviour-preserving refactor of the module (rename,
   reorder, extract, change an internal call) that would make this file fail.
   If none, say "none".
3. symptom: What is this test file a symptom of, if anything: an untestable
   module, missing dependency injection, a generated artifact with no
   regeneration path, coverage thresholds steering effort, or nothing.
   Consider whether the test needs production code used only by tests.
4. rating: 0-100, how useless the file is. 0 is a fail-closed behavioural test
   that catches real bugs cheaply. 100 is a test that cannot fail on any bug
   and fails on every refactor. Use the whole scale.
5. verdict: one of keep, investigate (more context is needed), fold (merge
   with a sibling), move-out (keep, but out of the unit suite),
   rewrite-as-contract (state the invariant instead of the current output),
   refactor-source (the cost is the module, not the test), delete.
6. confidence: low, medium, or high.

The scorer's row is context, not a decision. Keep an independent public API,
protocol, config, storage, security, platform, package, or release contract.
Source inspection can also guard a user-facing value or path through internal
refactors. A slow or static test can still be valuable.

Before recommending fold or delete, inspect overlapping tests and the
production entry point, callers, and relevant history when available. Name
the stronger proof that remains in notes. If you cannot establish that proof
from the available context, choose investigate and name what to inspect next.
The supplied source may be truncated. Do not infer missing behavior from it.

Reply with a single JSON object and nothing else:
{"rating": <0-100>, "verdict": "<verdict>", "bug": "...", "refactor": "...", "symptom": "...", "confidence": "<low|medium|high>", "notes": "<one or two sentences>"}`;

const MAX_TEST_LINES = 1200;
const MAX_SOURCE_LINES = 400;

function clip(text: string, maxLines: number, label: string): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n// ... ${label} truncated after ${maxLines} of ${lines.length} lines`;
}

export function buildPrompt(root: string, row: Scored): string {
  const testText = readFileSync(join(root, row.file), 'utf8');
  const sourcePath = row.source ? join(root, row.source) : null;
  const sourceText = sourcePath && existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : null;
  const flaggedUnits = row.units
    .filter((u) => u.finding !== 'clean')
    .slice(0, 12)
    .map((u) => `  - line ${u.line} "${u.name}": ${u.finding}; ${u.reasons.join('; ')}`);
  const parts = [
    RUBRIC,
    '',
    `## Scorer row for ${row.file}`,
    `score ${row.score} · finding ${row.finding} · ${row.lines} lines · ${row.tests} tests · ${row.expects} expects · ${row.mocks} mocks`,
    row.reasons.length ? `reasons: ${row.reasons.join('; ')}` : 'reasons: none',
    ...(flaggedUnits.length ? ['tests the scorer flags on their own:', ...flaggedUnits] : []),
    '',
    `## Test file: ${row.file}`,
    '```',
    clip(testText, MAX_TEST_LINES, 'test file'),
    '```',
  ];
  if (sourceText && row.source) {
    parts.push(
      '',
      `## Module under test: ${row.source}`,
      '```',
      clip(sourceText, MAX_SOURCE_LINES, 'source'),
      '```',
    );
  } else {
    parts.push('', '## Module under test', 'No sibling source file was found by name.');
  }
  return parts.join('\n');
}

export type Runner = { command: string; args: string[]; extract: (stdout: string) => string };

/**
 * Presets: `claude -p` returns a JSON envelope whose `result` is the reply;
 * `codex exec` prints a transcript whose last line is the reply.
 */
export function makeRunner(
  name: string,
  model: string | undefined,
  command: string | undefined,
): Runner {
  if (command) return { command: 'sh', args: ['-c', command], extract: (s) => s };
  if (name === 'codex')
    return {
      command: 'codex',
      args: [
        'exec',
        '-s',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        ...(model ? ['-m', model] : []),
        '-',
      ],
      extract: (s) => s,
    };
  return {
    command: 'claude',
    args: ['-p', '--output-format', 'json', ...(model ? ['--model', model] : [])],
    extract: (s) => {
      try {
        const parsed = JSON.parse(s) as { result?: string };
        return typeof parsed.result === 'string' ? parsed.result : s;
      } catch {
        return s;
      }
    },
  };
}

export function runPrompt(runner: Runner, prompt: string, cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(runner.command, runner.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && !out.trim())
        reject(new Error(`${runner.command} exited ${code}: ${err.trim().slice(-400)}`));
      else resolvePromise(runner.extract(out));
    });
    child.stdin.end(prompt);
  });
}

/** The last balanced JSON object in a reply, fenced or bare. */
export function parseRead(reply: string): Read {
  const candidates: string[] = [];
  for (const m of reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1] ?? '');
  let depth = 0;
  let start = -1;
  for (let i = 0; i < reply.length; i += 1) {
    const ch = reply[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(reply.slice(start, i + 1));
    }
  }
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c) as Partial<Read>;
      if (typeof v.rating !== 'number' || !VERDICTS.includes(v.verdict as ReadVerdict)) continue;
      return {
        rating: Math.max(0, Math.min(100, Math.round(v.rating))),
        verdict: v.verdict as ReadVerdict,
        bug: String(v.bug ?? ''),
        refactor: String(v.refactor ?? ''),
        symptom: String(v.symptom ?? ''),
        confidence: v.confidence === 'low' || v.confidence === 'high' ? v.confidence : 'medium',
        notes: String(v.notes ?? ''),
      };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`no verdict JSON in reply: ${reply.slice(0, 200)}`);
}

export function aggregate(reads: Read[]): Pick<FileRead, 'rating' | 'verdict' | 'disagree'> {
  if (reads.length === 0) return { rating: null, verdict: null, disagree: false };
  const ratings = reads.map((r) => r.rating).sort((a, b) => a - b);
  const mid = Math.floor(ratings.length / 2);
  const rating =
    ratings.length % 2
      ? (ratings[mid] ?? 0)
      : Math.round(((ratings[mid - 1] ?? 0) + (ratings[mid] ?? 0)) / 2);
  const counts = new Map<ReadVerdict, number>();
  for (const r of reads) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
  const best = Math.max(...counts.values());
  const leaders = VERDICTS.filter((v) => counts.get(v) === best);
  const verdict = leaders.length === 1 ? (leaders[0] ?? 'investigate') : 'investigate';
  const spread = (ratings[ratings.length - 1] ?? 0) - (ratings[0] ?? 0);
  return { rating, verdict, disagree: reads.length > 1 && (spread >= 30 || counts.size > 1) };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export type ReadOptions = {
  root: string;
  rows: Scored[];
  runner: Runner;
  reads: number;
  concurrency: number;
  log?: (line: string) => void;
};

export async function readFiles(options: ReadOptions): Promise<FileRead[]> {
  const { root, rows, runner, reads, concurrency, log } = options;
  const jobs = rows.flatMap((row) => Array.from({ length: reads }, (_, i) => ({ row, i })));
  const replies = await mapLimit(jobs, concurrency, async ({ row, i }) => {
    const prompt = buildPrompt(root, row);
    try {
      const reply = await runPrompt(runner, prompt, root);
      const read = parseRead(reply);
      log?.(`read ${row.file} #${i + 1}: ${read.rating} ${read.verdict}`);
      return { row, read, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log?.(`read ${row.file} #${i + 1}: failed (${message.slice(0, 120)})`);
      return { row, read: null, error: message };
    }
  });
  return rows.map((row) => {
    const own = replies.filter((r) => r.row === row);
    const good = own.flatMap((r) => (r.read ? [r.read] : []));
    return {
      file: row.file,
      score: row.score,
      finding: row.finding,
      reasons: row.reasons,
      reads: good,
      ...aggregate(good),
      errors: own.flatMap((r) => (r.error ? [r.error] : [])),
    };
  });
}

export function readTable(reads: FileRead[]): string {
  const header =
    '| score | finding | rating | verdict | file | bug that would fail it | refactor that would fail it |\n|---:|---|---:|---|---|---|---|';
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const body = reads.map((r) => {
    const first = r.reads[0];
    return `| ${r.score} | ${r.finding} | ${r.rating ?? '–'}${r.disagree ? ' ±' : ''} | ${r.verdict ?? '–'} | \`${r.file}\` | ${cell(first?.bug ?? r.errors[0] ?? '')} | ${cell(first?.refactor ?? '')} |`;
  });
  return [header, ...body].join('\n');
}

const HELP = `useless read — close-read the top files with a model

Usage:
  useless read [options]

Options:
  --root <dir>          Repo to scan (default: cwd)
  --scan <file>         Reuse a scan's --json output instead of rescanning
  --top <n>             Files to read, most useless first (default: 20)
  --min-score <n>       Only read files scoring at least n
  --file <path>         Read this file; repeatable (overrides --top)
  --runner <name>       claude (default) or codex; both read the prompt on stdin
  --model <name>        Model passed to the runner (--model / -m)
  --command <shell>     Custom runner: a shell command that reads the prompt on stdin
                        and prints the reply
  --reads <n>           Independent reads per file (default: 1); median rating,
                        majority verdict, disagreements marked ±
  --concurrency <n>     Parallel runner processes (default: 4)
  --out <file>          Write the reads as JSON (default: useless-read.json)
  --md <file>           Also write the table as markdown
  -h, --help            Show this help
`;

export async function readCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string', default: process.cwd() },
      scan: { type: 'string' },
      top: { type: 'string', default: '20' },
      'min-score': { type: 'string' },
      file: { type: 'string', multiple: true },
      runner: { type: 'string', default: 'claude' },
      model: { type: 'string' },
      command: { type: 'string' },
      reads: { type: 'string', default: '1' },
      concurrency: { type: 'string', default: '4' },
      out: { type: 'string', default: 'useless-read.json' },
      md: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const root = resolve(values.root);
  const all: Scored[] = values.scan
    ? (JSON.parse(readFileSync(values.scan, 'utf8')) as Scored[])
    : await rank({ root });
  const minScore = values['min-score'] === undefined ? 0 : Number(values['min-score']);
  const top = Number(values.top);
  const rows = values.file?.length
    ? all.filter((r) => values.file?.includes(r.file))
    : all.filter((r) => r.score >= minScore).slice(0, top > 0 ? top : undefined);
  if (rows.length === 0) {
    process.stderr.write('useless read: nothing to read\n');
    return;
  }
  const runner = makeRunner(values.runner, values.model, values.command);
  process.stderr.write(
    `useless read: ${rows.length} file(s) × ${values.reads} read(s) via ${values.command ?? values.runner}\n`,
  );
  const reads = await readFiles({
    root,
    rows,
    runner,
    reads: Math.max(1, Number(values.reads)),
    concurrency: Math.max(1, Number(values.concurrency)),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  writeFileSync(values.out, JSON.stringify(reads, null, 2));
  const table = readTable(reads);
  if (values.md) writeFileSync(values.md, `${table}\n`);
  process.stdout.write(`${table}\n`);
}
