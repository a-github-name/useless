import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const result = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
  encoding: 'utf8',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || result.stdout);

const output = JSON.parse(result.stdout);
const pack = Array.isArray(output) ? output[0] : output['useless-tests'];
if (!pack?.files) throw new Error('npm pack returned no file inventory');
const files = pack.files.map((entry) => entry.path);
const required = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'dist/cli.js',
  'dist/index.js',
  'grammars/tree-sitter-typescript.wasm',
  'grammars/tree-sitter-tsx.wasm',
  'skills/useless-tests/SKILL.md',
];
for (const file of required) {
  if (!files.includes(file)) throw new Error(`package is missing ${file}`);
}

for (const file of files) {
  const allowed = required.includes(file) || /^dist\/[^/]+\.(js|d\.ts)$/.test(file);
  if (!allowed) throw new Error(`unexpected package file: ${file}`);
  if (/\.(js|d\.ts|md|json)$/.test(file)) {
    const body = readFileSync(join(process.cwd(), file), 'utf8');
    if (/\/Users\/nerd\/|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(body)) {
      throw new Error(`package contains local path or private key material: ${file}`);
    }
  }
}

process.stdout.write(`Package content check passed (${files.length} files).\n`);
