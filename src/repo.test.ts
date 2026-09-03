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
  findSharedBlocks,
  findSimilar,
  listTestFiles,
  parseTimings,
  resolveModuleText,
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
  mkdirSync(join(root, 'test/fixtures'), { recursive: true });
  mkdirSync(join(root, 'src/__tests__'), { recursive: true });
  writeFileSync(join(root, 'test/app.js'), "it('boots', () => { expect(1).toBe(1); });\n");
  writeFileSync(join(root, 'test/helpers.js'), 'export const h = 1;\n');
  writeFileSync(join(root, 'test/support.js'), 'export const s = 1;\n');
  writeFileSync(join(root, 'test/fixtures/data.js'), "it('not really', () => {});\n");
  writeFileSync(join(root, 'src/__tests__/util.js'), "test('u', () => { expect(2).toBe(2); });\n");
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

  it('lists tracked test files, including conventional test directories', () => {
    expect(listTestFiles(root)).toEqual([
      'src/__tests__/util.js',
      'src/add.test.ts',
      'src/grep.spec.ts',
      'test/app.js',
      'test/helpers.js',
      'test/support.js',
    ]);
  });

  it('drops test-directory files that contain no tests', () => {
    expect(rank({ root }).map((r) => r.file)).not.toContain('test/support.js');
    expect(rank({ root }).map((r) => r.file)).toContain('test/app.js');
    expect(rank({ root }).map((r) => r.file)).toContain('src/__tests__/util.js');
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
    expect(rows[0]?.file).toBe('src/grep.spec.ts');
    expect(rows[0]?.verdict).toBe('delete-or-rewrite');
    expect(rows.find((r) => r.file === 'src/add.test.ts')?.verdict).toBe('keep');
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

describe('findSimilar', () => {
  const harness = Array.from(
    { length: 30 },
    (_, i) => `const mockThing${i} = vi.fn(() => ({ id: ${i} }));`,
  );
  it('reports the later file of a mutual pair, pointing at the earlier one', () => {
    const a = [...harness, "it('a', () => { expect(run()).toBe(1); });"].join('\n');
    const b = [...harness, "it('b', () => { expect(run()).toBe(2); });", 'const extra = 1;'].join(
      '\n',
    );
    const c = Array.from(
      { length: 30 },
      (_, i) => `expect(values[${i}]).toEqual({ id: ${i} });`,
    ).join('\n');
    const similar = findSimilar([
      { file: 'a.test.ts', text: a },
      { file: 'b.test.ts', text: b },
      { file: 'c.test.ts', text: c },
    ]);
    expect(similar.has('a.test.ts')).toBe(false);
    expect(similar.get('b.test.ts')).toEqual({ file: 'a.test.ts', share: 0.94 });
    expect(similar.has('c.test.ts')).toBe(false);
  });
  it('ignores small files and much larger partners', () => {
    const tiny = "it('x', () => { expect(1).toBe(1); });";
    expect(
      findSimilar([
        { file: 't.test.ts', text: tiny },
        { file: 'u.test.ts', text: tiny },
      ]).size,
    ).toBe(0);
  });
});

describe('resolveModuleText', () => {
  it('follows a re-export barrel to the real modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'useless-barrel-'));
    mkdirSync(join(root, 'src/ops'), { recursive: true });
    writeFileSync(
      join(root, 'src/ops.ts'),
      "// Barrel\nexport * from './ops/items';\nexport {\n  board,\n  type Board,\n} from './ops/board';\n",
    );
    writeFileSync(join(root, 'src/ops/items.ts'), 'export function items() {\n  return 1;\n}\n');
    writeFileSync(join(root, 'src/ops/board.ts'), 'export const board = () => 2;\n');
    const r = resolveModuleText(root, 'src/ops.ts');
    expect(r.files).toEqual(['src/ops/items.ts', 'src/ops/board.ts']);
    expect(r.text).toContain('function items');
    expect(r.text).toContain('board = ()');
    const plain = resolveModuleText(root, 'src/ops/items.ts');
    expect(plain.files).toEqual(['src/ops/items.ts']);
  });
});

describe('findSharedBlocks', () => {
  it('finds a setup block repeated across three files and ignores pairs', () => {
    const harness = Array.from(
      { length: 12 },
      (_, i) => `const RESET_STATEMENT_${i} = 'DROP TABLE IF EXISTS table_${i}';`,
    );
    const mk = (n: number) =>
      [...harness, `it('case ${n}', () => { expect(run(${n})).toBe(${n}); });`].join('\n');
    const shared = findSharedBlocks([
      { file: 'a.test.ts', text: mk(1) },
      { file: 'b.test.ts', text: mk(2) },
      { file: 'c.test.ts', text: mk(3) },
      { file: 'd.test.ts', text: "it('alone', () => { expect(1).toBe(1); });" },
    ]);
    expect(shared.get('a.test.ts')).toEqual({ lines: 12, files: 3 });
    expect(shared.has('d.test.ts')).toBe(false);
    const pair = findSharedBlocks([
      { file: 'a.test.ts', text: mk(1) },
      { file: 'b.test.ts', text: mk(2) },
    ]);
    expect(pair.size).toBe(0);
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
