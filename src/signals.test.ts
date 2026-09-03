import { describe, expect, it } from 'vitest';
import { analyzeTest, countFunctions, measureLiteralBlocks } from './signals.js';
import type { Churn } from './types.js';

const churn: Churn = { testCommits: 1, sourceCommits: 1, coChangeCommits: 1 };

function analyze(text: string, file = 'src/thing.test.ts', sourceText: string | null = null) {
  return analyzeTest({
    file,
    text,
    source: sourceText === null ? null : 'src/thing.ts',
    sourceText,
    churn,
    timing: null,
  });
}

describe('analyzeTest', () => {
  it('counts tests including modifiers and table forms', () => {
    const text = [
      "it('a', () => {});",
      "test('b', () => {});",
      "it.skip('c', () => {});",
      "test.each([1, 2])('d %i', () => {});",
      "it.skipIf(process.platform === 'win32')('e', () => {});",
      "describe('not a test', () => {});",
    ].join('\n');
    const s = analyze(text);
    expect(s.tests).toBe(5);
    expect(s.skipped).toBe(1);
    expect(s.gatedSuites).toBe(1);
  });

  it('separates weak presence checks from real assertions', () => {
    const text = [
      'expect(x).toBeTruthy();',
      'expect(x).toBeDefined();',
      'expect(fn).toHaveBeenCalled();',
      'expect(fn).not.toHaveBeenCalled();',
      'expect(fn).toHaveBeenCalledTimes(2);',
      'expect(fn).toHaveBeenCalledWith(1);',
      "expect(x).toBe('literal');",
      'expect(list).toEqual([1, 2]);',
      'expect(buf.byteLength).toBeGreaterThan(0);',
      'expect(out).not.toBeNull();',
      'expect(a).not.toBe(b);',
      'expect(total).toBeGreaterThan(40);',
    ].join('\n');
    const s = analyze(text);
    expect(s.expects).toBe(12);
    expect(s.weakExpects).toBe(5);
    expect(s.callExpects).toBe(4);
    expect(s.callExpectsCounted).toBe(2);
    expect(s.callExpectsWith).toBe(1);
    expect(s.literalExpects).toBe(2);
  });

  it('counts SQL text pinned through toContain or toMatch', () => {
    const s = analyze(
      [
        "expect(sql).toContain('UPDATE generation_jobs SET');",
        "expect(sql).toContain('FROM sms_threads');",
        "expect(sql).toMatch('json_set(metadata');",
        "expect(out).toContain('hello');",
      ].join('\n'),
    );
    expect(s.sqlTextAsserts).toBe(3);
  });

  it('weighs module mocks separately from fn stubs, for vitest and jest', () => {
    const text = [
      "vi.mock('./a');",
      "jest.mock('./b');",
      'const f = vi.fn();',
      "const g = jest.spyOn(obj, 'm');",
      "vi.stubEnv('X', '1');",
    ].join('\n');
    const s = analyze(text);
    expect(s.mocks).toBe(5);
    expect(s.moduleMocks).toBe(2);
  });

  it('flags source-text assertions and greps over repo source files', () => {
    const text = [
      "const src = readFileSync('src/app.tsx', 'utf8');",
      "expect(src).toContain('export function');",
      'expect(src).toMatch(/import .* from/);',
      "expect(src).not.toContain('any');",
    ].join('\n');
    const s = analyze(text);
    expect(s.sourceTextAsserts).toBeGreaterThanOrEqual(2);
    expect(s.repoTextAsserts).toBe(3);
  });

  it('does not treat reading a JSON fixture or a tmpdir as grepping the repo', () => {
    const fixture = [
      "const data = readFileSync('fixtures/cases.json', 'utf8');",
      'expect(JSON.parse(data).length).toBe(3);',
    ].join('\n');
    expect(analyze(fixture).repoTextAsserts).toBe(0);
    const helper = [
      "const read = (p: string) => readFileSync(join(root, p), 'utf8');",
      "expect(read('components/App.tsx')).not.toContain('legacy');",
    ].join('\n');
    expect(analyze(helper).repoTextAsserts).toBe(1);
    const listing = [
      "const files = readdirSync(join(root, 'src')).filter((f) => f.endsWith('.tsx'));",
      "for (const f of files) expect(read(f)).not.toMatch(/from '\\.\\.\\/legacy'/);",
    ].join('\n');
    expect(analyze(listing).repoTextAsserts).toBe(1);
    const variable = [
      "const design = await readFile(designPath, 'utf8');",
      "const page = await readFile('src/routes/+page.svelte', 'utf8');",
      "expect(design).toContain('All form controls have labels');",
      'expect(page).toContain(\'label="Search"\');',
    ].join('\n');
    expect(analyze(`${variable}\n// see DESIGN.md`).repoTextAsserts).toBe(2);
    const tmp = [
      "const dir = mkdtempSync('x');",
      "writeFileSync(join(dir, 'out.ts'), 'export {}');",
      "expect(readFileSync(join(dir, 'out.ts'), 'utf8')).toContain('export');",
    ].join('\n');
    expect(analyze(tmp).repoTextAsserts).toBe(0);
  });

  it('detects git history and python dependencies', () => {
    const s = analyze(
      [
        "execFileSync('git', ['log', '--oneline']);",
        "expect(diff).not.toContain('origin/main');",
        "spawnSync('uv', ['run', 'script.py']);",
      ].join('\n'),
    );
    expect(s.gitShellouts).toBeGreaterThanOrEqual(2);
    expect(s.pythonShellouts).toBeGreaterThanOrEqual(1);
  });

  it('detects transcription: digests, count pins, large literals, deleted-file asserts', () => {
    const digest = 'a'.repeat(64);
    const s = analyze(
      [
        `expect(hash).toBe('sha256:${digest}');`,
        `expect(other).toBe('${digest}');`,
        'expect(items).toHaveLength(12);',
        'expect(items).toHaveLength(2);',
        'expect(result).toEqual({',
        '  a: 1,',
        '});',
        "expect(existsSync('old.ts')).toBe(false);",
      ].join('\n'),
    );
    expect(s.digestPins).toBe(2);
    expect(s.countPins).toBe(1);
    expect(s.largeLiteralExpects).toBe(1);
    expect(s.deletedFileAsserts).toBe(1);
  });

  it('marks data subjects by config path or a source with no real functions', () => {
    expect(analyze('', 'src/config/layers.test.ts').dataSubject).toBe(true);
    expect(analyze("import cases from './cases.json';").dataSubject).toBe(false);
    expect(
      analyze('', 'src/thing.test.ts', 'export const A = 1;\nexport const B = 2;').dataSubject,
    ).toBe(true);
    const oneFn = 'export function atomicWrite(p: string) {\n  return p;\n}\n';
    expect(analyze('', 'src/thing.test.ts', oneFn).dataSubject).toBe(false);
    const bigTable = `export const rows = [\n${'  { a: 1 },\n'.repeat(90)}];\nexport const pick = (i: number) => rows[i];\n`;
    expect(analyze('', 'src/thing.test.ts', bigTable).dataSubject).toBe(true);
    const methods =
      'class S {\n  get(id: string) {\n    return id;\n  }\n  async put(id: string): Promise<void> {\n  }\n  static make() {\n  }\n}\n';
    expect(countFunctions(methods)).toBe(3);
    expect(analyze('', 'src/thing.test.ts', methods).dataSubject).toBe(false);
  });

  it('measures multi-line literal expectations in lines, not just count', () => {
    const text = [
      "it('a', () => {",
      '  expect(out).toEqual({',
      '    a: 1,',
      '    b: [',
      '      2,',
      '    ],',
      '  });',
      '  expect(x).toBe(1);',
      '  assert.deepStrictEqual(y, [',
      '    1,',
      '  ]);',
      '});',
    ].join('\n');
    expect(measureLiteralBlocks(text.split('\n'))).toEqual({ blocks: 2, lines: 9 });
    const nested = [
      'expect(a).toEqual({',
      '  b: 1,',
      '  c: expect.objectContaining({',
      '    d: 2,',
      '  }),',
      '});',
      'expect(z).toEqual([',
      '  1,',
    ].join('\n');
    const measured = measureLiteralBlocks(nested.split('\n'));
    expect(measured.blocks).toBe(2);
    expect(measured.lines).toBeLessThanOrEqual(nested.split('\n').length);
    const s = analyze(text);
    expect(s.largeLiteralExpects).toBe(2);
    expect(s.literalLines).toBe(9);
  });

  it('understands node:test assert as assertions', () => {
    const text = [
      'assert.equal(a, 1);',
      'assert.deepEqual(b, { x: 1 });',
      'assert.ok(c);',
      'assert(d);',
      "assert.strictEqual(e, 'x');",
    ].join('\n');
    const s = analyze(text);
    expect(s.expects).toBe(5);
    expect(s.weakExpects).toBe(2);
    expect(s.literalExpects).toBe(3);
  });

  it('understands ava, tap, and chai assertions', () => {
    const ava = [
      "test('x', (t) => {",
      '  t.is(add(1, 2), 3);',
      "  t.deepEqual(parse('a'), { a: 1 });",
      '  t.truthy(result);',
      '  t.true(ok);',
      '  t.throws(() => bad());',
      '});',
    ].join('\n');
    let s = analyze(ava);
    expect(s.expects).toBe(5);
    expect(s.weakExpects).toBe(2);
    expect(s.literalExpects).toBe(2);
    const tap = [
      't.equal(res.statusCode, 200);',
      't.ok(body);',
      't.same(body, {',
      '  a: 1,',
      '});',
    ].join('\n');
    s = analyze(tap);
    expect(s.expects).toBe(3);
    expect(s.weakExpects).toBe(1);
    expect(s.largeLiteralExpects).toBe(1);
    const chai = [
      'expect(x).to.equal(1);',
      'expect(y).to.deep.equal({ a: 1 });',
      'expect(z).to.exist;',
      'expect(w).to.be.ok;',
      'expect(list).to.have.length(3);',
    ].join('\n');
    s = analyze(chai);
    expect(s.expects).toBe(5);
    expect(s.weakExpects).toBe(2);
    expect(s.literalExpects).toBe(3);
  });

  it('counts snapshots, focused tests, real waits, and machine paths', () => {
    const s = analyze(
      [
        "it.only('x', () => {});",
        'expect(a).toMatchSnapshot();',
        'expect(b).toMatchInlineSnapshot(`1`);',
        'await new Promise((r) => setTimeout(r, 50));',
        'await sleep(100);',
        'const home = homedir();',
        "const p = '/Users/someone/data.json';",
        'const h2 = process.env.HOME;',
      ].join('\n'),
    );
    expect(s.focused).toBe(1);
    expect(s.snapshotAsserts).toBe(1);
    expect(s.inlineSnapshots).toBe(1);
    expect(s.realWaits).toBe(2);
    expect(s.machinePaths).toBe(2);
    const overridden = analyze("const home = homedir();\nvi.stubEnv('HOME', dir);");
    expect(overridden.machinePaths).toBe(0);
    expect(analyze("env: { HOME: '/Users/example' }").machinePaths).toBe(0);
    const faked = analyze('vi.useFakeTimers();\nawait new Promise((r) => setTimeout(r, 50));');
    expect(faked.realWaits).toBe(0);
  });

  it('only counts python when it is actually spawned', () => {
    const fixture = "await fs.writeFile(path.join(dir, 'render_scene.py'), 'print(1)');";
    expect(analyze(fixture).pythonShellouts).toBe(0);
    expect(analyze("spawnSync('uv', ['run', 'x.py']);").pythonShellouts).toBe(1);
    expect(analyze("command: 'python3',").pythonShellouts).toBe(1);
  });

  it('a fake with a readFile method is not a repo read', () => {
    const s = analyze(
      [
        "const sandbox = { readFile: vi.fn().mockResolvedValue('x') };",
        'expect(sandbox.readFile).toHaveBeenCalledTimes(2);',
        "expect(out).toContain('main.ts');",
      ].join('\n'),
    );
    expect(s.repoTextAsserts).toBe(0);
    expect(s.sourceTextAsserts).toBe(0);
  });

  it('markup in rendered output is not a source-text assertion', () => {
    const s = analyze(
      "expect(body).toContain('<loc>https://x.com/</loc>');\nexpect(html).toContain('<p>hi</p>');",
    );
    expect(s.sourceTextAsserts).toBe(0);
  });

  it('passes churn and timing through and counts lines', () => {
    const s = analyzeTest({
      file: 'x.test.ts',
      text: 'a\nb\nc',
      source: 'x.ts',
      sourceText: '1\n2',
      churn: { testCommits: 4, sourceCommits: 9, coChangeCommits: 3 },
      timing: { durationMs: 1500, failed: true },
    });
    expect(s.lines).toBe(3);
    expect(s.sourceLines).toBe(2);
    expect(s.coChangeCommits).toBe(3);
    expect(s.durationMs).toBe(1500);
    expect(s.failed).toBe(true);
  });
});
