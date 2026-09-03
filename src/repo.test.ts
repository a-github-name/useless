import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rank } from './index.js';
import {
  buildChurnIndex,
  churnFor,
  findDuplicates,
  listTestFiles,
  parseTimings,
  siblingSource,
} from './repo.js';

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'useless-'));
  git(root, 'init', '-q');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src/add.ts'),
    'export function add(a: number, b: number) { return a + b; }\nexport function sub(a: number, b: number) { return a - b; }\nexport const neg = (a: number) => -a;\n',
  );
  writeFileSync(
    join(root, 'src/add.test.ts'),
    "import { add } from './add';\nit('adds', () => { expect(add(1, 2)).toBe(3); });\n",
  );
  writeFileSync(
    join(root, 'src/grep.spec.ts'),
    [
      "const src = readFileSync('src/add.ts', 'utf8');",
      "it('has export', () => { expect(src).toContain('export const'); });",
      "it('no any', () => { expect(src).not.toContain('any'); });",
      "it('arrow', () => { expect(src).toMatch(/=>/); });",
      "it('typed', () => { expect(src).toContain('number'); });",
      "it('short', () => { expect(src.length).toBeGreaterThan(10); });",
    ].join('\n'),
  );
  writeFileSync(join(root, 'src/notes.md'), 'x');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  writeFileSync(
    join(root, 'src/add.ts'),
    'export function add(a: number, b: number) { return b + a; }\nexport function sub(a: number, b: number) { return a - b; }\nexport const neg = (a: number) => -a;\n',
  );
  writeFileSync(join(root, 'src/add.test.ts'), "it('adds', () => { expect(1).toBe(1); });\n");
  git(root, 'commit', '-q', '-am', 'two');
  return root;
}

describe('repo plumbing', () => {
  const root = makeRepo();

  it('lists tracked test files only', () => {
    expect(listTestFiles(root)).toEqual(['src/add.test.ts', 'src/grep.spec.ts']);
  });

  it('finds the co-located source by name', () => {
    expect(siblingSource(root, 'src/add.test.ts')).toBe('src/add.ts');
    expect(siblingSource(root, 'src/grep.spec.ts')).toBeNull();
  });

  it('computes co-change churn from git history', () => {
    const index = buildChurnIndex(root);
    expect(churnFor(index, 'src/add.test.ts', 'src/add.ts')).toEqual({
      testCommits: 2,
      sourceCommits: 2,
      coChangeCommits: 2,
    });
    expect(churnFor(index, 'src/grep.spec.ts', null)).toEqual({
      testCommits: 1,
      sourceCommits: 0,
      coChangeCommits: 0,
    });
  });

  it('ranks the source-grepping test above the real one', () => {
    const rows = rank({ root });
    expect(rows.map((r) => r.file)).toEqual(['src/grep.spec.ts', 'src/add.test.ts']);
    expect(rows[0]?.verdict).toBe('delete-or-rewrite');
    expect(rows[1]?.verdict).toBe('keep');
  });
});

describe('findDuplicates', () => {
  it('maps later copies to the first file with the same whitespace-stripped content', () => {
    const dupes = findDuplicates([
      { file: 'a.test.ts', text: "it('x', () => {\n  expect(1).toBe(1);\n});" },
      { file: 'b.test.ts', text: "it('x',()=>{expect(1).toBe(1);});" },
      { file: 'c.test.ts', text: "it('y', () => {});" },
    ]);
    expect([...dupes.entries()]).toEqual([['b.test.ts', 'a.test.ts']]);
  });
});

describe('parseTimings', () => {
  it('keys vitest/jest results by repo-relative path and ignores malformed rows', () => {
    const json = JSON.stringify({
      testResults: [
        { name: '/repo/src/a.test.ts', startTime: 100, endTime: 350, status: 'passed' },
        { name: '/repo/src/b.test.ts', startTime: 10, endTime: 5, status: 'failed' },
        { name: 'nope' },
      ],
    });
    const timings = parseTimings(json, '/repo');
    expect(timings.get('src/a.test.ts')).toEqual({ durationMs: 250, failed: false });
    expect(timings.get('src/b.test.ts')).toEqual({ durationMs: 0, failed: true });
    expect(timings.size).toBe(2);
  });

  it('returns nothing for a report without testResults', () => {
    expect(parseTimings('{"numTotalTests": 3}', '/repo').size).toBe(0);
  });
});
