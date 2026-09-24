import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr}${result.stdout}`);
  }
  return result.stdout.trim();
}

const root = process.cwd();
const temp = mkdtempSync(join(tmpdir(), 'useless-pack-'));
try {
  const tarball =
    process.argv[2] === '--tarball' && process.argv[3]
      ? resolve(process.argv[3])
      : join(
          temp,
          run('npm', ['pack', '--ignore-scripts', '--pack-destination', temp, '--silent'], root),
        );
  const prefix = join(temp, 'install');
  run(
    'npm',
    ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    root,
  );

  const fixture = join(temp, 'fixture');
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(
    join(fixture, 'src/math.ts'),
    'export const add = (a: number, b: number) => a + b;\n',
  );
  writeFileSync(
    join(fixture, 'src/math.test.ts'),
    "import { expect, test } from 'vitest';\nimport { add } from './math';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n",
  );
  mkdirSync(join(fixture, 'scripts'), { recursive: true });
  writeFileSync(
    join(fixture, 'scripts/verify-result.mjs'),
    "import assert from 'node:assert/strict';\nassert.equal(3, 3);\n",
  );
  run('git', ['init', '-q'], fixture);
  run('git', ['add', '.'], fixture);
  run(
    'git',
    [
      '-c',
      'user.name=PackSmoke',
      '-c',
      'user.email=pack@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    fixture,
  );

  const bin = join(prefix, 'node_modules/.bin/useless');
  const scan = JSON.parse(run(bin, ['--root', fixture, '--format', 'json'], fixture));
  if (scan.rows?.length !== 1 || scan.rows[0]?.file !== 'src/math.test.ts') {
    throw new Error('installed CLI did not scan the fixture');
  }
  const scripts = JSON.parse(
    run(
      bin,
      ['--root', fixture, '--standalone', '--pattern', 'scripts/verify-*.mjs', '--format', 'json'],
      fixture,
    ),
  );
  if (
    scripts.rows?.length !== 1 ||
    !scripts.rows[0]?.standalone ||
    scripts.rows[0]?.expects !== 1
  ) {
    throw new Error('installed CLI did not score the standalone verifier');
  }
  const junit = join(temp, 'node-junit.xml');
  writeFileSync(
    junit,
    `<testsuites><testcase name="adds" classname="test" file="${join(fixture, 'src/math.test.ts')}" time="20"/></testsuites>`,
  );
  const timed = JSON.parse(
    run(bin, ['--root', fixture, '--timings', junit, '--format', 'json'], fixture),
  );
  if (timed.rows?.[0]?.durationMs !== 20_000) {
    throw new Error('installed CLI did not join Node JUnit case time');
  }
  const modulePath = join(prefix, 'node_modules/useless-tests/dist/index.js');
  const library = await import(pathToFileURL(modulePath).href);
  for (const name of [
    'joinMutation',
    'parseNodeJunitTimings',
    'readFiles',
    'runBench',
    'spearman',
  ]) {
    if (typeof library[name] !== 'function') throw new Error(`package root is missing ${name}`);
  }
  const rows = await library.rank({ root: fixture });
  if (rows.length !== 1 || rows[0]?.file !== 'src/math.test.ts' || rows[0].units.length !== 1) {
    throw new Error('installed library or packaged grammars did not scan the fixture');
  }
  process.stdout.write(
    `Packed CLI and library smoke passed (${readFileSync(tarball).length} bytes).\n`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
