// Join Stryker's mutation.json (perTest coverage) with useless-tests output.
// Per test file: mutants it covers, mutants it kills, kill rate; plus unique kills.
import { readFileSync } from 'node:fs';
const [,, reportPath, scoresPath, rootArg] = process.argv;
const root = (rootArg ?? '').replace(/\/$/, '') + '/';
const rel = (f) => (root !== '/' && f.startsWith(root) ? f.slice(root.length) : f).replace(/^\.\//, '');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const scores = new Map(JSON.parse(readFileSync(scoresPath, 'utf8')).map((r) => [r.file, r]));
const testFileById = new Map();
for (const [file, info] of Object.entries(report.testFiles ?? {})) {
  for (const t of info.tests ?? []) testFileById.set(t.id, rel(file));
}
const per = new Map(); // testFile -> {covered:Set, killed:Set, unique:Set, ownCovered:Set, ownKilled:Set}
const get = (f) => { if (!per.has(f)) per.set(f, { covered: new Set(), killed: new Set(), unique: new Set(), ownCovered: new Set(), ownKilled: new Set() }); return per.get(f); };
const siblingOf = (testFile) => testFile.replace(/\.(test|spec)\.(tsx?)$/, '.$2');
let totalMutants = 0, killedTotal = 0, survivedCovered = 0, noCoverage = 0;
for (const [file, info] of Object.entries(report.files)) {
  for (const m of info.mutants) {
    totalMutants++;
    const id = `${file}#${m.id}`;
    const coveredFiles = new Set((m.coveredBy ?? []).map((t) => testFileById.get(t)).filter(Boolean));
    const killerFiles = new Set((m.killedBy ?? []).map((t) => testFileById.get(t)).filter(Boolean));
    if (m.status === 'Killed') killedTotal++;
    else if (m.status === 'Survived') { if (coveredFiles.size) survivedCovered++; }
    else if (m.status === 'NoCoverage') noCoverage++;
    const srcFile = rel(file);
    for (const f of coveredFiles) { get(f).covered.add(id); if (siblingOf(f) === srcFile || siblingOf(f).replace(/\.tsx$/, '.ts') === srcFile) get(f).ownCovered.add(id); }
    for (const f of killerFiles) { get(f).killed.add(id); if (siblingOf(f) === srcFile || siblingOf(f).replace(/\.tsx$/, '.ts') === srcFile) get(f).ownKilled.add(id); }
    if (killerFiles.size === 1) get([...killerFiles][0]).unique.add(id);
  }
}
console.log(`mutants ${totalMutants} · killed ${killedTotal} · survived-but-covered ${survivedCovered} · no coverage ${noCoverage}`);
const rows = [];
for (const [file, s] of per) {
  const sc = scores.get(file);
  if (!sc) { console.error('no score for', file); continue; }
  const covered = s.covered.size, killed = s.killed.size;
  const ownCovered = s.ownCovered.size, ownKilled = s.ownKilled.size;
  rows.push({ file, covered, killed, unique: s.unique.size, killRate: covered ? killed / covered : null, ownCovered, ownKilled, ownRate: ownCovered ? ownKilled / ownCovered : null, score: sc.score, verdict: sc.verdict, weak: sc.expects ? sc.weakExpects / sc.expects : 0, tests: sc.tests, expects: sc.expects, components: sc.components });
}
rows.sort((a, b) => b.score - a.score);
console.log('\n score  verdict            covered killed  kill%  | own-cov own-kill own%  weak%  file');
for (const r of rows) console.log(` ${String(r.score).padStart(5)}  ${r.verdict.padEnd(18)} ${String(r.covered).padStart(6)} ${String(r.killed).padStart(6)}  ${r.killRate === null ? '   -' : String(Math.round(r.killRate * 100)).padStart(4)}  | ${String(r.ownCovered).padStart(6)} ${String(r.ownKilled).padStart(7)} ${r.ownRate === null ? '   -' : String(Math.round(r.ownRate * 100)).padStart(4)}   ${String(Math.round(r.weak * 100)).padStart(4)}   ${r.file}`);
const rank = (a) => { const s = a.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = []; s.forEach(([, i], k) => (r[i] = k)); return r; };
const rho = (a, b) => { const A = rank(a), B = rank(b), n = a.length; const d2 = A.reduce((acc, x, i) => acc + (x - B[i]) ** 2, 0); return 1 - (6 * d2) / (n * (n * n - 1)); };
const own = rows.filter((r) => r.ownRate !== null && r.ownCovered >= 10);
console.log(`\nfiles with >=10 own-source mutants covered: ${own.length}`);
console.log(`Spearman(uselessness score, own-source survival): ${rho(own.map((r) => r.score), own.map((r) => 1 - r.ownRate)).toFixed(2)}`);
for (const c of ['tautology', 'weak', 'mockBurden', 'cost', 'mirror']) console.log(`Spearman(${c}, own-source survival): ${rho(own.map((r) => r.components[c]), own.map((r) => 1 - r.ownRate)).toFixed(2)}`);
const usable = rows.filter((r) => r.killRate !== null && r.covered >= 10);
console.log(`\nfiles with >=10 covered mutants: ${usable.length}`);
console.log(`Spearman(uselessness score, survival rate = 1 - kill%): ${rho(usable.map((r) => r.score), usable.map((r) => 1 - r.killRate)).toFixed(2)}`);
console.log(`Spearman(weak share, survival rate): ${rho(usable.map((r) => r.weak), usable.map((r) => 1 - r.killRate)).toFixed(2)}`);
for (const c of ['tautology', 'weak', 'mockBurden', 'cost', 'mirror']) console.log(`Spearman(${c}, survival): ${rho(usable.map((r) => r.components[c]), usable.map((r) => 1 - r.killRate)).toFixed(2)}`);
const byVerdict = {};
for (const r of usable) { (byVerdict[r.verdict] ??= []).push(r.killRate); }
for (const [v, rates] of Object.entries(byVerdict)) console.log(`mean kill% for ${v}: ${Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100)} (n=${rates.length})`);
const top = usable.slice(0, Math.max(3, Math.floor(usable.length * 0.2))), bottom = usable.slice(-Math.max(3, Math.floor(usable.length * 0.2)));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log(`mean kill% top-20% by score: ${Math.round(mean(top.map((r) => r.killRate)) * 100)} · bottom-20%: ${Math.round(mean(bottom.map((r) => r.killRate)) * 100)}`);

if (process.env.JOIN_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.JOIN_OUT, JSON.stringify(rows, null, 1));
}
