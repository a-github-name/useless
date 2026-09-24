export {
  collectRepo,
  findDuplicates,
  findSharedBlocks,
  findSimilar,
  listTestFiles,
  parseTimings,
  parseXunitTimings,
  resolveModuleText,
  siblingSource,
} from './repo.js';
export type { CollectOptions } from './repo.js';
export { flattenUnits, markdownTable, summarize, summaryLines, unitTable } from './report.js';
export type { Summary, UnitRow } from './report.js';
export { FINDING_GUIDANCE, FINDING_ORDER, WEIGHTS, score } from './score.js';
export { joinMutation, loadMutationReport, reduceReport, spearman } from './mutation.js';
export { readFiles } from './read.js';
export { runBench } from './bench.js';
export { astReady, extractFacts, initAst } from './ast.js';
export type { Assertion, Facts, ReadCall, Unit } from './ast.js';
export { analyzeTest, analyzeUnits, countFunctions, measureLiteralBlocks } from './signals.js';
export {
  analyzeSwiftTest,
  classifySwiftGates,
  countSwiftFunctions,
  measureSwiftLiteralBlocks,
} from './swift.js';
export type { AnalyzeInput } from './signals.js';
export type {
  Churn,
  Finding,
  Scored,
  ScoredUnit,
  SignalName,
  Signals,
  Timing,
  UnitSignals,
  Verdict,
} from './types.js';

import { collectRepo } from './repo.js';
import type { CollectOptions } from './repo.js';
import { score } from './score.js';
import type { Scored } from './types.js';

/** Collect, score, and rank every test file in a repo (most useless first). */
export async function rank(options: CollectOptions): Promise<Scored[]> {
  return (await collectRepo(options))
    .map(score)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
